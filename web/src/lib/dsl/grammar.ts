/**
 * Phrase grammar for grammar-constrained recognisers (Vosk grammar mode).
 *
 * Vosk estimates a bigram language model from the phrases it is given (`UpdateGrammarFst` in
 * vosk-api's recognizer.cc). A bare word list therefore only tells it which words exist: every
 * word becomes equally likely after every other word, and noise decodes as whichever short word
 * sounds closest. Instead, this module spells out the token-to-token transitions the DSL allows
 * as short phrases, so that digits are expected after `received`, letters after `call sign`,
 * nothing but digits after `point`, and so on.
 *
 * The transitions are a class-level, slightly permissive mirror of the parser; the parser still
 * has the final say. Free-text-only spellings (`FREE_TEXT_ONLY_WORDS`) are left out, and words
 * that are missing from a model's vocabulary are simply ignored by Vosk. For a Japanese model
 * the same grammar is spelled with the Japanese readings (`JAPANESE_READINGS`).
 */
import {
    COMMAND_KEYWORDS,
    DIGIT_WORDS,
    FREE_TEXT_ONLY_WORDS,
    HUNDRED_WORDS,
    JAPANESE_READINGS,
    MEGAHERTZ_WORDS,
    MODE_WORDS,
    PHONETIC_LETTERS,
    POINT_WORDS,
    QSL_VALUES,
    REPEAT_WORDS,
    STROKE_WORDS,
    SUFFIX_WORDS,
    TEEN_WORDS,
    TENS_WORDS,
    lookup,
    type CommandKind,
    type SpeechLanguage
} from './lexicon';

/** A word class of the DSL; every member is a sequence of one or more tokens. */
type Slot =
    | 'letter'
    | 'number'
    | 'hundred'
    | 'repeat'
    | 'point'
    | 'megahertz'
    | 'stroke'
    | 'suffix'
    | 'callsignKeyword'
    | 'rstKeyword'
    | 'frequencyKeyword'
    | 'jcxKeyword'
    | 'qslKeyword'
    | 'modeKeyword'
    | 'qslValue'
    | 'mode'
    | 'unknown';

export type Sequence = readonly string[];

function single(words: Iterable<string>): Sequence[] {
    return [...words].filter((w) => !FREE_TEXT_ONLY_WORDS.has(w)).map((w) => [w]);
}

function keyword(...kinds: CommandKind[]): Sequence[] {
    return kinds.flatMap((kind) =>
        COMMAND_KEYWORDS[kind].filter((seq) => seq.every((w) => !FREE_TEXT_ONLY_WORDS.has(w)))
    );
}

const ENGLISH: Readonly<Record<Slot, readonly Sequence[]>> = {
    letter: [...single(Object.keys(PHONETIC_LETTERS)), ['x', 'ray']],
    number: single([
        ...Object.keys(DIGIT_WORDS),
        ...Object.keys(TEEN_WORDS),
        ...Object.keys(TENS_WORDS)
    ]),
    hundred: single(HUNDRED_WORDS),
    repeat: single(Object.keys(REPEAT_WORDS)),
    point: single(POINT_WORDS),
    megahertz: single(MEGAHERTZ_WORDS),
    stroke: single(STROKE_WORDS),
    suffix: single(Object.keys(SUFFIX_WORDS)),
    callsignKeyword: keyword('callsign'),
    rstKeyword: keyword('rstSent', 'rstReceived'),
    frequencyKeyword: keyword('frequency'),
    jcxKeyword: keyword('jcx'),
    qslKeyword: keyword('qsl'),
    modeKeyword: keyword('mode'),
    qslValue: QSL_VALUES.map(({ words }) => words),
    mode: single(Object.keys(MODE_WORDS)),
    unknown: [['[unk]']]
};

const SLOTS = Object.keys(ENGLISH) as Slot[];

/**
 * The Japanese spelling of an English sequence: its own reading (`one way` → `ワンウェイ`), or else
 * its words' readings (`j c x` → `Ｊ Ｃ Ｘ`). None if a word has no reading.
 */
function inJapanese(sequence: Sequence): Sequence[] {
    const whole = lookup(JAPANESE_READINGS, sequence.join(' '));
    if (whole !== undefined) return [whole.split(' ')];
    const words = sequence.map((word) => lookup(JAPANESE_READINGS, word));
    return words.every((w) => w !== undefined) ? [words as string[]] : [];
}

/**
 * The Japanese model has the letters themselves as words (`Ｊ`), so there a callsign can also be
 * spelled with letter names. The English grammar keeps them out: a single short letter is what
 * noise decodes as most easily, and the phonetic alphabet exists to avoid exactly that.
 */
const JAPANESE_SOURCE: Readonly<Record<Slot, readonly Sequence[]>> = {
    ...ENGLISH,
    letter: [
        ...ENGLISH.letter,
        ...[...new Set(Object.values(PHONETIC_LETTERS))].map((letter) => [letter.toLowerCase()])
    ]
};

const JAPANESE = Object.fromEntries(
    SLOTS.map((slot) => [
        slot,
        slot === 'unknown' ? ENGLISH.unknown : JAPANESE_SOURCE[slot].flatMap(inJapanese)
    ])
) as Record<Slot, readonly Sequence[]>;

/** The word sequences of each word class, as a recogniser for `language` emits them. */
export function grammarSequences(
    language: SpeechLanguage
): Readonly<Record<string, readonly Sequence[]>> {
    return language === 'ja' ? JAPANESE : ENGLISH;
}
const KEYWORDS: readonly Slot[] = [
    'callsignKeyword',
    'rstKeyword',
    'frequencyKeyword',
    'jcxKeyword',
    'qslKeyword',
    'modeKeyword'
];
/** What may follow a complete field value: another command, or noise. */
const NEXT_COMMAND: readonly Slot[] = [...KEYWORDS, 'unknown'];

type Next = Slot | 'end';

/** Allowed successors of each slot (`end` closes the utterance). Mirrors the parser. */
const TRANSITIONS: Readonly<Record<Slot, readonly Next[]>> = {
    letter: ['letter', 'number', 'stroke', 'suffix', ...NEXT_COMMAND, 'end'],
    number: [
        'number',
        'hundred',
        'repeat',
        'point',
        'megahertz',
        'stroke',
        'suffix',
        'letter',
        ...NEXT_COMMAND,
        'end'
    ],
    hundred: ['number', 'letter', 'point', 'megahertz', 'stroke', 'suffix', ...NEXT_COMMAND, 'end'],
    repeat: ['number'],
    point: ['number'],
    megahertz: [...NEXT_COMMAND, 'end'],
    stroke: ['letter', 'number'],
    suffix: ['number', ...NEXT_COMMAND, 'end'],
    callsignKeyword: ['letter', 'number', 'unknown'],
    rstKeyword: ['number', 'unknown'],
    frequencyKeyword: ['number', 'point', 'unknown'],
    jcxKeyword: ['number', 'unknown'],
    qslKeyword: ['qslValue', 'unknown'],
    qslValue: [...NEXT_COMMAND, 'end'],
    modeKeyword: ['mode', 'letter', 'number', 'unknown'],
    mode: [...NEXT_COMMAND, 'end'],
    unknown: [...SLOTS, 'end']
};

/** What an utterance may start with: a bare callsign, a command, or noise. */
const START: readonly Slot[] = ['letter', 'number', ...KEYWORDS, 'unknown'];

/** Shortest slot path from the start to each slot (excluding the slot itself). */
function prefixes(): Map<Slot, Slot[]> {
    const paths = new Map<Slot, Slot[]>();
    const queue: Slot[] = [];
    for (const slot of START) {
        paths.set(slot, []);
        queue.push(slot);
    }
    for (let i = 0; i < queue.length; i++) {
        const slot = queue[i];
        const path = [...paths.get(slot)!, slot];
        for (const next of TRANSITIONS[slot]) {
            if (next === 'end' || paths.has(next)) continue;
            paths.set(next, path);
            queue.push(next);
        }
    }
    return paths;
}

/** Shortest slot path from each slot to the end (excluding the slot itself). */
function suffixes(): Map<Slot, Slot[]> {
    const paths = new Map<Slot, Slot[]>();
    const queue: Slot[] = [];
    for (const slot of SLOTS) {
        if (TRANSITIONS[slot].includes('end')) {
            paths.set(slot, []);
            queue.push(slot);
        }
    }
    for (let i = 0; i < queue.length; i++) {
        const slot = queue[i];
        const path = [slot, ...paths.get(slot)!];
        for (const prev of SLOTS) {
            if (paths.has(prev) || !TRANSITIONS[prev].includes(slot)) continue;
            paths.set(prev, path);
            queue.push(prev);
        }
    }
    return paths;
}

/**
 * Phrases for Vosk's grammar: every allowed word-to-word transition, embedded in a shortest
 * complete utterance so that sentence starts and ends are counted correctly too.
 */
export function grammarPhrases(language: SpeechLanguage = 'en'): string[] {
    const words = language === 'ja' ? JAPANESE : ENGLISH;
    const prefix = prefixes();
    const suffix = suffixes();
    // Fill the padding slots round-robin so no word is favoured just by being first in a table.
    const counters = new Map<Slot, number>();
    const pick = (slot: Slot): Sequence => {
        const seqs = words[slot];
        const n = counters.get(slot) ?? 0;
        counters.set(slot, n + 1);
        return seqs[n % seqs.length];
    };

    const phrases = new Set<string>();
    const emit = (before: Slot[], words: Sequence[], after: Slot[]) => {
        phrases.add([...before.map(pick), ...words, ...after.map(pick)].flat().join(' '));
    };

    for (const slot of START) {
        for (const seq of words[slot]) emit([], [seq], suffix.get(slot)!);
    }
    for (const slot of SLOTS) {
        for (const next of TRANSITIONS[slot]) {
            if (next === 'end') {
                for (const seq of words[slot]) emit(prefix.get(slot)!, [seq], []);
                continue;
            }
            for (const seq of words[slot]) {
                for (const nextSeq of words[next]) {
                    emit(prefix.get(slot)!, [seq, nextSeq], suffix.get(next)!);
                }
            }
        }
    }
    return [...phrases];
}
