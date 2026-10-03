import type { Model } from 'vosk-browser';
import type { KaldiRecognizer } from 'vosk-browser/dist/model';
import type { RecognizerMessage } from 'vosk-browser/dist/interfaces';
import { grammarVocabulary } from '../dsl';
import { ASR_SAMPLE_RATE, type SpeechRecognizer, type SpeechResult } from './recognizer';

export interface VoskOptions {
	/** URL of a `.tar.gz` model archive (a single top-level directory). */
	modelUrl: string;
	/** Restrict recognition to the DSL vocabulary. */
	useGrammar: boolean;
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

	// Per-utterance state. Each pushed chunk and the final request yield exactly one response
	// from the worker, so counting outstanding responses tells us when the final one arrives.
	#outstanding = 0;
	#segments: string[] = [];
	#words: Word[] = [];
	#discard = false;
	#finish: { resolve: (r: SpeechResult) => void; reject: (e: Error) => void } | null = null;

	constructor(readonly options: VoskOptions) {}

	async initialize(): Promise<void> {
		if (this.#model !== null) return;
		const { createModel } = await import('vosk-browser');
		const model = await createModel(this.options.modelUrl);
		const grammar = this.options.useGrammar ? JSON.stringify(grammarVocabulary()) : undefined;
		const recognizer = new model.KaldiRecognizer(ASR_SAMPLE_RATE, grammar);
		recognizer.setWords(true);
		recognizer.on('result', (m) => this.#handle(m));
		recognizer.on('partialresult', (m) => this.#handle(m));
		recognizer.on('error', (m) => this.#handle(m));
		this.#model = model;
		this.#recognizer = recognizer;
	}

	#handle(message: RecognizerMessage) {
		this.#outstanding = Math.max(0, this.#outstanding - 1);
		switch (message.event) {
			case 'partialresult':
				if (!this.#discard && message.result.partial !== '') {
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
				if (this.#finish !== null) {
					this.#finish.reject(new Error(message.error));
					this.#finish = null;
				}
				return;
		}
		if (this.#finish !== null && this.#outstanding === 0) {
			const result: SpeechResult = { text: this.#segments.join(' '), words: this.#words };
			const finish = this.#finish;
			this.#finish = null;
			if (this.#discard) finish.reject(new Error('cancelled'));
			else finish.resolve(result);
		}
	}

	beginUtterance(): void {
		this.#segments = [];
		this.#words = [];
		this.#discard = false;
	}

	pushAudio(samples: Float32Array): void {
		if (this.#recognizer === null) return;
		this.#outstanding += 1;
		this.#recognizer.acceptWaveformFloat(samples, ASR_SAMPLE_RATE);
	}

	endUtterance(): Promise<SpeechResult> {
		const recognizer = this.#recognizer;
		if (recognizer === null) return Promise.reject(new Error('Vosk is not initialized'));
		return new Promise((resolve, reject) => {
			this.#finish = { resolve, reject };
			this.#outstanding += 1;
			recognizer.retrieveFinalResult();
		});
	}

	cancelUtterance(): void {
		this.#discard = true;
		// Flush the recogniser so the next utterance starts clean; the result is dropped.
		this.endUtterance().catch(() => {});
	}

	dispose(): void {
		this.#recognizer?.remove();
		this.#model?.terminate();
		this.#recognizer = null;
		this.#model = null;
	}
}
