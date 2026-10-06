import { goto } from '$app/navigation';
import { asset } from '$app/paths';
import { ApiError, ServerApi, type Me } from '../account/api';
import { formatSpeech, formatTokens, parseSpeech, type SpeechLanguage } from '../dsl';
import {
	adifFile,
	applyStation,
	applyUpdates,
	defaultSession,
	finalizeDraft,
	isPristine,
	newDraft,
	stationToApply,
	type DraftQso,
	type OperatingSession,
	type QsoRecord,
	type StationList
} from '../qso';
import { AudioCapture, VoskRecognizer, type SpeechRecognizer } from '../speech';
import { KeyValueStore, QsoStore, openDatabase } from '../storage/db';
import { syncAll, type SyncReport } from '../sync/client';
import { sleep, withTimeout } from '../util/timeout';
import { DEFAULT_MODEL_PATHS, mergeSettings, type AppSettings } from './settings';

export type PttState = 'idle' | 'opening' | 'listening' | 'finishing';
/** `unavailable`: no answer from the server (offline, or the app is served without it). */
export type AccountState = 'unknown' | 'signedIn' | 'signedOut' | 'unavailable';
export type AsrState = 'unloaded' | 'loading' | 'ready' | 'error';

export interface Feedback {
	kind: 'ok' | 'error' | 'info';
	/** What the ASR heard (or what was typed), as display labels. */
	heard?: string;
	message: string;
}

export interface Utterance {
	at: string;
	source: 'voice' | 'typed';
	text: string;
	heard: string;
	ok: boolean;
	message: string;
}

const FINAL_RESULT_TIMEOUT_MS = 10_000;
const MAX_UTTERANCES = 30;

function vibrate(pattern: number | number[]) {
	try {
		navigator.vibrate?.(pattern);
	} catch {
		// unsupported (e.g. iOS)
	}
}

function bootstrapTokenIn(hash: string): string | null {
	return new URLSearchParams(hash.slice(1)).get('bootstrap');
}

function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** Application state and the PTT → ASR → parser → draft → log pipeline. */
export class QsoApp {
	session = $state<OperatingSession>(defaultSession());
	settings = $state<AppSettings>(mergeSettings(undefined));
	draft = $state<DraftQso>(newDraft());
	log = $state<QsoRecord[]>([]);

	ptt = $state<PttState>('idle');
	asr = $state<AsrState>('unloaded');
	asrError = $state<string | null>(null);
	partial = $state('');
	level = $state(0);
	feedback = $state<Feedback | null>(null);
	utterances = $state<Utterance[]>([]);

	online = $state(true);
	syncing = $state(false);
	lastSync = $state<SyncReport | null>(null);
	ready = $state(false);

	readonly api = new ServerApi();
	account = $state<AccountState>('unknown');
	/** The signed-in user; kept on the device so that the app works offline. */
	user = $state<Me | null>(null);
	stations = $state<StationList>({ default_station_id: null, stations: [] });
	/** Token of a passkey bootstrap link (`#bootstrap=…`) the app was opened with. */
	bootstrapToken = $state<string | null>(null);

	#qsos: QsoStore | null = null;
	#kv: KeyValueStore | null = null;
	#capture = new AudioCapture();
	#recognizer: SpeechRecognizer | null = null;
	#releaseRequested = false;
	/** Whether the microphone has been opened by a press (so reopening it will not surprise). */
	#microphoneUsed = false;
	#syncRequested = false;
	#wakeLock: WakeLockSentinel | null = null;

	get unsyncedCount(): number {
		return this.log.filter((r) => r.syncState !== 'synced').length;
	}

	/** QSOs are synced while a user is signed in (or was, when last online). */
	get syncConfigured(): boolean {
		return this.user !== null;
	}

	defaultModelUrl(language: SpeechLanguage): string {
		// The model is fetched at deploy time, so it is not part of the typed static assets.
		const path = asset(DEFAULT_MODEL_PATHS[language] as Parameters<typeof asset>[0]);
		return new URL(path, location.href).href;
	}

	async init() {
		const db = await openDatabase();
		this.#qsos = new QsoStore(db);
		this.#kv = new KeyValueStore(db);
		// `stationProfileId` was the Wavelog station before stations came from the server.
		const { stationProfileId: _, ...session } =
			(await this.#kv.get<OperatingSession & { stationProfileId?: string }>('session')) ?? {};
		this.session = { ...defaultSession(), ...session };
		this.settings = mergeSettings(await this.#kv.get<Partial<AppSettings>>('settings'));
		this.user = (await this.#kv.get<Me>('user')) ?? null;
		this.stations = (await this.#kv.get<StationList>('stations')) ?? this.stations;
		this.bootstrapToken = bootstrapTokenIn(location.hash);
		this.draft =
			(await this.#kv.get<DraftQso>('draft')) ?? newDraft({ mode: this.session.defaultMode });
		this.log = await this.#qsos.list();
		this.online = navigator.onLine;

		this.#capture.onAudio = (samples) => this.#recognizer?.pushAudio(samples);
		this.#capture.onLevel = (level) => (this.level = level);

		window.addEventListener('online', () => {
			this.online = true;
			void this.sync();
		});
		window.addEventListener('offline', () => (this.online = false));
		// A setup link opened in a tab that already shows the app only changes the hash.
		window.addEventListener('hashchange', () => {
			this.bootstrapToken = bootstrapTokenIn(location.hash) ?? this.bootstrapToken;
		});
		document.addEventListener('visibilitychange', () => this.#onVisibilityChange());

		this.ready = true;
		if (this.settings.autoLoadAsr) void this.loadAsr();
		void this.refreshAccount();
		void this.#requestMicrophonePermission();
	}

	// ---------------------------------------------------------------- account

	/** Asks the server who is signed in, then syncs. Offline, the remembered user is kept. */
	async refreshAccount() {
		try {
			await this.#signedIn(await this.api.me());
		} catch (e) {
			if (e instanceof ApiError && e.unauthorized) {
				await this.#signedOut();
			} else {
				this.account = this.user === null ? 'unavailable' : 'signedIn';
			}
		}
	}

	async signIn() {
		await this.#signedIn(await this.api.signIn());
	}

	/** Registers the first passkey through a bootstrap link and signs in. */
	async completeBootstrap(user: Me) {
		await this.cancelBootstrap();
		await this.#signedIn(user);
	}

	/** Leaves the setup screen, and drops the used token from the address bar and history. */
	async cancelBootstrap() {
		this.bootstrapToken = null;
		await goto(location.pathname + location.search, { replace: true, shallow: true });
	}

	async signOut() {
		await this.api.logout();
		await this.#signedOut();
	}

	async #signedIn(user: Me) {
		this.user = user;
		this.account = 'signedIn';
		await this.#kv?.set('user', user);
		await this.loadStations().catch(() => {});
		void this.sync();
	}

	async #signedOut() {
		this.user = null;
		this.account = 'signedOut';
		this.stations = { default_station_id: null, stations: [] };
		await this.#kv?.set('user', null);
		await this.#kv?.set('stations', this.stations);
	}

	/** Fetches the user's stations; the session switches to the default if it has none. */
	async loadStations() {
		await this.setStations(await this.api.stations());
	}

	async setStations(list: StationList) {
		this.stations = list;
		await this.#kv?.set('stations', list);
		const station = stationToApply(this.session, list);
		if (station !== undefined) await this.saveSession(applyStation(this.session, station));
	}

	/**
	 * Asks for the microphone as soon as the app opens, so the first PTT press is not interrupted
	 * by the permission prompt. Skipped when the answer is already known.
	 */
	async #requestMicrophonePermission() {
		try {
			const status = await navigator.permissions.query({
				name: 'microphone' as PermissionName
			});
			if (status.state !== 'prompt') return;
		} catch {
			// No Permissions API answer for the microphone (Safari); asking is the only way.
		}
		try {
			await this.#capture.requestPermission();
		} catch {
			// Denied or dismissed; the next press asks again and reports the error.
		}
	}

	// ---------------------------------------------------------------- speech engine

	async loadAsr() {
		if (this.asr === 'loading') return;
		this.#recognizer?.dispose();
		this.#recognizer = null;
		this.asr = 'loading';
		this.asrError = null;
		try {
			const recognizer: SpeechRecognizer = new VoskRecognizer({
				modelUrl:
					this.settings.voskModelUrl.trim() !== ''
						? new URL(this.settings.voskModelUrl.trim(), location.href).href
						: this.defaultModelUrl(this.settings.voskLanguage),
				language: this.settings.voskLanguage
			});
			recognizer.onPartial = (text) => (this.partial = formatSpeech(text));
			await recognizer.initialize();
			this.#recognizer = recognizer;
			this.asr = 'ready';
			if (!this.settings.autoLoadAsr) {
				this.settings.autoLoadAsr = true;
				await this.#saveSettings();
			}
		} catch (e) {
			this.asr = 'error';
			this.asrError = errorMessage(e);
		}
	}

	/** Uses an already initialized recognizer (custom engines, tests). */
	useRecognizer(recognizer: SpeechRecognizer) {
		this.#recognizer?.dispose();
		recognizer.onPartial = (text) => (this.partial = formatSpeech(text));
		this.#recognizer = recognizer;
		this.asr = 'ready';
		this.asrError = null;
	}

	// ---------------------------------------------------------------- PTT

	async pttPress() {
		if (this.ptt !== 'idle') return;
		const recognizer = this.#recognizer;
		if (recognizer === null || this.asr !== 'ready') {
			this.feedback = { kind: 'error', message: 'Speech engine is not loaded' };
			return;
		}
		this.ptt = 'opening';
		this.#releaseRequested = false;
		this.partial = '';
		void this.#requestWakeLock();
		try {
			if (recognizer.needsAudio) await this.#capture.open();
		} catch (e) {
			this.ptt = 'idle';
			this.feedback = { kind: 'error', message: `Microphone: ${errorMessage(e)}` };
			// A half-open or stuck context would fail the same way on every press; start over.
			void this.#capture.close();
			return;
		}
		this.#microphoneUsed = true;
		if (this.#releaseRequested) {
			// Typically the first press, interrupted by the permission prompt.
			this.ptt = 'idle';
			this.feedback = {
				kind: 'info',
				message: 'Microphone ready. Hold the button while speaking.'
			};
			return;
		}
		try {
			recognizer.beginUtterance();
			if (recognizer.needsAudio) this.#capture.begin();
		} catch (e) {
			this.ptt = 'idle';
			this.feedback = { kind: 'error', message: errorMessage(e) };
			return;
		}
		this.ptt = 'listening';
		vibrate(15);
	}

	async pttRelease() {
		if (this.ptt === 'opening') {
			this.#releaseRequested = true;
			return;
		}
		if (this.ptt !== 'listening') return;
		const recognizer = this.#recognizer!;
		this.ptt = 'finishing';
		try {
			await sleep(this.settings.releaseTailMs);
			if (recognizer.needsAudio) await this.#capture.end();
			const result = await withTimeout(
				recognizer.endUtterance(),
				FINAL_RESULT_TIMEOUT_MS,
				'speech recognition timed out'
			);
			this.handleText(result.text, 'voice');
		} catch (e) {
			this.feedback = { kind: 'error', message: errorMessage(e) };
			vibrate([60, 60, 60]);
		} finally {
			this.ptt = 'idle';
			this.partial = '';
			this.level = 0;
		}
	}

	async pttCancel() {
		if (this.ptt === 'opening') {
			this.#releaseRequested = true;
			return;
		}
		if (this.ptt !== 'listening') return;
		const recognizer = this.#recognizer!;
		this.ptt = 'finishing';
		try {
			if (recognizer.needsAudio) await this.#capture.end();
			recognizer.cancelUtterance();
		} finally {
			this.ptt = 'idle';
			this.partial = '';
			this.level = 0;
			this.feedback = { kind: 'info', message: 'Cancelled' };
		}
	}

	// ---------------------------------------------------------------- DSL → draft

	/** Parses one utterance (spoken or typed) and applies it to the draft. */
	handleText(text: string, source: Utterance['source']) {
		const raw = text.trim();
		const parsed = parseSpeech(raw);
		const heard = formatTokens(parsed.tokens) || '(nothing)';
		let message: string;
		if (parsed.ok) {
			const { draft, descriptions } = applyUpdates(this.draft, parsed.updates, {
				anchorHz: this.session.frequencyAnchorHz,
				currentHz: this.draft.frequencyHz
			});
			this.draft = draft;
			void this.#saveDraft();
			message = descriptions.join(', ');
			this.feedback = { kind: 'ok', heard, message };
		} else {
			message = parsed.error;
			this.feedback = { kind: 'error', heard, message };
			vibrate([60, 60, 60]);
		}
		this.utterances = [
			{ at: new Date().toISOString(), source, text: raw, heard, ok: parsed.ok, message },
			...this.utterances
		].slice(0, MAX_UTTERANCES);
	}

	// ---------------------------------------------------------------- QSO log

	/** Starts a new QSO, carrying frequency and mode over. */
	async clearDraft() {
		this.draft = newDraft({ frequencyHz: this.draft.frequencyHz, mode: this.draft.mode });
		this.feedback = null;
		await this.#saveDraft();
	}

	setDraft(draft: DraftQso) {
		this.draft = draft;
		void this.#saveDraft();
	}

	async logQso(): Promise<boolean> {
		const result = finalizeDraft(this.draft, this.session, crypto.randomUUID());
		if (!result.ok) {
			this.feedback = { kind: 'error', message: result.problems.join(' / ') };
			vibrate([60, 60, 60]);
			return false;
		}
		await this.#qsos!.put(result.record);
		this.log = [result.record, ...this.log];
		this.draft = newDraft({ frequencyHz: result.record.frequencyHz, mode: result.record.mode });
		await this.#saveDraft();
		this.feedback = {
			kind: 'ok',
			message: `${result.record.callsign} logged locally${this.syncConfigured ? ', waiting for sync' : ''}`
		};
		vibrate(40);
		void this.sync();
		return true;
	}

	async deleteQso(id: string) {
		await this.#qsos!.delete(id);
		this.log = this.log.filter((r) => r.id !== id);
	}

	async sync(): Promise<void> {
		if (this.#qsos === null || !this.syncConfigured) return;
		// A QSO logged while a sync is running would otherwise wait for the next trigger.
		this.#syncRequested = true;
		if (this.syncing) return;
		this.syncing = true;
		try {
			while (this.#syncRequested) {
				this.#syncRequested = false;
				this.lastSync = await syncAll(this.#qsos, this.api);
				this.log = await this.#qsos.list();
				if (this.lastSync.unauthorized) await this.#signedOut();
			}
		} finally {
			this.syncing = false;
		}
	}

	exportAdif(): Blob {
		return new Blob([adifFile([...this.log].reverse())], { type: 'text/plain' });
	}

	// ---------------------------------------------------------------- persistence

	async saveSession(session: OperatingSession) {
		const modeChanged = session.defaultMode !== this.session.defaultMode;
		this.session = session;
		await this.#kv!.set('session', session);
		if (modeChanged && isPristine(this.draft)) {
			this.setDraft({ ...this.draft, mode: session.defaultMode });
		}
	}

	async saveSettings(settings: AppSettings) {
		const engineChanged =
			settings.voskLanguage !== this.settings.voskLanguage ||
			settings.voskModelUrl !== this.settings.voskModelUrl;
		this.settings = settings;
		await this.#saveSettings();
		if (engineChanged && this.asr !== 'unloaded') await this.loadAsr();
	}

	async #saveSettings() {
		await this.#kv?.set('settings', this.settings);
	}

	async #saveDraft() {
		await this.#kv?.set('draft', this.draft);
	}

	// ---------------------------------------------------------------- lifecycle

	async #requestWakeLock() {
		if (!this.settings.keepScreenOn || this.#wakeLock !== null || !('wakeLock' in navigator))
			return;
		try {
			this.#wakeLock = await navigator.wakeLock.request('screen');
			this.#wakeLock.addEventListener('release', () => (this.#wakeLock = null));
		} catch {
			// Not allowed (e.g. battery saver); not critical.
		}
	}

	#onVisibilityChange() {
		if (document.visibilityState === 'hidden') {
			// Release the microphone in the background; it is reopened on the next PTT press.
			// pttCancel also abandons a press that is still waiting for the permission prompt.
			void this.pttCancel();
			void this.#capture.close();
		} else {
			void this.sync();
			void this.#reopenMicrophone();
		}
	}

	/**
	 * Reopens the microphone when the app comes back to the foreground, so the next press does
	 * not spend a second or more in "opening" on a phone. Only when the browser will not prompt:
	 * without a Permissions API answer (Safari has none for the microphone) the press opens it.
	 */
	async #reopenMicrophone() {
		if (!this.#microphoneUsed || this.asr !== 'ready' || this.#recognizer?.needsAudio !== true)
			return;
		try {
			const status = await navigator.permissions.query({
				name: 'microphone' as PermissionName
			});
			if (status.state !== 'granted') return;
			await this.#capture.open();
		} catch {
			// Not supported, or the microphone is not available right now; the next press
			// tries again and reports the error.
		}
	}
}
