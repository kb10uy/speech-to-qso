import {
    formatFrequencyPattern,
    resolveFrequency,
    type FrequencyContext,
    type QslStatus,
    type QsoMode,
    type SpokenUpdate
} from '../dsl';
import { formatMhz, formatMode } from './format';

/** The QSO currently being filled in by voice. */
export interface DraftQso {
    callsign?: string;
    rstSent: string;
    rstReceived: string;
    frequencyHz?: number;
    mode?: QsoMode;
    jcx?: string;
    qsl: QslStatus;
    name?: string;
    qth?: string;
    /** The other station's contest number, without the RST. */
    exchangeReceived?: string;
    /** When the first field of this QSO was entered (ISO 8601, UTC). */
    startedAt?: string;
}

export type FreeTextField = 'name' | 'qth';

export const FREE_TEXT_MAX_LENGTH = 100;

export function setFreeText(
    draft: DraftQso,
    field: FreeTextField,
    value: string,
    now: Date = new Date()
): DraftQso {
    const text = value.replace(/\s+/g, ' ').trim();
    const next: DraftQso = { ...draft, [field]: text === '' ? undefined : text };
    if (text !== '' && next.startedAt === undefined) next.startedAt = now.toISOString();
    return next;
}

const DEFAULT_RST = new Map([
    ['CW', '599'],
    ['RTTY', '599'],
    ['SSTV', '595'],
    ['FT8', '+00'],
    ['FT4', '+00'],
    ['JT65', '+00']
]);

/** The report a QSO starts with; voice and unknown modes get 59. */
export function defaultRst(mode: QsoMode | undefined): string {
    if (mode === undefined) return '59';
    return DEFAULT_RST.get(mode.submode ?? mode.mode) ?? DEFAULT_RST.get(mode.mode) ?? '59';
}

/** Creates an empty draft. Frequency and mode are carried over between QSOs. */
export function newDraft(carry: Pick<DraftQso, 'frequencyHz' | 'mode'> = {}): DraftQso {
    const rst = defaultRst(carry.mode);
    return {
        rstSent: rst,
        rstReceived: rst,
        qsl: 'none',
        frequencyHz: carry.frequencyHz,
        mode: carry.mode
    };
}

/**
 * Changes the mode. A report still at the old mode's default moves to the new one's, so that
 * `mode cw` after `callsign ...` does not leave a phone report behind.
 */
export function withMode(draft: DraftQso, mode: QsoMode | undefined): DraftQso {
    const before = defaultRst(draft.mode);
    const after = defaultRst(mode);
    return {
        ...draft,
        mode,
        rstSent: draft.rstSent === before ? after : draft.rstSent,
        rstReceived: draft.rstReceived === before ? after : draft.rstReceived
    };
}

/** True if nothing QSO-specific has been entered yet. */
export function isPristine(draft: DraftQso): boolean {
    return draft.startedAt === undefined;
}

/** Human-readable description of what an update did, for the list of recent utterances. */
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
            return `JCC/JCG →${update.value}`;
        case 'qsl':
            return { none: 'No QSL', requested: 'QSL requested', oneWay: 'QSL one way' }[
                update.value
            ];
        case 'mode':
            return `Mode → ${formatMode(update.value)}`;
        case 'exchangeReceived':
            return `Number → ${update.value}`;
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
    let next: DraftQso = { ...draft, startedAt: draft.startedAt ?? now.toISOString() };
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
        case 'qsl':
            next.qsl = update.value;
            break;
        case 'mode':
            next = withMode(next, update.value);
            break;
        case 'exchangeReceived':
            next.exchangeReceived = update.value;
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
