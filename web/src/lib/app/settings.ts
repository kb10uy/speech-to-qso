import type { SpeechLanguage } from '../dsl';
import type { SyncSettings } from '../sync/client';

export type AsrEngine = 'vosk' | 'webspeech';

export interface AppSettings {
	asrEngine: AsrEngine;
	/** Language of the Vosk model; picks the bundled model and how the grammar is spelled. */
	voskLanguage: SpeechLanguage;
	/** Vosk model archive URL. Empty means the model deployed with the app for `voskLanguage`. */
	voskModelUrl: string;
	/** Constrain Vosk to the DSL vocabulary. */
	voskGrammar: boolean;
	/** Load the speech engine on startup (set after the first successful load). */
	autoLoadAsr: boolean;
	/** Keep capturing for this long after PTT release, so the last word is not clipped. */
	releaseTailMs: number;
	/** Request a screen wake lock while the app is visible. */
	keepScreenOn: boolean;
	sync: SyncSettings;
}

/** Models deployed with the app. Keep in sync with `VOSK_MODEL_*` in `.github/workflows/pages.yml`. */
export const DEFAULT_MODEL_PATHS: Readonly<Record<SpeechLanguage, string>> = {
	en: 'models/vosk-model-small-en-us-0.15.tar.gz',
	ja: 'models/vosk-model-small-ja-0.22.tar.gz'
};

export function defaultSettings(): AppSettings {
	return {
		asrEngine: 'vosk',
		voskLanguage: 'en',
		voskModelUrl: '',
		voskGrammar: true,
		autoLoadAsr: false,
		releaseTailMs: 300,
		keepScreenOn: true,
		sync: { endpoint: '', token: '' }
	};
}

/** Fills in fields added in newer versions when loading stored settings. */
export function mergeSettings(stored: Partial<AppSettings> | undefined): AppSettings {
	const defaults = defaultSettings();
	return { ...defaults, ...stored, sync: { ...defaults.sync, ...stored?.sync } };
}
