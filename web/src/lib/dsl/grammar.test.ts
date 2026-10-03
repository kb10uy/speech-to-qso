import { describe, expect, it } from 'vitest';
import { grammarPhrases } from './grammar';
import { FREE_TEXT_ONLY_WORDS } from './lexicon';
import { parseSpeech } from './parser';

const phrases = grammarPhrases();
const words = phrases.map((p) => p.split(' '));
const starts = new Set(words.map((w) => w[0]));
const ends = new Set(words.map((w) => w[w.length - 1]));
const bigrams = new Set<string>();
for (const w of words) for (let i = 0; i + 1 < w.length; i++) bigrams.add(`${w[i]} ${w[i + 1]}`);

describe('grammarPhrases', () => {
	it('covers every transition of real utterances', () => {
		const samples = [
			'juliet lima one hotel india sierra',
			'seven kilo four x ray yankee zulu stroke one',
			'call sign juliet alpha one zulu lima oscar portable one',
			'station juliet alpha one zulu lima oscar mobile',
			'received five nine sent five seven',
			'received fifty nine',
			'sent five double nine',
			'frequency four thirty two point nine four megahertz',
			'frequency seven point one four five',
			'frequency point zero five',
			'frequency one hundred forty five megs',
			'jcx one zero zero one zero one',
			'j c x one zero zero one zero one',
			'jcx one one zero zero one golf',
			'card',
			'no card',
			'qsl requested',
			'one way',
			'card one way',
			'juliet lima one hotel india sierra one way',
			'mode fm',
			'mode foxtrot mike',
			'mode foxtrot tango eight',
			'juliet lima one hotel india sierra received five nine sent five nine card mode fm frequency four three two point nine four'
		];
		for (const sample of samples) {
			expect(parseSpeech(sample).ok, sample).toBe(true);
			const w = sample.split(' ');
			expect(starts, sample).toContain(w[0]);
			expect(ends, sample).toContain(w[w.length - 1]);
			for (let i = 0; i + 1 < w.length; i++) {
				expect(bigrams, sample).toContain(`${w[i]} ${w[i + 1]}`);
			}
		}
	});

	it('does not allow transitions the DSL has no use for', () => {
		expect(bigrams).not.toContain('received alpha');
		expect(bigrams).not.toContain('point alpha');
		expect(bigrams).not.toContain('alpha point');
		expect(bigrams).not.toContain('card five');
		expect(bigrams).not.toContain('frequency alpha');
		expect(bigrams).not.toContain('megahertz five');
		expect(starts).not.toContain('point');
		expect(starts).not.toContain('requested');
		expect(ends).not.toContain('stroke');
		expect(ends).not.toContain('received');
		expect(ends).not.toContain('double');
	});

	it('lets noise appear anywhere', () => {
		expect(phrases).toContain('[unk]');
		expect(bigrams).toContain('[unk] received');
		expect(bigrams).toContain('five [unk]');
	});

	it('leaves free-text-only spellings out', () => {
		const all = new Set(words.flat());
		for (const word of FREE_TEXT_ONLY_WORDS) expect(all).not.toContain(word);
		expect(all).toContain('two');
		expect(all).toContain('juliet');
		expect(all).toContain('niner');
	});

	it('stays small enough to compile when the engine loads', () => {
		expect(phrases.length).toBeLessThan(10_000);
		expect(new Set(phrases).size).toBe(phrases.length);
	});
});
