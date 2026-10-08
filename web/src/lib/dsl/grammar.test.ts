import { describe, expect, it } from 'vitest';
import { grammarPhrases, grammarSequences } from './grammar';
import { FREE_TEXT_ONLY_WORDS, type SpeechLanguage } from './lexicon';
import { parseSpeech } from './parser';

function analyse(language: SpeechLanguage) {
    const phrases = grammarPhrases(language);
    const words = phrases.map((p) => p.split(' '));
    const bigrams = new Set<string>();
    for (const w of words)
        for (let i = 0; i + 1 < w.length; i++) bigrams.add(`${w[i]} ${w[i + 1]}`);
    return {
        phrases,
        words,
        starts: new Set(words.map((w) => w[0])),
        ends: new Set(words.map((w) => w[w.length - 1])),
        bigrams
    };
}

/** Checks that the grammar lets a recogniser emit `sample`, and that the parser accepts it. */
function expectCovered(grammar: ReturnType<typeof analyse>, sample: string) {
    expect(parseSpeech(sample).ok, sample).toBe(true);
    const w = sample.split(' ');
    expect(grammar.starts, sample).toContain(w[0]);
    expect(grammar.ends, sample).toContain(w[w.length - 1]);
    for (let i = 0; i + 1 < w.length; i++) {
        expect(grammar.bigrams, sample).toContain(`${w[i]} ${w[i + 1]}`);
    }
}

const english = analyse('en');
const { phrases, words, starts, ends, bigrams } = english;

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
            'qsl requested',
            'card requested',
            'card one way',
            'card negative',
            'q s l negative',
            'juliet lima one hotel india sierra card one way',
            'mode fm',
            'mode foxtrot mike',
            'mode foxtrot tango eight',
            'juliet lima one hotel india sierra received five nine sent five nine card requested mode fm frequency four three two point nine four'
        ];
        for (const sample of samples) expectCovered(english, sample);
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
        expect(starts).not.toContain('negative');
        expect(ends).not.toContain('card');
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

describe('grammarPhrases for a Japanese model', () => {
    const japanese = analyse('ja');

    it('covers every transition of real utterances in Japanese', () => {
        const samples = [
            'ジュリエット リマ ワン ホテル インディア シエラ',
            'コールサイン ジュリエット アルファ ワン ズール リマ オスカー ポータブル ワン',
            'コール セブン キロ フォー Ｘ ヤンキー ズール ストローク ワン',
            'Ｊ Ａ ワン Ｎ Ｌ Ｏ',
            'ジュリエット アルファ ワン ＮＯＶＥＭＢＥＲ リマ オスカー',
            'セブン キロ ワン Ｘ－ｒａｙ ヤンキー ズール',
            '周波数 ＦＯＲＴＹ ファイブ ポイント ゼロ',
            'ジュリエット Ｆ ワン Ｎ ゴルフ スラッシュ Ｐ',
            '受信 ファイブ ナイン 送信 ファイブ セブン',
            '送信 ファイブ ダブル ナイン',
            '周波数 フォー サーティー ツー ポイント ナイン フォー メガヘルツ',
            '周波数 ポイント ゼロ ファイブ',
            'Ｊ Ｃ Ｘ ワン ゼロ ゼロ ワン ゼロ ワン',
            'ＪＣＧ ワン ワン ゼロ ゼロ ワン ゴルフ',
            'Ｊ Ｃ Ｃ ワン ゼロ ゼロ ワン',
            '周波数 エイ ティーン ポイント ワン',
            '周波数 ワン シックス ティ ポイント ワン',
            '送信 シックス ティーン',
            'カード リクエスト',
            'カード ワンウェイ',
            'カード ネガティブ',
            'Ｑ Ｓ Ｌ リクエスト',
            'モード ＦＭ',
            'モード Ｒ Ｔ Ｔ Ｙ',
            'モード フォックス トロット タンゴ エイト',
            'ジュリエット リマ ワン ホテル インディア シエラ 受信 ファイブ ナイン カード ネガティブ モード ＦＭ 周波数 ポイント ナイン フォー'
        ];
        for (const sample of samples) expectCovered(japanese, sample);
    });

    it('is spelled in Japanese only', () => {
        for (const word of new Set(japanese.words.flat())) {
            if (word !== '[unk]') {
                expect(word).toMatch(/^[\p{Script=Katakana}\p{Script=Han}ーＡ-Ｚａ-ｚ０-９－]+$/u);
            }
        }
    });

    it('keeps a reading for every word class', () => {
        for (const [slot, sequences] of Object.entries(grammarSequences('ja'))) {
            expect(sequences.length, slot).toBeGreaterThan(0);
        }
    });

    it('does not allow transitions the DSL has no use for', () => {
        expect(japanese.bigrams).not.toContain('受信 アルファ');
        expect(japanese.bigrams).not.toContain('周波数 アルファ');
        expect(japanese.bigrams).not.toContain('ポイント アルファ');
        expect(japanese.bigrams).not.toContain('カード ファイブ');
        expect(japanese.starts).not.toContain('ネガティブ');
    });

    it('stays small enough to compile when the engine loads', () => {
        expect(japanese.phrases.length).toBeLessThan(20_000);
        expect(new Set(japanese.phrases).size).toBe(japanese.phrases.length);
    });
});
