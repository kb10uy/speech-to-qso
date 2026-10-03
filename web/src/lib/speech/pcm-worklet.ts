/**
 * AudioWorklet that turns microphone input into 16 kHz mono PCM chunks.
 *
 * Audio is only forwarded while the PTT is held (between `start` and `stop` messages), so the
 * station receiver audio is not recognised while idle.
 */
import { ASR_SAMPLE_RATE } from './recognizer';
import { StreamingResampler, downmix, rms } from './resampler';

// Minimal typings for the AudioWorkletGlobalScope.
declare const sampleRate: number;
declare class AudioWorkletProcessor {
	readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

export type WorkletCommand = { type: 'start' } | { type: 'stop' };
export type WorkletEvent =
	| { type: 'audio'; samples: Float32Array; level: number }
	| { type: 'level'; level: number }
	| { type: 'stopped' };

/** About 100 ms per message. */
const CHUNK_SAMPLES = ASR_SAMPLE_RATE / 10;

class PcmProcessor extends AudioWorkletProcessor {
	#active = false;
	#resampler = new StreamingResampler(sampleRate, ASR_SAMPLE_RATE);
	#buffer = new Float32Array(CHUNK_SAMPLES);
	#filled = 0;

	constructor() {
		super();
		this.port.onmessage = (event: MessageEvent<WorkletCommand>) => {
			if (event.data.type === 'start') {
				this.#resampler = new StreamingResampler(sampleRate, ASR_SAMPLE_RATE);
				this.#filled = 0;
				this.#active = true;
			} else if (event.data.type === 'stop') {
				this.#flush();
				this.#active = false;
				this.#post({ type: 'stopped' });
			}
		};
	}

	#post(event: WorkletEvent, transfer: Transferable[] = []) {
		this.port.postMessage(event, transfer);
	}

	#flush() {
		if (this.#filled === 0) return;
		const samples = this.#buffer.slice(0, this.#filled);
		this.#filled = 0;
		this.#post({ type: 'audio', samples, level: rms(samples) }, [samples.buffer]);
	}

	process(inputs: Float32Array[][]): boolean {
		const input = inputs[0];
		if (!this.#active || input === undefined || input.length === 0) return true;

		const resampled = this.#resampler.process(downmix(input));
		let offset = 0;
		while (offset < resampled.length) {
			const n = Math.min(CHUNK_SAMPLES - this.#filled, resampled.length - offset);
			this.#buffer.set(resampled.subarray(offset, offset + n), this.#filled);
			this.#filled += n;
			offset += n;
			if (this.#filled === CHUNK_SAMPLES) this.#flush();
		}
		return true;
	}
}

registerProcessor('pcm-processor', PcmProcessor);
