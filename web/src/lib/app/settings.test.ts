import { describe, expect, it } from 'vitest';
import { defaultSettings, mergeSettings } from './settings';

describe('mergeSettings', () => {
	it('returns defaults when nothing is stored', () => {
		expect(mergeSettings(undefined)).toEqual(defaultSettings());
	});

	it('keeps stored values and fills in missing ones', () => {
		const merged = mergeSettings({
			releaseTailMs: 500,
			sync: { endpoint: 'https://x', token: '' }
		});
		expect(merged.releaseTailMs).toBe(500);
		expect(merged.sync.endpoint).toBe('https://x');
		expect(merged.asrEngine).toBe('vosk');
	});
});
