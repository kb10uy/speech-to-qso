import type { SpeechLanguage } from '../dsl';

export interface AppSettings {
	/** Language of the Vosk model; picks the bundled model and how the grammar is spelled. */
	voskLanguage: SpeechLanguage;
	/** Vosk model archive URL. Empty means the model deployed with the app for `voskLanguage`. */
	voskModelUrl: string;
	/** Load the speech engine on startup (set after the first successful load). */
	autoLoadAsr: boolean;
	/** Keep capturing for this long after PTT release, so the last word is not clipped. */
	releaseTailMs: number;
	/** Request a screen wake lock while the app is visible. */
	keepScreenOn: boolean;
}

/** Models deployed with the app. Keep in sync with `web/scripts/fetch-models.sh`. */
export const DEFAULT_MODEL_PATHS: Readonly<Record<SpeechLanguage, string>> = {
	en: 'models/vosk-model-small-en-us-0.15.tar.gz',
	ja: 'models/vosk-model-small-ja-0.22.tar.gz'
};

/** The model language for a browser language tag (`navigator.language`). */
export function speechLanguageFor(browserLanguage: string | undefined): SpeechLanguage {
	return browserLanguage?.toLowerCase().split('-')[0] === 'ja' ? 'ja' : 'en';
}

export function defaultSettings(): AppSettings {
	return {
		voskLanguage: speechLanguageFor(globalThis.navigator?.language),
		voskModelUrl: '',
		autoLoadAsr: false,
		releaseTailMs: 300,
		keepScreenOn: true
	};
}

/**
 * Fills in fields added in newer versions when loading stored settings, and drops removed ones
 * (`sync`: the backend URL and token from before the app was served by the backend).
 */
export function mergeSettings(stored: Partial<AppSettings> | undefined): AppSettings {
	const { sync: _, ...rest } = (stored ?? {}) as Partial<AppSettings> & { sync?: unknown };
	return { ...defaultSettings(), ...rest };
}
