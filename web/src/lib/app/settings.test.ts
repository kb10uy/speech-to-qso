import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, mergeSettings, speechLanguageFor } from './settings';

describe('mergeSettings', () => {
	afterEach(() => vi.unstubAllGlobals());

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
		expect(merged.keepScreenOn).toBe(true);
	});

	it('keeps a stored model language over the browser language', () => {
		vi.stubGlobal('navigator', { language: 'ja-JP' });
		expect(mergeSettings(undefined).voskLanguage).toBe('ja');
		expect(mergeSettings({ voskLanguage: 'en' }).voskLanguage).toBe('en');
	});
});

describe('speechLanguageFor', () => {
	it('picks the Japanese model for a Japanese browser and English otherwise', () => {
		expect(speechLanguageFor('ja')).toBe('ja');
		expect(speechLanguageFor('ja-JP')).toBe('ja');
		expect(speechLanguageFor('en-US')).toBe('en');
		expect(speechLanguageFor('de-DE')).toBe('en');
		expect(speechLanguageFor(undefined)).toBe('en');
	});
});
