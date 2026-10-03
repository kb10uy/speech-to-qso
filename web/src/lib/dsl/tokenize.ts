import { COMMAND_KEYWORDS, FILLER_WORDS, MODE_WORDS, PHONETIC_LETTERS } from './lexicon';

const KEYWORD_TOKENS = new Set<string>(
	Object.values(COMMAND_KEYWORDS).flatMap((seqs) => seqs.flatMap((seq) => [...seq]))
);
const FILLERS = new Set<string>(FILLER_WORDS);

/** Canonical phonetic word per letter, used to spell out typed alphanumerics unambiguously. */
const PHONETIC_OF_LETTER = new Map<string, string>();
for (const [word, letter] of Object.entries(PHONETIC_LETTERS)) {
	if (!PHONETIC_OF_LETTER.has(letter)) PHONETIC_OF_LETTER.set(letter, word);
}

/**
 * Normalises ASR (or typed) text into lowercase DSL tokens.
 *
 * Besides splitting words, this makes typed input convenient for testing and as an
 * emergency fallback: numerals are split into single digits (`432.94` → `4 3 2 point 9 4`)
 * and alphanumeric tokens are spelled out phonetically (`jl1his` → `juliett lima 1 hotel ...`).
 */
export function tokenize(text: string): string[] {
	const normalized = text
		.toLowerCase()
		.replace(/\bx[\s-]+ray\b/g, 'xray')
		.replace(/[,;:!?"()]/g, ' ');

	const tokens: string[] = [];
	for (const raw of normalized.split(/\s+/)) {
		if (raw === '') continue;
		if (raw === '[unk]') continue;
		const word = raw.replace(/^(?:[.'-](?!\d))+|[.'-]+$/g, '');
		if (word === '') {
			if (raw.includes('.')) tokens.push('point');
			continue;
		}
		if (FILLERS.has(word)) continue;
		if (KEYWORD_TOKENS.has(word) || word in MODE_WORDS) {
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
