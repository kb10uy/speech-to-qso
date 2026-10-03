import { describe, expect, it } from 'vitest';
import { StreamingResampler, downmix, rms } from './resampler';

function sine(freq: number, rate: number, seconds: number): Float32Array {
	const out = new Float32Array(Math.round(rate * seconds));
	for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / rate);
	return out;
}

function concat(chunks: Float32Array[]): Float32Array {
	const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.length;
	}
	return out;
}

describe('StreamingResampler', () => {
	it('produces the expected number of samples', () => {
		const r = new StreamingResampler(48_000, 16_000);
		const out = r.process(new Float32Array(48_000));
		expect(Math.abs(out.length - 16_000)).toBeLessThanOrEqual(1);

		const r2 = new StreamingResampler(44_100, 16_000);
		const out2 = r2.process(new Float32Array(44_100));
		expect(Math.abs(out2.length - 16_000)).toBeLessThanOrEqual(1);
	});

	it('gives the same result for chunked and one-shot input', () => {
		const input = sine(440, 48_000, 0.5);
		const oneShot = new StreamingResampler(48_000, 16_000).process(input);
		const chunked = new StreamingResampler(48_000, 16_000);
		const parts: Float32Array[] = [];
		for (let i = 0; i < input.length; i += 128)
			parts.push(chunked.process(input.subarray(i, i + 128)));
		const joined = concat(parts);
		expect(joined.length).toBe(oneShot.length);
		for (let i = 0; i < joined.length; i++) expect(joined[i]).toBeCloseTo(oneShot[i], 6);
	});

	it('preserves DC and in-band tones', () => {
		const dc = new StreamingResampler(48_000, 16_000).process(new Float32Array(4800).fill(0.5));
		expect(dc[dc.length - 1]).toBeCloseTo(0.5, 3);

		const tone = new StreamingResampler(48_000, 16_000).process(sine(1_000, 48_000, 0.5));
		// Skip the filter warm-up.
		expect(rms(tone.subarray(100))).toBeCloseTo(Math.SQRT1_2, 1);
	});

	it('attenuates frequencies above the output Nyquist', () => {
		const tone = new StreamingResampler(48_000, 16_000).process(sine(12_000, 48_000, 0.5));
		expect(rms(tone.subarray(100))).toBeLessThan(0.05);
	});

	it('passes through when rates match', () => {
		const input = Float32Array.from([1, 2, 3]);
		expect(new StreamingResampler(16_000, 16_000).process(input)).toEqual(input);
	});

	it('rejects invalid rates', () => {
		expect(() => new StreamingResampler(0, 16_000)).toThrow(RangeError);
	});
});

describe('downmix', () => {
	it('averages channels', () => {
		expect(downmix([Float32Array.from([1, 0]), Float32Array.from([0, 1])])).toEqual(
			Float32Array.from([0.5, 0.5])
		);
	});
});
