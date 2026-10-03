import {
	formatFrequencyPattern,
	resolveFrequency,
	type FrequencyContext,
	type SpokenUpdate
} from '../dsl';
import { formatMhz } from './format';

/** The QSO currently being filled in by voice. */
export interface DraftQso {
	callsign?: string;
	rstSent: string;
	rstReceived: string;
	frequencyHz?: number;
	mode?: string;
	jcx?: string;
	qslRequested: boolean;
	/** When the first field of this QSO was entered (ISO 8601, UTC). */
	startedAt?: string;
}

/** Creates an empty draft. Frequency and mode are carried over between QSOs. */
export function newDraft(carry: Pick<DraftQso, 'frequencyHz' | 'mode'> = {}): DraftQso {
	return {
		rstSent: '59',
		rstReceived: '59',
		qslRequested: false,
		frequencyHz: carry.frequencyHz,
		mode: carry.mode
	};
}

/** True if nothing QSO-specific has been entered yet. */
export function isPristine(draft: DraftQso): boolean {
	return draft.startedAt === undefined;
}

/** Human-readable description of what an update did, for the feedback line. */
export function describeUpdate(update: SpokenUpdate, after: DraftQso): string {
	switch (update.kind) {
		case 'callsign':
			return `Callsign → ${update.value}`;
		case 'rstSent':
			return `RST sent → ${update.value}`;
		case 'rstReceived':
			return `RST received → ${update.value}`;
		case 'frequency':
			return `Frequency ${formatFrequencyPattern(update.value)} → ${formatMhz(after.frequencyHz!)} MHz`;
		case 'jcx':
			return `JCX → ${update.value}`;
		case 'qslRequested':
			return update.value ? 'QSL requested' : 'QSL not requested';
		case 'mode':
			return `Mode → ${update.value}`;
	}
}

/**
 * Applies one spoken update. Speaking a field again overwrites the whole field; there is no
 * partial correction.
 */
export function applyUpdate(
	draft: DraftQso,
	update: SpokenUpdate,
	frequency: FrequencyContext,
	now: Date = new Date()
): DraftQso {
	const next: DraftQso = { ...draft, startedAt: draft.startedAt ?? now.toISOString() };
	switch (update.kind) {
		case 'callsign':
			next.callsign = update.value;
			break;
		case 'rstSent':
			next.rstSent = update.value;
			break;
		case 'rstReceived':
			next.rstReceived = update.value;
			break;
		case 'frequency':
			next.frequencyHz = resolveFrequency(update.value, frequency);
			break;
		case 'jcx':
			next.jcx = update.value;
			break;
		case 'qslRequested':
			next.qslRequested = update.value;
			break;
		case 'mode':
			next.mode = update.value;
			break;
	}
	return next;
}

/** Applies all updates of one utterance in order. */
export function applyUpdates(
	draft: DraftQso,
	updates: readonly SpokenUpdate[],
	frequency: FrequencyContext,
	now: Date = new Date()
): { draft: DraftQso; descriptions: string[] } {
	let current = draft;
	const descriptions: string[] = [];
	for (const update of updates) {
		current = applyUpdate(current, update, frequency, now);
		descriptions.push(describeUpdate(update, current));
	}
	return { draft: current, descriptions };
}
