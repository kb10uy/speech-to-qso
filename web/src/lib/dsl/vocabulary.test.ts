import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { grammarSequences } from './grammar';
import { JAPANESE_READINGS, type SpeechLanguage } from './lexicon';

/**
 * Checks the grammar against the vocabulary of the models the app ships. Vosk silently drops
 * grammar words its model does not know, so this is the only place where a reading that no
 * model can emit shows up. Runs only where CI has fetched the vocabularies
 * (`.github/workflows/ci.yml`); elsewhere it is skipped.
 *
 * A model keeps its words either in `graph/words.txt` or, like the small models, only as the
 * output symbol table of `graph/Gr.fst` (Vosk falls back to it in `model.cc`); both are read.
 */
const VOCABULARIES: [SpeechLanguage, string | undefined][] = [
	['en', process.env.VOSK_WORDS_EN],
	['ja', process.env.VOSK_WORDS_JA]
];

const FST_MAGIC = 2125659606;
const SYMBOL_TABLE_MAGIC = 2125658996;
const HAS_ISYMBOLS = 1;
const HAS_OSYMBOLS = 2;

/** Reads the output symbol table embedded in an OpenFst binary FST (any FST type). */
function fstOutputSymbols(bytes: Uint8Array): string[] {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const decoder = new TextDecoder();
	let at = 0;
	const int32 = () => ((at += 4), view.getInt32(at - 4, true));
	const int64 = () => ((at += 8), Number(view.getBigInt64(at - 8, true)));
	const string = () => {
		const length = int32();
		at += length;
		return decoder.decode(bytes.subarray(at - length, at));
	};
	const symbolTable = () => {
		if (int32() !== SYMBOL_TABLE_MAGIC) throw new Error('not an OpenFst symbol table');
		string(); // name
		int64(); // available key
		const symbols: string[] = [];
		for (let size = int64(); symbols.length < size; int64()) symbols.push(string());
		return symbols;
	};

	// FstHeader: magic, FST type, arc type, version, flags, properties, start, #states, #arcs.
	if (int32() !== FST_MAGIC) throw new Error('not an OpenFst binary');
	string();
	string();
	int32();
	const flags = int32();
	at += 4 * 8;
	if (flags & HAS_ISYMBOLS) symbolTable();
	if (!(flags & HAS_OSYMBOLS)) throw new Error('the FST has no output symbols');
	return symbolTable();
}

function readVocabulary(path: string): Set<string> {
	const bytes = readFileSync(path);
	if (bytes.length >= 4 && bytes.readInt32LE(0) === FST_MAGIC) {
		return new Set(fstOutputSymbols(bytes));
	}
	return new Set(
		bytes
			.toString('utf8')
			.split('\n')
			.map((line) => line.split(/\s+/)[0])
			.filter((word) => word !== '')
	);
}

describe('fstOutputSymbols', () => {
	// Written by OpenFst itself (pywrapfst), as a vector and as a const FST.
	it.each(['vector', 'const'])('reads the words of a %s FST', (type) => {
		const bytes = readFileSync(new URL(`./fixtures/words-${type}.fst`, import.meta.url));
		expect(fstOutputSymbols(bytes)).toEqual([
			'<eps>',
			'!SIL',
			'[unk]',
			'received',
			'five',
			'ゼロ',
			'ワン',
			'#0'
		]);
	});

	it('rejects anything else', () => {
		expect(() => fstOutputSymbols(new TextEncoder().encode('zero 0\none 1\n'))).toThrow(
			'not an OpenFst binary'
		);
	});
});

for (const [language, path] of VOCABULARIES) {
	describe.skipIf(path === undefined)(`the ${language} model vocabulary`, () => {
		const vocabulary = path === undefined ? new Set<string>() : readVocabulary(path);

		it('can say something for every word class', () => {
			const missing = new Set<string>();
			const silent: string[] = [];
			for (const [slot, sequences] of Object.entries(grammarSequences(language))) {
				if (slot === 'unknown') continue;
				for (const word of sequences.flat()) if (!vocabulary.has(word)) missing.add(word);
				if (!sequences.some((seq) => seq.every((w) => vocabulary.has(w)))) silent.push(slot);
			}
			console.log(
				`[${language}] grammar words missing from the model (${missing.size}): ${[...missing].join(' ')}`
			);
			expect(silent, `word classes the ${language} model cannot say at all`).toEqual([]);
		});

		it.skipIf(language !== 'ja')('knows every Japanese reading as a word', () => {
			const unknown = Object.values(JAPANESE_READINGS)
				.flatMap((r) => r.split(' '))
				.filter((w) => !vocabulary.has(w));
			expect(unknown, 'readings missing from the ja model').toEqual([]);
		});
	});
}
