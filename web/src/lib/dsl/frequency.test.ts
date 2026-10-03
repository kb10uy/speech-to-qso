import { describe, expect, it } from 'vitest';
import { formatFrequencyPattern, resolveFrequency, type FrequencyPattern } from './frequency';

const MHz = (mhz: number) => Math.round(mhz * 1_000_000);
const pattern = (integerDigits: string, fractionDigits = ''): FrequencyPattern => ({
	integerDigits,
	fractionDigits
});

describe('resolveFrequency', () => {
	const ctx = { anchorHz: MHz(433) };

	it('resolves a fraction-only pattern to the nearest candidate', () => {
		// *.940 → 432.940 (433.940 is farther)
		expect(resolveFrequency(pattern('', '94'), ctx)).toBe(MHz(432.94));
	});

	it('treats omitted higher-order digits as wildcards', () => {
		// *2.740 → 432.740
		expect(resolveFrequency(pattern('2', '74'), ctx)).toBe(MHz(432.74));
		// *32.940 → 432.940
		expect(resolveFrequency(pattern('32', '94'), ctx)).toBe(MHz(432.94));
	});

	it('keeps fully specified frequencies', () => {
		expect(resolveFrequency(pattern('432', '94'), ctx)).toBe(MHz(432.94));
		expect(resolveFrequency(pattern('145', '5'), ctx)).toBe(MHz(145.5));
		expect(resolveFrequency(pattern('7', '09'), { anchorHz: MHz(7.1) })).toBe(MHz(7.09));
		expect(resolveFrequency(pattern('1296'), ctx)).toBe(MHz(1296));
	});

	it('does not depend on the current frequency', () => {
		const withCurrent = { anchorHz: MHz(433), currentHz: MHz(430.2) };
		expect(resolveFrequency(pattern('', '94'), withCurrent)).toBe(MHz(432.94));
	});

	it('can move to the next decade when that is nearer', () => {
		// *7.090 near 433 → 437.090 (4.09 MHz away) rather than 427.090 (5.91 MHz away)
		expect(resolveFrequency(pattern('7', '09'), ctx)).toBe(MHz(437.09));
		// *.1 near 433.9 → 434.1
		expect(resolveFrequency(pattern('', '1'), { anchorHz: MHz(433.9) })).toBe(MHz(434.1));
	});

	it('treats a missing fraction as .000', () => {
		expect(resolveFrequency(pattern('5'), { anchorHz: MHz(144.3) })).toBe(MHz(145));
	});

	it('handles leading zeros in the integer part', () => {
		// *02.5 with 100 MHz steps near 433 → 402.5
		expect(resolveFrequency(pattern('02', '5'), ctx)).toBe(MHz(402.5));
	});

	it('keeps up to Hz precision', () => {
		expect(resolveFrequency(pattern('', '123456'), { anchorHz: MHz(7) })).toBe(7_123_456);
	});

	it('never returns a non-positive frequency', () => {
		expect(resolveFrequency(pattern('', '5'), { anchorHz: 100 })).toBe(MHz(0.5));
		expect(resolveFrequency(pattern('9', '0'), { anchorHz: MHz(1) })).toBe(MHz(9));
	});

	it('rejects invalid input', () => {
		expect(() => resolveFrequency(pattern('x'), ctx)).toThrow(RangeError);
		expect(() => resolveFrequency(pattern('123456'), ctx)).toThrow(RangeError);
		expect(() => resolveFrequency(pattern('1'), { anchorHz: 0 })).toThrow(RangeError);
	});
});

describe('formatFrequencyPattern', () => {
	it('renders wildcards', () => {
		expect(formatFrequencyPattern(pattern('', '94'))).toBe('*.94');
		expect(formatFrequencyPattern(pattern('2', '74'))).toBe('*2.74');
		expect(formatFrequencyPattern(pattern('432'))).toBe('*432');
	});
});
