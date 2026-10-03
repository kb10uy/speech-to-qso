import {
	COMMAND_KEYWORDS,
	FILLER_WORDS,
	JAPANESE_READINGS,
	MODE_WORDS,
	PHONETIC_LETTERS,
	lookup
} from './lexicon';

const KEYWORD_TOKENS = new Set<string>(
	Object.values(COMMAND_KEYWORDS).flatMap((seqs) => seqs.flatMap((seq) => [...seq]))
);
const FILLERS = new Set<string>(FILLER_WORDS);

/** Canonical phonetic word per letter, used to spell out typed alphanumerics unambiguously. */
const PHONETIC_OF_LETTER = new Map<string, string>();
for (const [word, letter] of Object.entries(PHONETIC_LETTERS)) {
	if (!PHONETIC_OF_LETTER.has(letter)) PHONETIC_OF_LETTER.set(letter, word);
}

/** Katakana readings as word sequences, longest first so that a split loanword wins. */
const READINGS = Object.entries(JAPANESE_READINGS)
	.flatMap(([english, readings]) => readings.map((r) => ({ words: r.split(' '), english })))
	.sort((a, b) => b.words.length - a.words.length);

/** Replaces katakana readings with the English words they stand for. */
function fromKatakana(words: readonly string[]): string[] {
	const out: string[] = [];
	let i = 0;
	while (i < words.length) {
		const match = READINGS.find((r) => r.words.every((w, k) => words[i + k] === w));
		if (match === undefined) {
			out.push(words[i]);
			i += 1;
		} else {
			out.push(match.english);
			i += match.words.length;
		}
	}
	return out;
}

/**
 * Normalises ASR (or typed) text into lowercase DSL tokens.
 *
 * Besides splitting words, this makes typed input convenient for testing and as an
 * emergency fallback: numerals are split into single digits (`432.94` → `4 3 2 point 9 4`)
 * and alphanumeric tokens are spelled out phonetically (`jl1his` → `juliett lima 1 hotel ...`).
 * Katakana readings of DSL words (`ゼロ ワン`) become the English words (`zero one`).
 */
export function tokenize(text: string): string[] {
	// NFKC folds half-width katakana and full-width ASCII, which typed input may contain.
	const words = text
		.normalize('NFKC')
		.toLowerCase()
		.replace(/[,;:!?"()、。・]/g, ' ')
		.split(/\s+/)
		.filter((w) => w !== '');
	const normalized = fromKatakana(words)
		.join(' ')
		.replace(/\bx[\s-]+ray\b/g, 'xray');

	const tokens: string[] = [];
	for (const raw of normalized.split(/\s+/)) {
		if (raw === '') continue;
		const word = raw.replace(/^(?:[.'-](?!\d))+|[.'-]+$/g, '');
		if (word === '') {
			if (raw.includes('.')) tokens.push('point');
			continue;
		}
		if (FILLERS.has(word)) continue;
		if (KEYWORD_TOKENS.has(word) || lookup(MODE_WORDS, word) !== undefined) {
			tokens.push(word);
		} else if (/^[a-z0-9./]+$/.test(word) && /\d/.test(word)) {
			for (const ch of word) {
				if (ch === '.') tokens.push('point');
				else if (ch === '/') tokens.push('stroke');
				else tokens.push(PHONETIC_OF_LETTER.get(ch.toUpperCase()) ?? ch);
			}
		} else {
			for (const part of word.split('-')) if (part !== '') tokens.push(part);
		}
	}
	return tokens;
}
