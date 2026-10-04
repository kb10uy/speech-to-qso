import { describe, expect, it } from 'vitest';
import {
	COMMAND_KEYWORDS,
	DIGIT_WORDS,
	FREE_TEXT_ONLY_WORDS,
	JAPANESE_READINGS,
	MODE_WORDS,
	PHONETIC_LETTERS,
	QSL_VALUES,
	TEEN_WORDS,
	TENS_WORDS
} from './lexicon';
import { grammarPhrases } from './grammar';

/** Every word the parser knows, so the free-text-only list cannot drift away from the tables. */
function allWords(): Set<string> {
	const words = new Set<string>([
		...Object.keys(PHONETIC_LETTERS),
		...Object.keys(DIGIT_WORDS),
		...Object.keys(TEEN_WORDS),
		...Object.keys(TENS_WORDS),
		...QSL_VALUES.flatMap(({ words }) => words),
		...Object.keys(MODE_WORDS)
	]);
	for (const seqs of Object.values(COMMAND_KEYWORDS))
		for (const seq of seqs) seq.forEach((w) => words.add(w));
	return words;
}

describe('FREE_TEXT_ONLY_WORDS', () => {
	it('only lists words the parser accepts', () => {
		const known = allWords();
		for (const word of FREE_TEXT_ONLY_WORDS) expect(known, word).toContain(word);
	});

	it('only lists alternatives of a word that stays in the grammar', () => {
		const grammar = new Set(grammarPhrases().flatMap((p) => p.split(' ')));
		const letters = new Set(Object.values(PHONETIC_LETTERS));
		for (const letter of letters) {
			const spellings = Object.entries(PHONETIC_LETTERS).filter(([, l]) => l === letter);
			expect(
				spellings.some(([w]) => grammar.has(w)),
				letter
			).toBe(true);
		}
		for (const digit of new Set(Object.values(DIGIT_WORDS))) {
			const spellings = Object.entries(DIGIT_WORDS).filter(([, d]) => d === digit);
			expect(
				spellings.some(([w]) => grammar.has(w)),
				digit
			).toBe(true);
		}
		for (const [kind, seqs] of Object.entries(COMMAND_KEYWORDS)) {
			expect(
				seqs.some((seq) => seq.every((w) => grammar.has(w))),
				kind
			).toBe(true);
		}
	});
});

describe('JAPANESE_READINGS', () => {
	it('only reads words of the English grammar, or single letters', () => {
		const grammar = new Set(grammarPhrases('en').flatMap((p) => p.split(' ')));
		for (const english of Object.keys(JAPANESE_READINGS)) {
			for (const word of english.split(' ')) {
				if (!/^[a-z]$/.test(word)) expect(grammar, english).toContain(word);
			}
		}
	});

	it('names every letter with its full-width capital', () => {
		for (const letter of 'abcdefghijklmnopqrstuvwxyz') {
			const fullWidth = String.fromCharCode(letter.charCodeAt(0) - 0x61 + 0xff21);
			expect(JAPANESE_READINGS[letter], letter).toBe(fullWidth);
		}
	});

	it('gives every reading to exactly one English word', () => {
		const readings = Object.values(JAPANESE_READINGS);
		expect(new Set(readings).size).toBe(readings.length);
	});

	it('reads every word as a single Japanese word', () => {
		for (const reading of Object.values(JAPANESE_READINGS)) {
			expect(reading).toMatch(/^[\p{Script=Katakana}\p{Script=Han}ーＡ-Ｚ０-９]+$/u);
		}
	});
});
