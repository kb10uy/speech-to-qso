import { describe, expect, it, vi } from 'vitest';
import { withTimeout } from './timeout';

describe('withTimeout', () => {
	it('passes a settled value through', async () => {
		await expect(withTimeout(Promise.resolve(1), 10, 'late')).resolves.toBe(1);
		await expect(withTimeout(Promise.reject(new Error('no')), 10, 'late')).rejects.toThrow('no');
	});

	it('rejects with the message when the promise hangs', async () => {
		vi.useFakeTimers();
		try {
			const pending = withTimeout(new Promise<never>(() => {}), 1000, 'late');
			const result = expect(pending).rejects.toThrow('late');
			await vi.advanceTimersByTimeAsync(1000);
			await result;
		} finally {
			vi.useRealTimers();
		}
	});
});
