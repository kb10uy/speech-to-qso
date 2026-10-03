import { DIGIT_WORDS, HUNDRED_WORDS, REPEAT_WORDS, TEEN_WORDS, TENS_WORDS } from './lexicon';
import { DslError } from './errors';

const HUNDREDS = new Set<string>(HUNDRED_WORDS);

function digitOf(token: string | undefined): string | undefined {
	if (token === undefined) return undefined;
	if (/^\d$/.test(token)) return token;
	return DIGIT_WORDS[token];
}

/** True if `token` can be part of a spoken digit sequence. */
export function isNumberToken(token: string): boolean {
	return (
		digitOf(token) !== undefined ||
		token in TEEN_WORDS ||
		token in TENS_WORDS ||
		token in REPEAT_WORDS ||
		HUNDREDS.has(token)
	);
}

/** Reads a group of at most two digits (`seven`, `fourteen`, `thirty`, `thirty two`). */
function readSmallGroup(
	tokens: readonly string[],
	i: number
): { digits: string; end: number } | null {
	const token = tokens[i];
	const digit = digitOf(token);
	if (digit !== undefined) return { digits: digit, end: i + 1 };
	if (token in TEEN_WORDS) return { digits: TEEN_WORDS[token], end: i + 1 };
	if (token in TENS_WORDS) {
		const unit = digitOf(tokens[i + 1]);
		if (unit !== undefined && unit !== '0') return { digits: TENS_WORDS[token] + unit, end: i + 2 };
		return { digits: TENS_WORDS[token] + '0', end: i + 1 };
	}
	return null;
}

/**
 * Reads a run of spoken digits starting at `start` and returns it as a digit string.
 *
 * Groups are concatenated the way radio operators read numbers aloud, so
 * `four thirty two` → `432`, `one forty five` → `145` and `zero one` → `01`.
 * `hundred` and `double`/`triple` are also understood. Leading zeros are preserved,
 * which is why the result is a string rather than a number.
 */
export function readDigits(
	tokens: readonly string[],
	start: number
): { digits: string; end: number } {
	const groups: string[] = [];
	let i = start;
	while (i < tokens.length) {
		const token = tokens[i];
		const small = readSmallGroup(tokens, i);
		if (small !== null) {
			groups.push(small.digits);
			i = small.end;
		} else if (HUNDREDS.has(token)) {
			const prev = groups.pop();
			if (prev === undefined || prev.length !== 1) {
				throw new DslError(`"${token}" must follow a single digit`);
			}
			const rest = readSmallGroup(tokens, i + 1);
			if (rest !== null) {
				groups.push(prev + rest.digits.padStart(2, '0'));
				i = rest.end;
			} else {
				groups.push(prev + '00');
				i += 1;
			}
		} else if (token in REPEAT_WORDS) {
			const digit = digitOf(tokens[i + 1]);
			if (digit === undefined) throw new DslError(`"${token}" must be followed by a digit`);
			groups.push(digit.repeat(REPEAT_WORDS[token]));
			i += 2;
		} else {
			break;
		}
	}
	return { digits: groups.join(''), end: i };
}
