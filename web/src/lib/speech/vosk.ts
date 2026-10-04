import type { Model } from 'vosk-browser';
import type { KaldiRecognizer } from 'vosk-browser/dist/model';
import type { RecognizerMessage } from 'vosk-browser/dist/interfaces';
import { grammarPhrases, type SpeechLanguage } from '../dsl';
import { ASR_SAMPLE_RATE, type SpeechRecognizer, type SpeechResult } from './recognizer';

export interface VoskOptions {
	/** URL of a `.tar.gz` model archive (a single top-level directory). */
	modelUrl: string;
	/** Language of the model, which decides how the grammar is spelled. */
	language: SpeechLanguage;
}

type Word = { text: string; confidence: number };

/**
 * Vosk (Kaldi) running as WASM inside a Web Worker via `vosk-browser`.
 *
 * The model archive is downloaded once and persisted in IndexedDB by vosk-browser, so the
 * recogniser keeps working offline afterwards.
 */
export class VoskRecognizer implements SpeechRecognizer {
	readonly name = 'Vosk';
	readonly needsAudio = true;
	onPartial?: (text: string) => void;

	#model: Model | null = null;
	#recognizer: KaldiRecognizer | null = null;

	// The worker answers every request (audio chunk or final-result request) with exactly one
	// message, in order. Tagging each request with the utterance it belongs to lets late
	// responses of a cancelled utterance be dropped instead of leaking into the next one.
	#generation = 0;
	#inFlight: { generation: number; final: boolean }[] = [];
	#segments: string[] = [];
	#words: Word[] = [];
	#error: string | null = null;
	#finish: {
		generation: number;
		resolve: (r: SpeechResult) => void;
		reject: (e: Error) => void;
	} | null = null;

	constructor(readonly options: VoskOptions) {}

	async initialize(): Promise<void> {
		if (this.#model !== null) return;
		const { createModel } = await import('vosk-browser');
		const model = await createModel(this.options.modelUrl);
		const grammar = JSON.stringify(grammarPhrases(this.options.language));
		const recognizer = new model.KaldiRecognizer(ASR_SAMPLE_RATE, grammar);
		recognizer.setWords(true);
		recognizer.on('result', (m) => this.#handle(m));
		recognizer.on('partialresult', (m) => this.#handle(m));
		recognizer.on('error', (m) => this.#handle(m));
		this.#model = model;
		this.#recognizer = recognizer;
	}

	#handle(message: RecognizerMessage) {
		const tag = this.#inFlight.shift();
		if (tag === undefined || tag.generation !== this.#generation) return;

		switch (message.event) {
			case 'partialresult':
				if (message.result.partial !== '') {
					this.onPartial?.([...this.#segments, message.result.partial].join(' '));
				}
				break;
			case 'result':
				// Vosk may finalise a segment mid-utterance (endpointing on a pause), so collect
				// every segment and join them at the end.
				if (message.result.text !== '') this.#segments.push(message.result.text);
				for (const w of message.result.result ?? []) {
					this.#words.push({ text: w.word, confidence: w.conf });
				}
				break;
			case 'error':
				this.#error ??= message.error;
				break;
		}

		const finish = this.#finish;
		if (tag.final && finish !== null && finish.generation === tag.generation) {
			this.#finish = null;
			if (this.#error !== null) finish.reject(new Error(this.#error));
			else finish.resolve({ text: this.#segments.join(' '), words: this.#words });
		}
	}

	#request(final: boolean) {
		this.#inFlight.push({ generation: this.#generation, final });
	}

	beginUtterance(): void {
		this.#generation += 1;
		this.#segments = [];
		this.#words = [];
		this.#error = null;
	}

	pushAudio(samples: Float32Array): void {
		if (this.#recognizer === null) return;
		this.#request(false);
		this.#recognizer.acceptWaveformFloat(samples, ASR_SAMPLE_RATE);
	}

	endUtterance(): Promise<SpeechResult> {
		const recognizer = this.#recognizer;
		if (recognizer === null) return Promise.reject(new Error('Vosk is not initialized'));
		return new Promise((resolve, reject) => {
			this.#finish = { generation: this.#generation, resolve, reject };
			this.#request(true);
			recognizer.retrieveFinalResult();
		});
	}

	cancelUtterance(): void {
		if (this.#recognizer === null) return;
		// Flush the recogniser so the next utterance starts clean, and drop whatever it returns.
		this.#request(true);
		this.#recognizer.retrieveFinalResult();
		this.#finish?.reject(new Error('cancelled'));
		this.#finish = null;
		this.#generation += 1;
	}

	dispose(): void {
		this.#recognizer?.remove();
		this.#model?.terminate();
		this.#recognizer = null;
		this.#model = null;
	}
}
