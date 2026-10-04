import { formatTokens, letterOf, tokenLabel } from './display';
import { DslError } from './errors';
import type { FrequencyPattern } from './frequency';
import { MAX_FRACTION_DIGITS, MAX_INTEGER_DIGITS } from './frequency';
import { matchKeyword } from './keywords';
import {
	MEGAHERTZ_WORDS,
	MODE_WORDS,
	POINT_WORDS,
	QSL_VALUES,
	STROKE_WORDS,
	SUFFIX_WORDS,
	lookup,
	type CommandKind,
	type QslStatus
} from './lexicon';
import { isNumberToken, readDigits } from './numbers';
import { tokenize } from './tokenize';

/** A single field update produced by an utterance. */
export type SpokenUpdate =
	| { kind: 'callsign'; value: string }
	| { kind: 'rstSent'; value: string }
	| { kind: 'rstReceived'; value: string }
	| { kind: 'frequency'; value: FrequencyPattern }
	| { kind: 'jcx'; value: string }
	| { kind: 'qsl'; value: QslStatus }
	| { kind: 'mode'; value: string };

export type ParseResult =
	| { ok: true; tokens: string[]; updates: SpokenUpdate[] }
	| { ok: false; tokens: string[]; error: string };

/** Modes accepted by `mode ...` when spelled out with letters/digits. */
export const KNOWN_MODES = [
	'FM',
	'AM',
	'SSB',
	'USB',
	'LSB',
	'CW',
	'RTTY',
	'FT8',
	'FT4',
	'PSK31',
	'JT65',
	'SSTV',
	'DSTAR',
	'C4FM',
	'DMR'
] as const;

const POINTS = new Set<string>(POINT_WORDS);
const MEGAHERTZ = new Set<string>(MEGAHERTZ_WORDS);
const STROKES = new Set<string>(STROKE_WORDS);

/** Reads phonetic letters, digits and strokes into an uppercase string. */
function readSpelled(tokens: readonly string[], allowStroke: boolean): string {
	let out = '';
	let i = 0;
	while (i < tokens.length) {
		const token = tokens[i];
		const letter = letterOf(token);
		const suffix = allowStroke ? lookup(SUFFIX_WORDS, token) : undefined;
		if (letter !== undefined) {
			out += letter;
			i += 1;
		} else if (isNumberToken(token)) {
			const { digits, end } = readDigits(tokens, i);
			if (end === i) throw new DslError(`unexpected "${tokenLabel(token)}"`);
			out += digits;
			i = end;
		} else if (allowStroke && STROKES.has(token)) {
			out += '/';
			i += 1;
		} else if (suffix !== undefined) {
			// "portable one" is the area number (/1), not /P1; the letter is only implied on its own.
			const next = tokens[i + 1];
			out += next !== undefined && isNumberToken(next) ? '/' : suffix;
			i += 1;
		} else {
			throw new DslError(`unexpected "${tokenLabel(token)}"`);
		}
	}
	return out;
}

const CALLSIGN_PATTERN = /^(?=.*[A-Z])(?=.*\d)[A-Z0-9]+(?:\/[A-Z0-9]+)*$/;

/** True for an uppercase callsign with optional `/X` parts (same rule as the server). */
export function isCallsign(s: string): boolean {
	return s.length >= 3 && s.length <= 16 && CALLSIGN_PATTERN.test(s);
}

function parseCallsign(tokens: readonly string[]): string {
	if (tokens.length === 0) throw new DslError('callsign is empty');
	const callsign = readSpelled(tokens, true);
	if (!isCallsign(callsign)) throw new DslError(`"${callsign}" is not a valid callsign`);
	return callsign;
}

function readAllDigits(tokens: readonly string[], what: string): string {
	const { digits, end } = readDigits(tokens, 0);
	if (end !== tokens.length)
		throw new DslError(`unexpected "${tokenLabel(tokens[end])}" in ${what}`);
	if (digits === '') throw new DslError(`${what} is empty`);
	return digits;
}

function parseRst(tokens: readonly string[]): string {
	const rst = readAllDigits(tokens, 'RST');
	if (!/^[1-5][1-9][1-9]?$/.test(rst)) throw new DslError(`"${rst}" is not a valid RST`);
	return rst;
}

function parseFrequency(tokens: readonly string[]): FrequencyPattern {
	const integer = readDigits(tokens, 0);
	let i = integer.end;
	let fractionDigits = '';
	if (i < tokens.length && POINTS.has(tokens[i])) {
		const fraction = readDigits(tokens, i + 1);
		if (fraction.end === i + 1) throw new DslError('expected digits after "point"');
		fractionDigits = fraction.digits;
		i = fraction.end;
	}
	if (i < tokens.length && MEGAHERTZ.has(tokens[i])) i += 1;
	if (i !== tokens.length) throw new DslError(`unexpected "${tokenLabel(tokens[i])}" in frequency`);
	if (integer.digits === '' && fractionDigits === '') throw new DslError('frequency is empty');
	if (integer.digits.length > MAX_INTEGER_DIGITS || fractionDigits.length > MAX_FRACTION_DIGITS) {
		throw new DslError('frequency has too many digits');
	}
	return { integerDigits: integer.digits, fractionDigits };
}

function parseJcx(tokens: readonly string[]): string {
	const jcx = readSpelled(tokens, false);
	if (!/^\d{4,6}[A-Z]{0,2}$/.test(jcx)) throw new DslError(`"${jcx}" is not a valid JCC/JCG code`);
	return jcx;
}

function parseQsl(tokens: readonly string[]): QslStatus {
	const value = QSL_VALUES.find(
		({ words }) => words.length === tokens.length && words.every((w, i) => w === tokens[i])
	);
	if (value !== undefined) return value.status;
	const expected = QSL_VALUES.map(({ words }) => `"${words.join(' ')}"`).join(', ');
	throw new DslError(`expected ${expected} after "card", got "${formatTokens(tokens)}"`);
}

function parseMode(tokens: readonly string[]): string {
	if (tokens.length === 0) throw new DslError('mode is empty');
	const word = tokens.length === 1 ? lookup(MODE_WORDS, tokens[0]) : undefined;
	if (word !== undefined) return word;
	const mode = readSpelled(tokens, false);
	if (!(KNOWN_MODES as readonly string[]).includes(mode))
		throw new DslError(`unknown mode "${mode}"`);
	return mode;
}

function parseSegment(kind: CommandKind, tokens: readonly string[]): SpokenUpdate {
	switch (kind) {
		case 'callsign':
			return { kind: 'callsign', value: parseCallsign(tokens) };
		case 'rstSent':
			return { kind: 'rstSent', value: parseRst(tokens) };
		case 'rstReceived':
			return { kind: 'rstReceived', value: parseRst(tokens) };
		case 'frequency':
			return { kind: 'frequency', value: parseFrequency(tokens) };
		case 'jcx':
			return { kind: 'jcx', value: parseJcx(tokens) };
		case 'qsl':
			return { kind: 'qsl', value: parseQsl(tokens) };
		case 'mode':
			return { kind: 'mode', value: parseMode(tokens) };
	}
}

/** Parses already-tokenized input. See {@link parseSpeech}. */
export function parseTokens(tokens: readonly string[]): SpokenUpdate[] {
	if (tokens.length === 0) throw new DslError('nothing recognized');

	// Split into segments at command keywords. Tokens before the first keyword are a callsign.
	const segments: { kind: CommandKind; tokens: string[] }[] = [];
	let current: { kind: CommandKind; tokens: string[] } = { kind: 'callsign', tokens: [] };
	let i = 0;
	while (i < tokens.length) {
		const match = matchKeyword(tokens, i);
		if (match === null) {
			current.tokens.push(tokens[i]);
			i += 1;
			continue;
		}
		if (segments.length > 0 || current.tokens.length > 0) segments.push(current);
		current = { kind: match.kind, tokens: [] };
		i += match.length;
	}
	segments.push(current);

	return segments.map((s) => parseSegment(s.kind, s.tokens));
}

/**
 * Parses one PTT utterance.
 *
 * An utterance is normally a single command (`received five seven`), but several commands may
 * be chained (`juliett lima one hotel india sierra received five seven`). The utterance is
 * all-or-nothing: if any part fails to parse, no update is produced.
 */
export function parseSpeech(text: string): ParseResult {
	const tokens = tokenize(text);
	try {
		return { ok: true, tokens, updates: parseTokens(tokens) };
	} catch (e) {
		if (e instanceof DslError) return { ok: false, tokens, error: e.message };
		throw e;
	}
}
