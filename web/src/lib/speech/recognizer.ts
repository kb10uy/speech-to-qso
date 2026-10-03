/** Result of one PTT utterance. */
export interface SpeechResult {
	text: string;
	words?: {
		text: string;
		confidence: number;
	}[];
}

/**
 * Abstraction over ASR engines (Vosk, Web Speech API, sherpa-onnx, server-side ASR, ...).
 *
 * The app calls `beginUtterance` on PTT press, streams 16 kHz mono PCM through `pushAudio`
 * while the button is held, and calls `endUtterance` on release.
 */
export interface SpeechRecognizer {
	/** Engine name for display. */
	readonly name: string;
	/**
	 * Whether the engine consumes PCM from `pushAudio`. Engines that capture the microphone
	 * themselves (like the Web Speech API) set this to false.
	 */
	readonly needsAudio: boolean;

	initialize(): Promise<void>;
	beginUtterance(): void;
	pushAudio(samples: Float32Array): void;
	endUtterance(): Promise<SpeechResult>;
	/** Discards the current utterance. */
	cancelUtterance(): void;

	/** Called with interim hypotheses while the user is speaking. */
	onPartial?: (text: string) => void;

	dispose(): void;
}

/** Sample rate of the PCM passed to `pushAudio`. */
export const ASR_SAMPLE_RATE = 16_000;
