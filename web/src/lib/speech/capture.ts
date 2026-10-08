import workletUrl from './pcm-worklet.ts?worker&url';
import type { WorkletCommand, WorkletEvent } from './pcm-worklet';
import { withTimeout } from '../util/timeout';

// Every step of opening the microphone can hang on a phone (a context that never leaves
// `suspended`, a permission prompt that is never answered, a worklet module on a dead
// network). A press that waits forever can only be fixed by reloading the app, so each step
// has a deadline and fails with a message instead.
const RESUME_TIMEOUT_MS = 5_000;
/** The user may be reading a permission prompt. */
const MICROPHONE_TIMEOUT_MS = 30_000;
const WORKLET_TIMEOUT_MS = 10_000;
/** The worklet confirms `stop`, but not while its context is suspended or interrupted. */
const STOP_TIMEOUT_MS = 500;

/** Read through a call, because TypeScript does not know that resume() changes the state. */
function stateOf(context: AudioContext): AudioContextState {
    return context.state;
}

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

    /**
     * Asks for the microphone permission without keeping the microphone on. Unlike `open()` it
     * needs no user gesture, so the prompt can be answered before the first PTT press.
     */
    async requestPermission(): Promise<void> {
        if (this.#node !== null || this.#starting !== null) return;
        const stream = await this.#requestMicrophone();
        stream.getTracks().forEach((t) => t.stop());
    }

    /** Opens the microphone. Must be called from a user gesture the first time. */
    open(): Promise<void> {
        // The browser may have suspended the context in the background, and iOS leaves it
        // `interrupted` after a call or another app's audio; both need a resume.
        if (this.#node !== null) return this.#resume(this.#context!);
        this.#starting ??= this.#open().finally(() => (this.#starting = null));
        return this.#starting;
    }

    async #resume(context: AudioContext): Promise<void> {
        if (context.state === 'running') return;
        await withTimeout(context.resume(), RESUME_TIMEOUT_MS, 'audio did not start');
        const state = stateOf(context);
        if (state !== 'running') throw new Error(`audio is ${state}`);
    }

    async #open(): Promise<void> {
        const context = new AudioContext({ latencyHint: 'interactive' });
        // Started inside the user gesture (iOS insists); awaited once the microphone is granted.
        const resumed = context.resume();
        let stream: MediaStream | null = null;
        try {
            stream = await this.#requestMicrophone();
            await withTimeout(resumed, RESUME_TIMEOUT_MS, 'audio did not start');
            // Opening the microphone can switch the audio route and suspend the context again.
            await this.#resume(context);
            await withTimeout(
                context.audioWorklet.addModule(workletUrl),
                WORKLET_TIMEOUT_MS,
                'the audio processor did not load'
            );
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
            stream?.getTracks().forEach((t) => t.stop());
            await context.close().catch(() => {});
            throw e;
        }
    }

    async #requestMicrophone(): Promise<MediaStream> {
        const request = navigator.mediaDevices.getUserMedia({
            audio: {
                channelCount: 1,
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        });
        try {
            return await withTimeout(
                request,
                MICROPHONE_TIMEOUT_MS,
                'the microphone did not respond'
            );
        } catch (e) {
            // A stream granted after the deadline would otherwise keep the microphone on.
            request.then(
                (stream) => stream.getTracks().forEach((t) => t.stop()),
                () => {}
            );
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

    /**
     * Stops forwarding audio; resolves once every buffered sample has been delivered, or after
     * a short wait when the worklet does not answer (its context is not running, so there are
     * no samples to wait for).
     */
    end(): Promise<void> {
        if (this.#node === null) return Promise.resolve();
        return new Promise((resolve) => {
            const previous = this.#stopped;
            const stopped = () => {
                if (this.#stopped === stopped) this.#stopped = null;
                clearTimeout(timer);
                previous?.();
                resolve();
            };
            const timer = setTimeout(stopped, STOP_TIMEOUT_MS);
            this.#stopped = stopped;
            this.#send({ type: 'stop' });
        });
    }

    /** Releases the microphone (e.g. when the app goes to the background). */
    async close() {
        // An open that is still in progress (permission prompt) would otherwise leak its stream.
        // (Awaited only when there is one: the fields below must be cleared synchronously.)
        if (this.#starting !== null) await this.#starting.catch(() => {});
        const { context, stream, source, node } = {
            context: this.#context,
            stream: this.#stream,
            source: this.#source,
            node: this.#node
        };
        // Cleared first, so that an open() racing with this close starts a fresh context
        // instead of resuming the one being closed.
        this.#context = null;
        this.#stream = null;
        this.#source = null;
        this.#node = null;
        this.#stopped?.();
        source?.disconnect();
        node?.disconnect();
        stream?.getTracks().forEach((t) => t.stop());
        await context?.close().catch(() => {});
    }
}
