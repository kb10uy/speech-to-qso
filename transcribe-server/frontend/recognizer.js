export const SAMPLE_RATE = 16_000;

/** @typedef {{ prompt: string, keywords: string[], languages: string[], provider?: string, boost?: number }} Hints */
/** @typedef {{ text: string, model: string, elapsed_ms: number, request_id: string | null, provider?: string, results?: unknown[] }} Transcript */
/** @typedef {import('../../web/src/lib/speech/recognizer.ts').SpeechRecognizer} SpeechRecognizer */

/** Encodes worklet PCM as 16-bit mono WAV without rewriting the recognized text. */
export function encodeWav(/** @type {Float32Array[]} */ chunks) {
	const count = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const buffer = new ArrayBuffer(44 + count * 2);
	const view = new DataView(buffer);
	const tag = (/** @type {number} */ offset, /** @type {string} */ text) => {
		for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
	};
	tag(0, 'RIFF');
	view.setUint32(4, 36 + count * 2, true);
	tag(8, 'WAVE');
	tag(12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, SAMPLE_RATE, true);
	view.setUint32(28, SAMPLE_RATE * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	tag(36, 'data');
	view.setUint32(40, count * 2, true);
	let offset = 44;
	for (const chunk of chunks) {
		for (const sample of chunk) {
			const clipped = Math.max(-1, Math.min(1, Number.isFinite(sample) ? sample : 0));
			view.setInt16(offset, Math.round(clipped * (clipped < 0 ? 32768 : 32767)), true);
			offset += 2;
		}
	}
	return new Blob([buffer], { type: 'audio/wav' });
}

/** @returns {Promise<Transcript>} */
export async function transcribeFile(/** @type {File} */ file, /** @type {Hints} */ hints) {
	if (!file.size) throw new Error('The audio file is empty.');
	const limit = hints.provider === 'google' ? 10_000_000 : 25_000_000;
	if (file.size > limit) throw new Error(`Choose an audio file up to ${limit / 1_000_000} MB.`);
	if (
		hints.boost !== undefined &&
		(!Number.isFinite(hints.boost) || hints.boost < 0 || hints.boost > 20)
	)
		throw new Error('Phrase boost must be a number from 0 to 20.');
	const form = new FormData();
	form.append('file', file);
	if (hints.provider) form.append('provider', hints.provider);
	if (hints.boost !== undefined) form.append('boost', String(hints.boost));
	if (hints.prompt.trim()) form.append('prompt', hints.prompt.trim());
	for (const keyword of hints.keywords) form.append('keywords[]', keyword);
	for (const language of hints.languages) form.append('languages[]', language);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 65_000);
	try {
		const response = await fetch('/api/transcribe', {
			method: 'POST',
			body: form,
			signal: controller.signal
		});
		const body = await response.text();
		let result;
		try {
			result = JSON.parse(body);
		} catch {
			throw new Error(`Server returned HTTP ${response.status} without a JSON response.`);
		}
		if (!response.ok) {
			const details = [
				result.upstream_status && `upstream HTTP ${result.upstream_status}`,
				result.upstream_code,
				result.request_id
			]
				.filter(Boolean)
				.join(' · ');
			throw new Error(
				`${result.error || `HTTP ${response.status}`}${details ? ` (${details})` : ''}`
			);
		}
		if (typeof result.text !== 'string')
			throw new Error('The server returned an invalid transcript.');
		return result;
	} finally {
		clearTimeout(timer);
	}
}

/** @implements {SpeechRecognizer} */
export class TranscribeRecognizer {
	name = 'Server transcription';
	needsAudio = true;
	/** @type {Float32Array[]} */
	#chunks = [];
	#active = false;
	/** @type {File | null} */
	lastRecording = null;

	constructor(/** @type {() => Hints} */ getHints) {
		this.getHints = getHints;
	}
	async initialize() {}
	beginUtterance() {
		this.#chunks = [];
		this.#active = true;
		this.lastRecording = null;
	}
	pushAudio(/** @type {Float32Array} */ samples) {
		if (this.#active) this.#chunks.push(samples.slice());
	}
	finishRecording() {
		this.#active = false;
		if (!this.#chunks.some((chunk) => chunk.length))
			throw new Error('No audio captured. Hold the button a little longer.');
		this.lastRecording = new File([encodeWav(this.#chunks)], 'utterance.wav', {
			type: 'audio/wav'
		});
		this.#chunks = [];
		return this.lastRecording;
	}
	async endUtterance() {
		return transcribeFile(this.finishRecording(), this.getHints());
	}
	cancelUtterance() {
		this.#active = false;
		this.#chunks = [];
	}
	dispose() {
		this.cancelUtterance();
		this.lastRecording = null;
	}
}
