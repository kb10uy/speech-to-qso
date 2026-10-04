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

	it('maps Japanese readings to the English words', () => {
		expect(tokenize('受信 ファイブ ナイン')).toEqual(['received', 'five', 'nine']);
		expect(tokenize('周波 数 ポイント ナイン')).toEqual(['frequency', 'point', 'nine']);
		expect(tokenize('ゼロ ゼロ ワン')).toEqual(['zero', 'zero', 'one']);
	});

	it('maps a loanword the model split into several words', () => {
		expect(tokenize('フォックス トロット')).toEqual(['foxtrot']);
		expect(tokenize('フォックス・トロット')).toEqual(['foxtrot']);
		expect(tokenize('エックス レイ')).toEqual(['xray']);
		expect(tokenize('ジェイ シー シー')).toEqual(['jcc']);
		expect(tokenize('ジェイ シー エックス')).toEqual(['j', 'c', 'x']);
		expect(tokenize('ワンウェイ')).toEqual(['one', 'way']);
	});

	it('folds half-width katakana and full-width letters', () => {
		expect(tokenize('ｾﾞﾛ　ﾜﾝ')).toEqual(['zero', 'one']);
		expect(tokenize('ＪＬ１ＨＩＳ')).toEqual(tokenize('jl1his'));
	});

	it('keeps katakana it does not know, so the parser rejects it', () => {
		expect(tokenize('ゼロ テレビ')).toEqual(['zero', 'テレビ']);
	});
});
