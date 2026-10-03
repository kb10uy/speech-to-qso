/**
 * Vocabulary of the QSO voice DSL.
 *
 * The ASR is used as a lexer only: every word it may emit (and every spelling variant the
 * model is likely to produce) is listed here, so the parser and the ASR grammar share a
 * single source of truth.
 */

/**
 * Looks a token up in a word table. Only own properties count, so inherited names such as
 * `constructor` or `valueOf` are never mistaken for words.
 */
export function lookup<T>(
	table: Readonly<Record<string, T>>,
	token: string | undefined
): T | undefined {
	return token !== undefined && Object.hasOwn(table, token) ? table[token] : undefined;
}

/** ICAO/ITU phonetic alphabet, including common ASR spelling variants. */
export const PHONETIC_LETTERS: Readonly<Record<string, string>> = {
	alpha: 'A',
	alfa: 'A',
	bravo: 'B',
	charlie: 'C',
	delta: 'D',
	echo: 'E',
	foxtrot: 'F',
	fox: 'F',
	golf: 'G',
	hotel: 'H',
	india: 'I',
	juliett: 'J',
	juliet: 'J',
	juliette: 'J',
	kilo: 'K',
	lima: 'L',
	mike: 'M',
	november: 'N',
	oscar: 'O',
	papa: 'P',
	quebec: 'Q',
	romeo: 'R',
	sierra: 'S',
	tango: 'T',
	uniform: 'U',
	victor: 'V',
	whiskey: 'W',
	whisky: 'W',
	xray: 'X',
	'x-ray': 'X',
	yankee: 'Y',
	zulu: 'Z'
};

/** Words for a single decimal digit (including radio-style pronunciations and homophones). */
export const DIGIT_WORDS: Readonly<Record<string, string>> = {
	zero: '0',
	oh: '0',
	one: '1',
	won: '1',
	two: '2',
	to: '2',
	too: '2',
	three: '3',
	tree: '3',
	four: '4',
	for: '4',
	fower: '4',
	five: '5',
	fife: '5',
	six: '6',
	seven: '7',
	eight: '8',
	ate: '8',
	nine: '9',
	niner: '9'
};

export const TEEN_WORDS: Readonly<Record<string, string>> = {
	ten: '10',
	eleven: '11',
	twelve: '12',
	thirteen: '13',
	fourteen: '14',
	fifteen: '15',
	sixteen: '16',
	seventeen: '17',
	eighteen: '18',
	nineteen: '19'
};

export const TENS_WORDS: Readonly<Record<string, string>> = {
	twenty: '2',
	thirty: '3',
	forty: '4',
	fourty: '4',
	fifty: '5',
	sixty: '6',
	seventy: '7',
	eighty: '8',
	ninety: '9'
};

export const HUNDRED_WORDS = ['hundred'] as const;
export const REPEAT_WORDS: Readonly<Record<string, number>> = { double: 2, triple: 3 };
export const POINT_WORDS = ['point', 'decimal', 'dot'] as const;
export const MEGAHERTZ_WORDS = ['megahertz', 'mhz', 'meg', 'megs'] as const;
export const STROKE_WORDS = ['stroke', 'slash'] as const;
/** Callsign suffix words that expand to a full `/X` suffix. */
export const SUFFIX_WORDS: Readonly<Record<string, string>> = { portable: '/P', mobile: '/M' };

/** Words that are ignored anywhere in an utterance. */
export const FILLER_WORDS = ['the', 'uh', 'um', 'er', 'ah', 'and', 'is', '[unk]'] as const;

/** Command keywords. Each entry is a token sequence that starts a command segment. */
export const COMMAND_KEYWORDS = {
	callsign: [['call'], ['callsign'], ['call', 'sign'], ['station']],
	rstSent: [['sent'], ['send'], ['sending']],
	rstReceived: [['received'], ['receive'], ['receiving'], ['rcvd']],
	frequency: [['frequency'], ['frequencies'], ['freq']],
	jcx: [['jcx'], ['j', 'c', 'x'], ['jay', 'see', 'ex'], ['jcc'], ['jcg']],
	qsl: [['card'], ['qsl'], ['q', 's', 'l']],
	mode: [['mode']]
} as const satisfies Record<string, readonly (readonly string[])[]>;

export type CommandKind = keyof typeof COMMAND_KEYWORDS;

/** Words following a QSL keyword that mean "requested". */
export const QSL_YES_WORDS = ['requested', 'request', 'please', 'yes', 'wanted'] as const;
/** Words around a QSL keyword that mean "not requested". */
export const QSL_NO_WORDS = ['no', 'none', 'not', 'cancel', 'cancelled', 'canceled'] as const;

/** Mode names that the ASR may emit as a single word. */
export const MODE_WORDS: Readonly<Record<string, string>> = {
	fm: 'FM',
	am: 'AM',
	ssb: 'SSB',
	cw: 'CW',
	usb: 'USB',
	lsb: 'LSB',
	rtty: 'RTTY',
	ft8: 'FT8',
	ft4: 'FT4'
};

/**
 * Word list for grammar-constrained recognisers (e.g. Vosk grammar mode).
 * Words that are missing from a model's vocabulary are simply ignored by Vosk.
 */
export function grammarVocabulary(): string[] {
	const words = new Set<string>();
	const add = (w: string) => words.add(w);
	Object.keys(PHONETIC_LETTERS).forEach(add);
	['x', 'ray'].forEach(add);
	Object.keys(DIGIT_WORDS).forEach(add);
	Object.keys(TEEN_WORDS).forEach(add);
	Object.keys(TENS_WORDS).forEach(add);
	HUNDRED_WORDS.forEach(add);
	Object.keys(REPEAT_WORDS).forEach(add);
	POINT_WORDS.forEach(add);
	MEGAHERTZ_WORDS.forEach(add);
	STROKE_WORDS.forEach(add);
	Object.keys(SUFFIX_WORDS).forEach(add);
	for (const sequences of Object.values(COMMAND_KEYWORDS)) {
		for (const seq of sequences) seq.forEach(add);
	}
	QSL_YES_WORDS.forEach(add);
	QSL_NO_WORDS.forEach(add);
	Object.keys(MODE_WORDS).forEach(add);
	add('[unk]');
	return [...words];
}
