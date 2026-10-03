/**
 * Frequency resolution for partially spoken frequencies.
 *
 * Only the digits that were actually spoken are constraints; omitted higher-order digits of
 * the MHz part are wildcards. Among all frequencies matching the pattern, the one nearest to
 * the frequency anchor is chosen:
 *
 *     anchor 433.000 MHz, "frequency point nine four"     → *.940  → 432.940 MHz
 *     anchor 433.000 MHz, "frequency two point seven four" → *2.740 → 432.740 MHz
 *
 * This module is pure and independent from ASR.
 */

/** A spoken frequency in MHz, kept as digit strings to preserve the number of spoken digits. */
export interface FrequencyPattern {
	/** Spoken low-order digits of the integer MHz part. Empty if only `point ...` was spoken. */
	integerDigits: string;
	/** Spoken digits after the decimal point (MHz fraction). */
	fractionDigits: string;
}

export interface FrequencyContext {
	/** Frequency that partially spoken frequencies are snapped towards. */
	anchorHz: number;
	/** Frequency currently in use (informational; resolution never depends on it). */
	currentHz?: number;
}

const HZ_PER_MHZ = 1_000_000;
export const MAX_INTEGER_DIGITS = 5;
export const MAX_FRACTION_DIGITS = 6;

/** Renders a pattern with wildcards, e.g. `*2.74` or `*.94`. */
export function formatFrequencyPattern(pattern: FrequencyPattern): string {
	const fraction = pattern.fractionDigits === '' ? '' : `.${pattern.fractionDigits}`;
	return `*${pattern.integerDigits}${fraction}`;
}

/** Resolves a spoken frequency pattern to the matching frequency (Hz) nearest to the anchor. */
export function resolveFrequency(pattern: FrequencyPattern, context: FrequencyContext): number {
	const { integerDigits, fractionDigits } = pattern;
	if (!/^\d*$/.test(integerDigits) || !/^\d*$/.test(fractionDigits)) {
		throw new RangeError('frequency pattern must only contain digits');
	}
	if (integerDigits.length > MAX_INTEGER_DIGITS || fractionDigits.length > MAX_FRACTION_DIGITS) {
		throw new RangeError('frequency pattern has too many digits');
	}
	if (!Number.isFinite(context.anchorHz) || context.anchorHz <= 0) {
		throw new RangeError('frequency anchor must be a positive number');
	}

	// All candidates are `offset + n * step` for integer n.
	const step = 10 ** integerDigits.length * HZ_PER_MHZ;
	const integerHz = integerDigits === '' ? 0 : Number(integerDigits) * HZ_PER_MHZ;
	const fractionHz =
		fractionDigits === '' ? 0 : Number(fractionDigits.padEnd(MAX_FRACTION_DIGITS, '0'));
	const offset = integerHz + fractionHz;

	let candidate = offset + Math.round((context.anchorHz - offset) / step) * step;
	while (candidate <= 0) candidate += step;
	return candidate;
}
