import type { SpeechRecognizer, SpeechResult } from './recognizer';

// The Web Speech API is not in TypeScript's DOM lib yet; declare the subset we use.
interface WebSpeechAlternative {
	transcript: string;
	confidence: number;
}
interface WebSpeechResultEvent extends Event {
	results: ArrayLike<ArrayLike<WebSpeechAlternative> & { isFinal: boolean }>;
}
interface WebSpeechErrorEvent extends Event {
	error: string;
}
interface WebSpeech extends EventTarget {
	lang: string;
	continuous: boolean;
	interimResults: boolean;
	maxAlternatives: number;
	start(): void;
	stop(): void;
	abort(): void;
	onresult: ((e: WebSpeechResultEvent) => void) | null;
	onerror: ((e: WebSpeechErrorEvent) => void) | null;
	onend: (() => void) | null;
}
type WebSpeechCtor = new () => WebSpeech;

function speechConstructor(): WebSpeechCtor | undefined {
	const w = globalThis as unknown as {
		SpeechRecognition?: WebSpeechCtor;
		webkitSpeechRecognition?: WebSpeechCtor;
	};
	return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export function isWebSpeechAvailable(): boolean {
	return speechConstructor() !== undefined;
}

/**
 * Browser-provided ASR (Web Speech API). Usually needs network access, but needs no model
 * download; useful as a fallback and for comparison with Vosk.
 */
export class WebSpeechRecognizer implements SpeechRecognizer {
	readonly name = 'Web Speech API';
	readonly needsAudio = false;
	onPartial?: (text: string) => void;

	#current: WebSpeech | null = null;
	#finals: string[] = [];
	#words: { text: string; confidence: number }[] = [];
	#error: string | null = null;
	#ended: Promise<void> = Promise.resolve();

	async initialize(): Promise<void> {
		if (!isWebSpeechAvailable()) throw new Error('Web Speech API is not available in this browser');
	}

	beginUtterance(): void {
		const Ctor = speechConstructor()!;
		const rec = new Ctor();
		rec.lang = 'en-US';
		rec.continuous = true;
		rec.interimResults = true;
		rec.maxAlternatives = 1;
		this.#finals = [];
		this.#words = [];
		this.#error = null;
		rec.onresult = (e) => {
			const finals: string[] = [];
			const words: { text: string; confidence: number }[] = [];
			let interim = '';
			for (let i = 0; i < e.results.length; i++) {
				const alt = e.results[i][0];
				if (e.results[i].isFinal) {
					finals.push(alt.transcript.trim());
					words.push({ text: alt.transcript.trim(), confidence: alt.confidence });
				} else {
					interim += alt.transcript;
				}
			}
			this.#finals = finals;
			this.#words = words;
			this.onPartial?.([...finals, interim.trim()].filter((s) => s !== '').join(' '));
		};
		rec.onerror = (e) => {
			if (e.error !== 'no-speech' && e.error !== 'aborted') this.#error = e.error;
		};
		this.#ended = new Promise((resolve) => (rec.onend = () => resolve()));
		this.#current = rec;
		rec.start();
	}

	pushAudio(): void {}

	async endUtterance(): Promise<SpeechResult> {
		const rec = this.#current;
		if (rec === null) throw new Error('no utterance in progress');
		rec.stop();
		await this.#ended;
		this.#current = null;
		if (this.#error !== null) throw new Error(`speech recognition error: ${this.#error}`);
		return { text: this.#finals.join(' '), words: this.#words };
	}

	cancelUtterance(): void {
		this.#current?.abort();
		this.#current = null;
	}

	dispose(): void {
		this.cancelUtterance();
	}
}
