import { describe, expect, it } from 'vitest';
import { formatSpeech, formatTokens, tokenLabel } from './display';

describe('display labels', () => {
	it('shows one label per letter, whichever way it was said', () => {
		expect(formatSpeech('juliett')).toBe('J');
		expect(formatSpeech('juliet')).toBe('J');
		expect(formatSpeech('ジュリエット')).toBe('J');
		expect(formatSpeech('Ｊ')).toBe('J');
		expect(formatSpeech('x-ray フォックス トロット')).toBe('X F');
	});

	it('shows numbers as digits', () => {
		expect(formatSpeech('five niner')).toBe('5 9');
		expect(formatSpeech('four thirty two')).toBe('4 32');
		expect(formatSpeech('fourteen twenty')).toBe('14 20');
		expect(formatSpeech('ファイブ ナイン')).toBe('5 9');
	});

	it('shows one label per command keyword', () => {
		expect(formatSpeech('call sign juliett lima one hotel india sierra')).toBe('CALL J L 1 H I S');
		expect(formatSpeech('receiving five seven')).toBe('RCVD 5 7');
		expect(formatSpeech('受信 ファイブ セブン 送信 ファイブ ナイン')).toBe('RCVD 5 7 SENT 5 9');
		expect(formatSpeech('j c x one zero zero one')).toBe('JCC/JCG 1 0 0 1');
		expect(formatSpeech('card one way')).toBe('QSL ONE WAY');
		expect(formatSpeech('カード リクエスト')).toBe('QSL REQUESTED');
	});

	it('shows frequencies, strokes and modes', () => {
		expect(formatSpeech('周波数 フォー スリー ツー ポイント ナイン フォー メガヘルツ')).toBe(
			'FREQ 4 3 2 . 9 4 MHz'
		);
		expect(formatSpeech('jl1his/p')).toBe('J L 1 H I S / P');
		expect(formatSpeech('juliett alpha one zulu portable')).toBe('J A 1 Z portable');
		expect(formatSpeech('mode ＦＭ')).toBe('MODE FM');
		expect(formatSpeech('mode foxtrot tango eight')).toBe('MODE F T 8');
	});

	it('keeps words it has no label for', () => {
		expect(formatSpeech('received banana')).toBe('RCVD banana');
		expect(formatSpeech('ゼロ テレビ')).toBe('0 テレビ');
		expect(tokenLabel('constructor')).toBe('constructor');
		expect(formatTokens([])).toBe('');
	});
});
