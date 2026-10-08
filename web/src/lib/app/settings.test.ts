import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, mergeSettings, speechLanguageFor } from './settings';

describe('mergeSettings', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('returns defaults when nothing is stored', () => {
        expect(mergeSettings(undefined)).toEqual(defaultSettings());
    });

    it('keeps stored values and fills in missing ones', () => {
        const merged = mergeSettings({ releaseTailMs: 500 });
        expect(merged.releaseTailMs).toBe(500);
        expect(merged.keepScreenOn).toBe(true);
    });

    it('drops the backend settings of older versions', () => {
        const stored = { releaseTailMs: 500, sync: { endpoint: 'https://x', token: 'secret' } };
        expect(mergeSettings(stored as never)).not.toHaveProperty('sync');
    });

    it('drops the custom model URL of older versions', () => {
        const stored = { voskModelUrl: 'https://example.com/model.tar.gz' };
        expect(mergeSettings(stored as never)).not.toHaveProperty('voskModelUrl');
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
