import { matchKeyword } from './keywords';
import {
    COMMAND_LABELS,
    MEGAHERTZ_WORDS,
    MODE_WORDS,
    PHONETIC_LETTERS,
    POINT_WORDS,
    QSL_VALUES,
    STROKE_WORDS,
    lookup
} from './lexicon';
import { readSmallGroup } from './numbers';
import { tokenize } from './tokenize';

const POINTS = new Set<string>(POINT_WORDS);
const MEGAHERTZ = new Set<string>(MEGAHERTZ_WORDS);
const STROKES = new Set<string>(STROKE_WORDS);

/** Converts a phonetic word or a single letter into an uppercase letter. */
export function letterOf(token: string): string | undefined {
    if (/^[a-z]$/.test(token)) return token.toUpperCase();
    return lookup(PHONETIC_LETTERS, token);
}

function labelAt(tokens: readonly string[], i: number): { label: string; end: number } {
    const keyword = matchKeyword(tokens, i);
    if (keyword !== null) return { label: COMMAND_LABELS[keyword.kind], end: i + keyword.length };
    const qsl = QSL_VALUES.find(({ words }) => words.every((w, k) => tokens[i + k] === w));
    if (qsl !== undefined) return { label: qsl.label, end: i + qsl.words.length };
    const token = tokens[i];
    const number = readSmallGroup(tokens, i);
    if (number !== null) return { label: number.digits, end: number.end };
    let label = letterOf(token) ?? lookup(MODE_WORDS, token) ?? token;
    if (POINTS.has(token)) label = '.';
    else if (STROKES.has(token)) label = '/';
    else if (MEGAHERTZ.has(token)) label = 'MHz';
    return { label, end: i + 1 };
}

export function tokenLabel(token: string): string {
    return labelAt([token], 0).label;
}

export function formatTokens(tokens: readonly string[]): string {
    const labels: string[] = [];
    let i = 0;
    while (i < tokens.length) {
        const { label, end } = labelAt(tokens, i);
        labels.push(label);
        i = end;
    }
    return labels.join(' ');
}

export function formatSpeech(text: string): string {
    return formatTokens(tokenize(text));
}
