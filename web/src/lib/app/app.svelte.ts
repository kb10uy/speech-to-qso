import { goto } from '$app/navigation';
import { asset } from '$app/paths';
import { ApiError, ServerApi, type CallsignHistory, type Me } from '../account/api';
import {
	formatSpeech,
	formatTokens,
	parseSpeech,
	type SpeechLanguage,
	type SpokenUpdate
} from '../dsl';
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
import { DeviceStorage } from '../storage/accounts';
import type { KeyValueStore, QsoStore } from '../storage/db';
import { syncAll, type SyncReport } from '../sync/client';
import { sleep, withTimeout } from '../util/timeout';
import { DEFAULT_MODEL_PATHS, mergeSettings, type AppSettings } from './settings';

export type PttState = 'idle' | 'opening' | 'listening' | 'finishing';
/** `unavailable`: no answer from the server (offline, or the app is served without it). */
export type AccountState = 'unknown' | 'signedIn' | 'signedOut' | 'unavailable';
export type AsrState = 'unloaded' | 'loading' | 'ready' | 'error';

export interface Feedback {
	kind: 'ok' | 'error' | 'info';
	message: string;
}

/** What an utterance did to the draft: the fields it set, or none when it was rejected. */
export interface AppliedUtterance {
	source: 'voice' | 'typed';
	ok: boolean;
	fields: SpokenUpdate['kind'][];
}

export type HistoryLookup = { callsign: string } & (
	| { status: 'loading' }
	| { status: 'ready'; history: CallsignHistory }
	| { status: 'error'; message: string }
);

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
const FEEDBACK_MS = { ok: 3_000, info: 3_000, error: 6_000 };

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

	api = new ServerApi();
	account = $state<AccountState>('unknown');
	/** The signed-in user; kept on the device so that the app works offline. */
	user = $state<Me | null>(null);
	stations = $state<StationList>({ default_station_id: null, stations: [] });
	/** Token of a passkey bootstrap link (`#bootstrap=…`) the app was opened with. */
	bootstrapToken = $state<string | null>(null);
	localQsoCount = $state(0);
	/** Wavelog's past QSOs with the latest callsign looked up; null without Wavelog. */
	history = $state<HistoryLookup | null>(null);

	#qsos: QsoStore | null = null;
	#kv: KeyValueStore | null = null;
	#storage: DeviceStorage | null = null;
	#accountVersion = 0;
	#accountBusy = false;
	#capture = new AudioCapture();
	#recognizer: SpeechRecognizer | null = null;
	#releaseRequested = false;
	/** Whether the microphone has been opened by a press (so reopening it will not surprise). */
	#microphoneUsed = false;
	#syncRequested = false;
	#wakeLock: WakeLockSentinel | null = null;
	#historyRequest = 0;
	#feedbackTimer: ReturnType<typeof setTimeout> | undefined;
	#utteranceListeners = new Set<(utterance: AppliedUtterance) => void>();

	get unsyncedCount(): number {
		return this.log.filter((r) => r.syncState !== 'synced').length;
	}

	/** QSOs are synced while a user is signed in (or was, when last online). */
	get syncConfigured(): boolean {
		return this.user !== null;
	}

	#modelUrl(language: SpeechLanguage): string {
		// The model is fetched at deploy time, so it is not part of the typed static assets.
		const path = asset(DEFAULT_MODEL_PATHS[language] as Parameters<typeof asset>[0]);
		return new URL(path, location.href).href;
	}

	async init() {
		this.#storage = await DeviceStorage.open();
		const globals = this.#storage.globals;
		this.settings = mergeSettings(await globals.get<Partial<AppSettings>>('settings'));
		await this.#useAccount((await globals.get<Me>('user')) ?? null, this.#accountVersion);
		this.bootstrapToken = bootstrapTokenIn(location.hash);
		this.online = navigator.onLine;

		this.#capture.onAudio = (samples) => this.#recognizer?.pushAudio(samples);
		this.#capture.onLevel = (level) => (this.level = level);

		window.addEventListener('online', () => {
			this.online = true;
			void this.refreshAccount();
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
		if (this.#accountBusy) return;
		const version = this.#accountVersion;
		try {
			// /me identifies the cookie independently of this tab's remembered account.
			const user = await new ServerApi().me();
			if (version !== this.#accountVersion) return;
			await this.#signedIn(user, user.id === this.user?.id ? version : ++this.#accountVersion);
		} catch (e) {
			if (version !== this.#accountVersion) return;
			if (e instanceof ApiError && e.unauthorized) {
				await this.#signedOut(++this.#accountVersion);
			} else {
				this.account = this.user === null ? 'unavailable' : 'signedIn';
			}
		}
	}

	async signIn() {
		const version = ++this.#accountVersion;
		this.#accountBusy = true;
		try {
			await this.#signedIn(await this.api.signIn(), version);
		} finally {
			this.#accountBusy = false;
			if (version === this.#accountVersion) {
				this.ready = this.#qsos !== null;
				void this.sync();
			}
		}
	}

	/** Registers the first passkey through a bootstrap link and signs in. */
	async completeBootstrap(user: Me) {
		const version = ++this.#accountVersion;
		await this.cancelBootstrap();
		await this.#signedIn(user, version);
	}

	/** Leaves the setup screen, and drops the used token from the address bar and history. */
	async cancelBootstrap() {
		this.bootstrapToken = null;
		await goto(location.pathname + location.search, { replace: true, shallow: true });
	}

	async signOut() {
		const version = ++this.#accountVersion;
		this.#accountBusy = true;
		try {
			await this.api.logout();
			await this.#signedOut(version);
		} finally {
			this.#accountBusy = false;
			if (version === this.#accountVersion) this.ready = this.#qsos !== null;
		}
	}

	async #useAccount(user: Me | null, version: number): Promise<boolean> {
		const { qsos, kv } = await this.#storage!.forUser(user?.id ?? null);
		const [storedSession, draft, stations, log, local] = await Promise.all([
			kv.get<OperatingSession & { stationProfileId?: string }>('session'),
			kv.get<DraftQso>('draft'),
			kv.get<StationList>('stations'),
			qsos.list(),
			this.#storage!.local.qsos.list()
		]);
		if (version !== this.#accountVersion) return false;
		const { stationProfileId: _, ...session } = storedSession ?? {};
		this.#qsos = qsos;
		this.#kv = kv;
		this.user = user;
		this.api = user === null ? new ServerApi() : new ServerApi().forUser(user.id);
		this.session = { ...defaultSession(), ...session };
		this.draft = draft ?? newDraft({ mode: this.session.defaultMode });
		this.stations = stations ?? { default_station_id: null, stations: [] };
		this.log = log;
		this.localQsoCount = local.length;
		this.#notify(null);
		this.utterances = [];
		this.lastSync = null;
		this.history = null;
		this.#historyRequest += 1;
		return true;
	}

	async #signedIn(user: Me, version: number) {
		if (version !== this.#accountVersion) return;
		if (user.id !== this.user?.id) {
			this.ready = false;
			if (!(await this.#useAccount(user, version))) return;
		}
		this.ready = true;
		this.user = user;
		this.account = 'signedIn';
		await this.#storage!.globals.set('user', user);
		await this.loadStations().catch(() => {});
		if (version === this.#accountVersion) void this.sync();
	}

	async #signedOut(version: number) {
		if (version !== this.#accountVersion) return;
		if (this.user !== null) {
			this.ready = false;
			if (!(await this.#useAccount(null, version))) return;
		}
		this.account = 'signedOut';
		this.ready = true;
		await this.#storage!.globals.set('user', null);
	}

	/** Fetches the user's stations; the session switches to the default if it has none. */
	async loadStations() {
		const version = this.#accountVersion;
		const list = await this.api.stations();
		if (version === this.#accountVersion) await this.setStations(list, this.user?.id ?? null);
	}

	async importLocalQsos() {
		const user = this.user;
		if (user === null || this.#storage === null) return;
		const version = this.#accountVersion;
		await this.#storage.importLocal(user.id);
		if (version !== this.#accountVersion) return;
		this.localQsoCount = (await this.#storage.local.qsos.list()).length;
		this.log = await this.#qsos!.list();
		void this.sync();
	}

	async setStations(list: StationList, userId: string | null = this.user?.id ?? null) {
		if (userId !== (this.user?.id ?? null)) return;
		const version = this.#accountVersion;
		this.stations = list;
		await this.#kv?.set('stations', list);
		if (version !== this.#accountVersion) return;
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
				modelUrl: this.#modelUrl(this.settings.voskLanguage),
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
			this.#notify({ kind: 'error', message: 'Speech engine is not loaded' });
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
			this.#notify({ kind: 'error', message: `Microphone: ${errorMessage(e)}` });
			// A half-open or stuck context would fail the same way on every press; start over.
			void this.#capture.close();
			return;
		}
		this.#microphoneUsed = true;
		if (this.#releaseRequested) {
			// Typically the first press, interrupted by the permission prompt.
			this.ptt = 'idle';
			this.#notify({ kind: 'info', message: 'Microphone ready. Hold the button while speaking.' });
			return;
		}
		try {
			recognizer.beginUtterance();
			if (recognizer.needsAudio) this.#capture.begin();
		} catch (e) {
			this.ptt = 'idle';
			this.#notify({ kind: 'error', message: errorMessage(e) });
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
			this.#notify({ kind: 'error', message: errorMessage(e) });
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
			this.#notify({ kind: 'info', message: 'Cancelled' });
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
		} else {
			message = parsed.error;
			vibrate([60, 60, 60]);
		}
		const fields = parsed.ok ? parsed.updates.map((u) => u.kind) : [];
		for (const listener of this.#utteranceListeners) listener({ source, ok: parsed.ok, fields });
		this.utterances = [
			{ at: new Date().toISOString(), source, text: raw, heard, ok: parsed.ok, message },
			...this.utterances
		].slice(0, MAX_UTTERANCES);
	}

	/** Looks up a callsign in Wavelog, unless that is already done or under way. */
	async lookUpHistory(callsign: string) {
		if (this.history?.callsign === callsign && this.history.status !== 'error') return;
		const request = ++this.#historyRequest;
		this.history = { callsign, status: 'loading' };
		try {
			const history = await this.api.callsignHistory(callsign);
			if (request === this.#historyRequest) this.history = { callsign, status: 'ready', history };
		} catch (e) {
			if (request !== this.#historyRequest) return;
			const noWavelog = e instanceof ApiError && e.status === 409;
			this.history = noWavelog ? null : { callsign, status: 'error', message: errorMessage(e) };
		}
	}

	/** Calls `listener` after every utterance; returns a function that stops it. */
	onUtterance(listener: (utterance: AppliedUtterance) => void): () => void {
		this.#utteranceListeners.add(listener);
		return () => this.#utteranceListeners.delete(listener);
	}

	/** Shows a message for a few seconds, or hides the current one. */
	#notify(feedback: Feedback | null) {
		clearTimeout(this.#feedbackTimer);
		this.feedback = feedback;
		if (feedback === null) return;
		this.#feedbackTimer = setTimeout(() => (this.feedback = null), FEEDBACK_MS[feedback.kind]);
	}

	// ---------------------------------------------------------------- QSO log

	/** Starts a new QSO, carrying frequency and mode over. */
	async clearDraft() {
		this.draft = newDraft({ frequencyHz: this.draft.frequencyHz, mode: this.draft.mode });
		this.#notify(null);
		await this.#saveDraft();
	}

	setDraft(draft: DraftQso) {
		this.draft = draft;
		void this.#saveDraft();
	}

	async logQso(): Promise<boolean> {
		if (!this.ready || this.#accountBusy) return false;
		const version = this.#accountVersion;
		const qsos = this.#qsos!;
		const result = finalizeDraft(this.draft, this.session, crypto.randomUUID());
		if (!result.ok) {
			this.#notify({ kind: 'error', message: result.problems.join(' / ') });
			vibrate([60, 60, 60]);
			return false;
		}
		await qsos.put(result.record);
		if (version !== this.#accountVersion) return true;
		this.log = [result.record, ...this.log];
		if (this.user === null) this.localQsoCount = this.log.length;
		this.draft = newDraft({ frequencyHz: result.record.frequencyHz, mode: result.record.mode });
		await this.#saveDraft();
		if (version !== this.#accountVersion) return true;
		this.#notify({
			kind: 'ok',
			message: `${result.record.callsign} logged locally${this.syncConfigured ? ', waiting for sync' : ''}`
		});
		vibrate(40);
		void this.sync();
		return true;
	}

	async deleteQso(id: string) {
		const version = this.#accountVersion;
		await this.#qsos!.delete(id);
		if (version !== this.#accountVersion) return;
		this.log = this.log.filter((r) => r.id !== id);
		if (this.user === null) this.localQsoCount = this.log.length;
	}

	async sync(): Promise<void> {
		if (this.#qsos === null || this.account !== 'signedIn' || !this.online || !this.ready) return;
		// A QSO logged while a sync is running would otherwise wait for the next trigger.
		this.#syncRequested = true;
		if (this.syncing) return;
		this.syncing = true;
		try {
			while (this.#syncRequested) {
				this.#syncRequested = false;
				if (this.user === null || this.#accountBusy) break;
				const version = this.#accountVersion;
				const qsos = this.#qsos;
				const report = await syncAll(
					qsos,
					this.api,
					() => new Date(),
					() => version === this.#accountVersion && !this.#accountBusy
				);
				if (version !== this.#accountVersion) continue;
				this.lastSync = report;
				const log = await qsos.list();
				if (version !== this.#accountVersion) continue;
				this.log = log;
				if (report.unauthorized) await this.refreshAccount();
			}
		} finally {
			this.syncing = false;
		}
	}

	exportAdif(): Blob {
		return new Blob([adifFile([...this.log].reverse(), this.stations)], { type: 'text/plain' });
	}

	// ---------------------------------------------------------------- persistence

	async saveSession(session: OperatingSession) {
		const version = this.#accountVersion;
		const modeChanged = session.defaultMode !== this.session.defaultMode;
		this.session = session;
		await this.#kv!.set('session', session);
		if (version !== this.#accountVersion) return;
		if (modeChanged && isPristine(this.draft)) {
			this.setDraft({ ...this.draft, mode: session.defaultMode });
		}
	}

	async saveSettings(settings: AppSettings) {
		const engineChanged = settings.voskLanguage !== this.settings.voskLanguage;
		this.settings = settings;
		await this.#saveSettings();
		if (engineChanged && this.asr !== 'unloaded') await this.loadAsr();
	}

	async #saveSettings() {
		await this.#storage?.globals.set('settings', this.settings);
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
			void this.refreshAccount();
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
