import { describe, expect, it } from 'vitest';
import { isCallsign, parseSpeech, type SpokenUpdate } from './parser';

function updates(text: string): SpokenUpdate[] {
	const result = parseSpeech(text);
	if (!result.ok) throw new Error(`expected "${text}" to parse, got: ${result.error}`);
	return result.updates;
}

function single(text: string): SpokenUpdate {
	const list = updates(text);
	expect(list).toHaveLength(1);
	return list[0];
}

function error(text: string): string {
	const result = parseSpeech(text);
	if (result.ok)
		throw new Error(`expected "${text}" to fail, got ${JSON.stringify(result.updates)}`);
	return result.error;
}

describe('callsign', () => {
	it('converts phonetic alphabet and digits', () => {
		expect(single('juliett lima one hotel india sierra')).toEqual({
			kind: 'callsign',
			value: 'JL1HIS'
		});
	});

	it('accepts spelling variants produced by ASR', () => {
		expect(single('juliet alfa one x-ray yankee whisky')).toEqual({
			kind: 'callsign',
			value: 'JA1XYW'
		});
		expect(single('seven kilo four x ray yankee zulu')).toEqual({
			kind: 'callsign',
			value: '7K4XYZ'
		});
	});

	it('accepts an explicit callsign keyword', () => {
		expect(single('call sign juliett lima one hotel india tango')).toEqual({
			kind: 'callsign',
			value: 'JL1HIT'
		});
		expect(single('callsign juliett romeo one alpha bravo charlie').kind).toBe('callsign');
	});

	it('supports stroke and portable suffixes', () => {
		expect(single('juliett lima one hotel india sierra stroke one')).toEqual({
			kind: 'callsign',
			value: 'JL1HIS/1'
		});
		expect(single('juliett lima one hotel india sierra portable')).toEqual({
			kind: 'callsign',
			value: 'JL1HIS/P'
		});
	});

	it('accepts typed callsigns', () => {
		expect(single('JL1HIS')).toEqual({ kind: 'callsign', value: 'JL1HIS' });
		expect(single('ja1jcx')).toEqual({ kind: 'callsign', value: 'JA1JCX' });
	});

	it('rejects garbage', () => {
		expect(error('hello world')).toMatch(/unexpected "hello"/);
		expect(error('juliett lima hotel')).toMatch(/not a valid callsign/);
		expect(error('one two three')).toMatch(/not a valid callsign/);
		expect(error('juliett lima one hotel india sierra stroke')).toMatch(/not a valid callsign/);
	});
});

describe('isCallsign', () => {
	it('matches the server rule', () => {
		for (const ok of ['JL1HIS', 'JL1HIS/1', 'JL1HIS/P', '7K4XYZ', 'JA1XYW/QRP']) {
			expect(isCallsign(ok), ok).toBe(true);
		}
		for (const bad of ['', 'JL', 'JLHIS', '12345', 'jl1his', 'JL1HIS/', '/JL1HIS', 'JL1//P']) {
			expect(isCallsign(bad), bad).toBe(false);
		}
	});
});

describe('RST', () => {
	it('parses sent and received', () => {
		expect(single('sent five nine')).toEqual({ kind: 'rstSent', value: '59' });
		expect(single('received five seven')).toEqual({ kind: 'rstReceived', value: '57' });
	});

	it('accepts synonyms', () => {
		expect(single('send five five')).toEqual({ kind: 'rstSent', value: '55' });
		expect(single('receive four four')).toEqual({ kind: 'rstReceived', value: '44' });
	});

	it('accepts two-digit number words and CW three-digit reports', () => {
		expect(single('received fifty seven')).toEqual({ kind: 'rstReceived', value: '57' });
		expect(single('sent five nine nine')).toEqual({ kind: 'rstSent', value: '599' });
	});

	it('rejects invalid reports', () => {
		expect(error('sent')).toMatch(/RST is empty/);
		expect(error('sent six nine')).toMatch(/not a valid RST/);
		expect(error('sent five zero')).toMatch(/not a valid RST/);
		expect(error('received five nine plus')).toMatch(/unexpected "plus"/);
	});
});

describe('frequency', () => {
	it('parses partial frequency patterns', () => {
		expect(single('frequency point nine four')).toEqual({
			kind: 'frequency',
			value: { integerDigits: '', fractionDigits: '94' }
		});
		expect(single('frequency two point seven four')).toEqual({
			kind: 'frequency',
			value: { integerDigits: '2', fractionDigits: '74' }
		});
		expect(single('frequency thirty two point nine four')).toEqual({
			kind: 'frequency',
			value: { integerDigits: '32', fractionDigits: '94' }
		});
		expect(single('frequency four thirty two point nine four')).toEqual({
			kind: 'frequency',
			value: { integerDigits: '432', fractionDigits: '94' }
		});
	});

	it('accepts an integer-only frequency and a trailing unit', () => {
		expect(single('frequency one forty five megahertz')).toEqual({
			kind: 'frequency',
			value: { integerDigits: '145', fractionDigits: '' }
		});
	});

	it('accepts typed numerals', () => {
		expect(single('freq 432.94')).toEqual({
			kind: 'frequency',
			value: { integerDigits: '432', fractionDigits: '94' }
		});
	});

	it('rejects malformed frequencies', () => {
		expect(error('frequency')).toMatch(/frequency is empty/);
		expect(error('frequency four point')).toMatch(/digits after "point"/);
		expect(error('frequency four point two point five')).toMatch(/unexpected "point"/);
		expect(error('frequency point one two three four five six seven')).toMatch(/too many digits/);
	});
});

describe('JCX', () => {
	it('keeps the code as a string with leading zeros', () => {
		expect(single('jcx one zero zero one zero one')).toEqual({ kind: 'jcx', value: '100101' });
		expect(single('j c x zero one zero zero eight')).toEqual({ kind: 'jcx', value: '01008' });
		expect(single('jay see ex one zero zero one')).toEqual({ kind: 'jcx', value: '1001' });
	});

	it('accepts JCC/JCG keywords and letter suffixes', () => {
		expect(single('jcg one zero zero zero one alpha')).toEqual({ kind: 'jcx', value: '10001A' });
		expect(single('jcc one zero zero one')).toEqual({ kind: 'jcx', value: '1001' });
	});

	it('rejects invalid codes', () => {
		expect(error('jcx one two')).toMatch(/not a valid JCC\/JCG/);
		expect(error('jcx')).toMatch(/not a valid JCC\/JCG/);
	});
});

describe('QSL', () => {
	it('parses card requested', () => {
		expect(single('card requested')).toEqual({ kind: 'qslRequested', value: true });
		expect(single('card')).toEqual({ kind: 'qslRequested', value: true });
		expect(single('qsl please')).toEqual({ kind: 'qslRequested', value: true });
		expect(single('q s l requested')).toEqual({ kind: 'qslRequested', value: true });
	});

	it('parses negations', () => {
		expect(single('no card')).toEqual({ kind: 'qslRequested', value: false });
		expect(single('card not requested')).toEqual({ kind: 'qslRequested', value: false });
		expect(single('card cancel')).toEqual({ kind: 'qslRequested', value: false });
	});

	it('rejects garbage after card', () => {
		expect(error('card five')).toMatch(/after "card"/);
	});
});

describe('mode', () => {
	it('parses mode words and spelled modes', () => {
		expect(single('mode fm')).toEqual({ kind: 'mode', value: 'FM' });
		expect(single('mode foxtrot mike')).toEqual({ kind: 'mode', value: 'FM' });
		expect(single('mode sierra sierra bravo')).toEqual({ kind: 'mode', value: 'SSB' });
		expect(single('mode foxtrot tango eight')).toEqual({ kind: 'mode', value: 'FT8' });
	});

	it('rejects unknown modes', () => {
		expect(error('mode alpha bravo')).toMatch(/unknown mode "AB"/);
	});

	it('does not treat inherited object properties as words', () => {
		expect(error('mode constructor')).toMatch(/unexpected "constructor"/);
		expect(error('received valueOf')).toMatch(/unexpected "valueof"/);
		expect(error('toString')).toMatch(/unexpected "tostring"/);
	});
});

describe('utterances', () => {
	it('chains several commands in one utterance', () => {
		expect(
			updates('juliett lima one hotel india sierra received five seven card requested')
		).toEqual([
			{ kind: 'callsign', value: 'JL1HIS' },
			{ kind: 'rstReceived', value: '57' },
			{ kind: 'qslRequested', value: true }
		]);
	});

	it('is all-or-nothing', () => {
		expect(error('received five seven sent banana')).toMatch(/unexpected "banana"/);
	});

	it('ignores fillers', () => {
		expect(single('uh received um five seven')).toEqual({ kind: 'rstReceived', value: '57' });
	});

	it('reports empty input', () => {
		expect(error('')).toMatch(/nothing recognized/);
		expect(error('[unk]')).toMatch(/nothing recognized/);
	});
});
