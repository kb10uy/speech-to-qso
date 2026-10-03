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

/**
 * Spellings that only free-text input produces (Web Speech API output, typed text) and that a
 * grammar-constrained recogniser never needs: homophones and alternative spellings of a word
 * that is listed anyway (Vosk emits whichever spelling the grammar contains), text-only
 * abbreviations, and `oh`, a single vowel that stray noise is mistaken for far too easily (the
 * ITU pronunciation of 0 is `zero`). Every extra short word in a grammar is one more thing
 * for breath, rig audio and PTT clicks to decode as, so these stay out of it; the parser keeps
 * accepting them.
 */
export const FREE_TEXT_ONLY_WORDS: ReadonlySet<string> = new Set([
	'alfa',
	'fox',
	'juliett',
	'juliette',
	'whisky',
	'xray',
	'oh',
	'won',
	'to',
	'too',
	'for',
	'ate',
	'fourty',
	'rcvd',
	'jay',
	'see',
	'ex'
]);

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

/**
 * QSL card arrangement for a QSO. `requested`: the other station asked for our card.
 * `oneWay`: the other station sends a card and expects none back.
 */
export type QslStatus = 'none' | 'requested' | 'oneWay';

/**
 * What follows a QSL keyword (`card requested`). Always a value word: a bare `card` would turn
 * any noise after it into a requested card, and `negative` is long and sounds like nothing
 * else in the vocabulary, which `none` (vs. `one way`) does not.
 */
export const QSL_VALUES: readonly { readonly words: readonly string[]; status: QslStatus }[] = [
	{ words: ['requested'], status: 'requested' },
	{ words: ['one', 'way'], status: 'oneWay' },
	{ words: ['negative'], status: 'none' }
];

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
