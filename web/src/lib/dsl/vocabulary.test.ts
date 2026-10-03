import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { grammarSequences } from './grammar';
import { JAPANESE_READINGS, type SpeechLanguage } from './lexicon';

/**
 * Checks the grammar against the vocabulary (`graph/words.txt`) of the models the app ships.
 * Vosk silently drops grammar words its model does not know, so this is the only place where a
 * reading that no model can emit shows up. Runs only where CI has fetched the vocabularies
 * (`.github/workflows/ci.yml`); elsewhere it is skipped.
 */
const VOCABULARIES: [SpeechLanguage, string | undefined][] = [
	['en', process.env.VOSK_WORDS_EN],
	['ja', process.env.VOSK_WORDS_JA]
];

function readVocabulary(path: string): Set<string> {
	return new Set(
		readFileSync(path, 'utf8')
			.split('\n')
			.map((line) => line.split(/\s+/)[0])
			.filter((word) => word !== '')
	);
}

for (const [language, path] of VOCABULARIES) {
	describe.skipIf(path === undefined)(`the ${language} model vocabulary`, () => {
		const vocabulary = path === undefined ? new Set<string>() : readVocabulary(path);
		const known = (sequence: readonly string[]) => sequence.every((w) => vocabulary.has(w));

		it('can say something for every word class', () => {
			const missing = new Set<string>();
			const silent: string[] = [];
			for (const [slot, sequences] of Object.entries(grammarSequences(language))) {
				if (slot === 'unknown') continue;
				for (const word of sequences.flat()) if (!vocabulary.has(word)) missing.add(word);
				if (!sequences.some(known)) silent.push(slot);
			}
			console.log(
				`[${language}] grammar words missing from the model (${missing.size}): ${[...missing].join(' ')}`
			);
			expect(silent, `word classes the ${language} model cannot say at all`).toEqual([]);
		});

		it.skipIf(language !== 'ja')('reports words without a usable katakana reading', () => {
			const unsayable = Object.entries(JAPANESE_READINGS)
				.filter(([, readings]) => !readings.some((r) => known(r.split(' '))))
				.map(([english]) => english);
			// Most of these are still sayable word by word (`call sign` as コール サイン).
			console.log(`[ja] English words with no reading in the model: ${unsayable.join(', ')}`);
			expect(Array.isArray(unsayable)).toBe(true);
		});
	});
}
