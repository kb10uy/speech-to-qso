import workletUrl from './pcm-worklet.ts?worker&url';
import type { WorkletCommand, WorkletEvent } from './pcm-worklet';

/**
 * Microphone → MediaStream → AudioWorklet → 16 kHz mono PCM.
 *
 * The microphone stays open between PTT presses (so the first syllable is not lost while the
 * device wakes up), but audio is only forwarded between `begin()` and `end()`.
 */
export class AudioCapture {
	#context: AudioContext | null = null;
	#stream: MediaStream | null = null;
	#node: AudioWorkletNode | null = null;
	#source: MediaStreamAudioSourceNode | null = null;
	#stopped: (() => void) | null = null;
	#starting: Promise<void> | null = null;

	/** Receives PCM chunks while capturing. */
	onAudio: (samples: Float32Array) => void = () => {};
	/** Receives the RMS level of each chunk (0..1). */
	onLevel: (level: number) => void = () => {};

	get isOpen(): boolean {
		return this.#node !== null;
	}

	/** Opens the microphone. Must be called from a user gesture the first time. */
	open(): Promise<void> {
		if (this.#node !== null) {
			// Resume in case the browser suspended the context in the background.
			return this.#context!.state === 'suspended' ? this.#context!.resume() : Promise.resolve();
		}
		this.#starting ??= this.#open().finally(() => (this.#starting = null));
		return this.#starting;
	}

	async #open(): Promise<void> {
		const context = new AudioContext({ latencyHint: 'interactive' });
		try {
			const resumed = context.resume();
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: {
					channelCount: 1,
					echoCancellation: true,
					noiseSuppression: true,
					autoGainControl: true
				}
			});
			await resumed;
			await context.audioWorklet.addModule(workletUrl);
			const source = context.createMediaStreamSource(stream);
			const node = new AudioWorkletNode(context, 'pcm-processor', {
				numberOfInputs: 1,
				numberOfOutputs: 0
			});
			node.port.onmessage = (event: MessageEvent<WorkletEvent>) => this.#handle(event.data);
			source.connect(node);

			this.#context = context;
			this.#stream = stream;
			this.#source = source;
			this.#node = node;
		} catch (e) {
			await context.close().catch(() => {});
			throw e;
		}
	}

	#handle(event: WorkletEvent) {
		switch (event.type) {
			case 'audio':
				this.onLevel(event.level);
				this.onAudio(event.samples);
				break;
			case 'stopped':
				this.#stopped?.();
				this.#stopped = null;
				break;
		}
	}

	#send(command: WorkletCommand) {
		this.#node?.port.postMessage(command);
	}

	/** Starts forwarding audio. */
	begin() {
		if (this.#node === null) throw new Error('microphone is not open');
		this.#send({ type: 'start' });
	}

	/** Stops forwarding audio; resolves once every buffered sample has been delivered. */
	end(): Promise<void> {
		if (this.#node === null) return Promise.resolve();
		return new Promise((resolve) => {
			const previous = this.#stopped;
			this.#stopped = () => {
				previous?.();
				resolve();
			};
			this.#send({ type: 'stop' });
		});
	}

	/** Releases the microphone (e.g. when the app goes to the background). */
	async close() {
		// An open that is still in progress (permission prompt) would otherwise leak its stream.
		await this.#starting?.catch(() => {});
		this.#stopped?.();
		this.#stopped = null;
		this.#source?.disconnect();
		this.#node?.disconnect();
		this.#stream?.getTracks().forEach((t) => t.stop());
		await this.#context?.close().catch(() => {});
		this.#context = null;
		this.#stream = null;
		this.#source = null;
		this.#node = null;
	}
}
