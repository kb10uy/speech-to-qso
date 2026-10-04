import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./pcm-worklet.ts?worker&url', () => ({ default: 'pcm-worklet.js' }));

type Listener = ((event: MessageEvent) => void) | null;

/** Fake Web Audio: every asynchronous step can be told to hang. */
const fakes = {
	resumeHangs: false,
	microphoneHangs: false,
	workletHangs: false,
	stopAnswers: true,
	tracks: [] as { stop: ReturnType<typeof vi.fn> }[],
	contexts: [] as FakeContext[],
	nodes: [] as FakeNode[]
};

class FakeContext {
	state: AudioContextState = 'suspended';
	closed = false;
	audioWorklet = {
		addModule: () => (fakes.workletHangs ? new Promise<void>(() => {}) : Promise.resolve())
	};
	constructor() {
		fakes.contexts.push(this);
	}
	resume() {
		if (fakes.resumeHangs) return new Promise<void>(() => {});
		this.state = 'running';
		return Promise.resolve();
	}
	close() {
		this.closed = true;
		this.state = 'closed';
		return Promise.resolve();
	}
	createMediaStreamSource() {
		return { connect() {}, disconnect() {} };
	}
}

class FakeNode {
	port: { onmessage: Listener; postMessage: (c: { type: string }) => void };
	constructor() {
		fakes.nodes.push(this);
		this.port = {
			onmessage: null,
			postMessage: (command) => {
				if (command.type === 'stop' && fakes.stopAnswers) {
					queueMicrotask(() =>
						this.port.onmessage?.({ data: { type: 'stopped' } } as MessageEvent)
					);
				}
			}
		};
	}
	disconnect() {}
}

function fakeStream() {
	const track = { stop: vi.fn() };
	fakes.tracks.push(track);
	return { getTracks: () => [track] };
}

vi.stubGlobal('AudioContext', FakeContext);
vi.stubGlobal('AudioWorkletNode', FakeNode);
vi.stubGlobal('navigator', {
	mediaDevices: {
		getUserMedia: () =>
			fakes.microphoneHangs ? new Promise(() => {}) : Promise.resolve(fakeStream())
	}
});

const { AudioCapture } = await import('./capture');

describe('AudioCapture', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		Object.assign(fakes, {
			resumeHangs: false,
			microphoneHangs: false,
			workletHangs: false,
			stopAnswers: true,
			tracks: [],
			contexts: [],
			nodes: []
		});
	});
	afterEach(() => vi.useRealTimers());

	it('opens the microphone and streams until the worklet confirms the stop', async () => {
		const capture = new AudioCapture();
		await capture.open();
		expect(capture.isOpen).toBe(true);
		capture.begin();
		await capture.end();
		expect(fakes.nodes).toHaveLength(1);
	});

	it('asks for the permission without keeping the microphone or an audio context', async () => {
		const capture = new AudioCapture();
		await capture.requestPermission();
		expect(fakes.tracks[0].stop).toHaveBeenCalled();
		expect(fakes.contexts).toHaveLength(0);
		expect(capture.isOpen).toBe(false);
	});

	it('fails instead of waiting forever for a context that never starts', async () => {
		fakes.resumeHangs = true;
		const capture = new AudioCapture();
		const opening = capture.open();
		const failed = expect(opening).rejects.toThrow('audio did not start');
		await vi.advanceTimersByTimeAsync(5_000);
		await failed;
		expect(capture.isOpen).toBe(false);
		expect(fakes.contexts[0].closed).toBe(true);
		expect(fakes.tracks[0].stop).toHaveBeenCalled();
	});

	it('fails instead of waiting forever for the microphone', async () => {
		fakes.microphoneHangs = true;
		const capture = new AudioCapture();
		const opening = capture.open();
		const failed = expect(opening).rejects.toThrow('the microphone did not respond');
		await vi.advanceTimersByTimeAsync(30_000);
		await failed;
		expect(fakes.contexts[0].closed).toBe(true);
	});

	it('fails instead of waiting forever for the worklet module', async () => {
		fakes.workletHangs = true;
		const capture = new AudioCapture();
		const opening = capture.open();
		const failed = expect(opening).rejects.toThrow('the audio processor did not load');
		await vi.advanceTimersByTimeAsync(10_000);
		await failed;
		expect(fakes.tracks[0].stop).toHaveBeenCalled();
	});

	it('does not wait forever for a worklet that never answers the stop', async () => {
		fakes.stopAnswers = false;
		const capture = new AudioCapture();
		await capture.open();
		capture.begin();
		let ended = false;
		const ending = capture.end().then(() => (ended = true));
		await vi.advanceTimersByTimeAsync(499);
		expect(ended).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await ending;
		expect(ended).toBe(true);
	});

	it('resumes a suspended or interrupted context on the next press', async () => {
		const capture = new AudioCapture();
		await capture.open();
		fakes.contexts[0].state = 'interrupted';
		await capture.open();
		expect(fakes.contexts[0].state).toBe('running');
		expect(fakes.contexts).toHaveLength(1);
	});

	it('starts a fresh context when opened while closing', async () => {
		const capture = new AudioCapture();
		await capture.open();
		const closing = capture.close();
		await capture.open();
		await closing;
		expect(fakes.contexts).toHaveLength(2);
		expect(fakes.contexts[0].closed).toBe(true);
		expect(capture.isOpen).toBe(true);
	});
});
