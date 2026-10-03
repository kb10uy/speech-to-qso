import { describe, expect, it } from 'vitest';
import { tokenize } from './tokenize';

describe('tokenize', () => {
	it('lowercases and splits words', () => {
		expect(tokenize('Juliett  Lima ONE')).toEqual(['juliett', 'lima', 'one']);
	});

	it('normalizes x-ray spellings', () => {
		expect(tokenize('x-ray X ray xray')).toEqual(['xray', 'xray', 'xray']);
	});

	it('drops fillers and [unk]', () => {
		expect(tokenize('uh received [unk] the five seven')).toEqual(['received', 'five', 'seven']);
	});

	it('splits numerals into digits and points', () => {
		expect(tokenize('frequency 432.94')).toEqual(['frequency', '4', '3', '2', 'point', '9', '4']);
		expect(tokenize('frequency .94')).toEqual(['frequency', 'point', '9', '4']);
	});

	it('spells out typed alphanumeric callsigns phonetically', () => {
		expect(tokenize('JL1HIS/P')).toEqual([
			'juliett',
			'lima',
			'1',
			'hotel',
			'india',
			'sierra',
			'stroke',
			'papa'
		]);
	});

	it('keeps keywords and mode words intact', () => {
		expect(tokenize('JCX 100101')).toEqual(['jcx', '1', '0', '0', '1', '0', '1']);
		expect(tokenize('mode FT8')).toEqual(['mode', 'ft8']);
	});
});
