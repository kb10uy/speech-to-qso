import { describe, expect, it } from 'vitest';
import { formatMhz, parseMhz } from './format';

describe('formatMhz', () => {
	it('shows at least kHz precision', () => {
		expect(formatMhz(432_940_000)).toBe('432.940');
		expect(formatMhz(7_000_000)).toBe('7.000');
		expect(formatMhz(7_123_450)).toBe('7.12345');
		expect(formatMhz(7_123_456)).toBe('7.123456');
	});
});

describe('parseMhz', () => {
	it('parses MHz strings without floating point error', () => {
		expect(parseMhz('433')).toBe(433_000_000);
		expect(parseMhz(' 432.94 ')).toBe(432_940_000);
		expect(parseMhz('7.123456')).toBe(7_123_456);
		expect(parseMhz('433.')).toBe(433_000_000);
	});

	it('rejects invalid input', () => {
		expect(parseMhz('')).toBeUndefined();
		expect(parseMhz('abc')).toBeUndefined();
		expect(parseMhz('0')).toBeUndefined();
		expect(parseMhz('1.1234567')).toBeUndefined();
	});
});
