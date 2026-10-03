import { beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (message: unknown) => void;

/** Fake vosk-browser recognizer: records requests and lets the test play worker responses. */
class FakeRecognizer {
	static last: FakeRecognizer;
	handlers = new Map<string, Handler>();
	requests: string[] = [];
	constructor(
		readonly sampleRate: number,
		readonly grammar?: string
	) {
		FakeRecognizer.last = this;
	}
	on(event: string, handler: Handler) {
		this.handlers.set(event, handler);
	}
	setWords() {}
	acceptWaveformFloat(samples: Float32Array) {
		this.requests.push(`audio:${samples.length}`);
	}
	retrieveFinalResult() {
		this.requests.push('final');
	}
	remove() {}
	// Worker responses
	partial(text: string) {
		this.handlers.get('partialresult')!({ event: 'partialresult', result: { partial: text } });
	}
	result(text: string) {
		const words =
			text === '' ? [] : text.split(' ').map((word) => ({ word, conf: 1, start: 0, end: 0 }));
		this.handlers.get('result')!({ event: 'result', result: { text, result: words } });
	}
	error(error: string) {
		this.handlers.get('error')!({ event: 'error', error });
	}
}

vi.mock('vosk-browser', () => ({
	createModel: async () => ({ KaldiRecognizer: FakeRecognizer, terminate() {} })
}));

const { VoskRecognizer } = await import('./vosk');

async function recognizer(useGrammar = true, language: 'en' | 'ja' = 'en') {
	const r = new VoskRecognizer({
		modelUrl: 'https://example.com/model.tar.gz',
		language,
		useGrammar
	});
	await r.initialize();
	return { r, fake: FakeRecognizer.last };
}

const chunk = () => new Float32Array(1600);

describe('VoskRecognizer', () => {
	beforeEach(() => vi.clearAllMocks());

	it('creates a 16 kHz recognizer with the DSL grammar', async () => {
		const { fake } = await recognizer();
		expect(fake.sampleRate).toBe(16_000);
		const grammar: string[] = JSON.parse(fake.grammar!);
		expect(grammar).toContain('[unk]');
		expect(grammar.some((phrase) => phrase.startsWith('received '))).toBe(true);

		const { fake: free } = await recognizer(false);
		expect(free.grammar).toBeUndefined();
	});

	it('spells the grammar in katakana for a Japanese model', async () => {
		const { fake } = await recognizer(true, 'ja');
		const grammar: string[] = JSON.parse(fake.grammar!);
		expect(grammar).toContain('[unk]');
		expect(grammar.some((phrase) => phrase.startsWith('レシーブド '))).toBe(true);
		expect(grammar.some((phrase) => phrase.startsWith('received '))).toBe(false);
	});

	it('joins segments finalised mid-utterance with the final result', async () => {
		const { r, fake } = await recognizer();
		const partials: string[] = [];
		r.onPartial = (t) => partials.push(t);

		r.beginUtterance();
		r.pushAudio(chunk());
		r.pushAudio(chunk());
		r.pushAudio(chunk());
		const done = r.endUtterance();
		expect(fake.requests).toEqual(['audio:1600', 'audio:1600', 'audio:1600', 'final']);

		fake.partial('received');
		fake.result('received'); // endpoint after a pause
		fake.partial('five');
		fake.result('five seven');
		await expect(done).resolves.toMatchObject({ text: 'received five seven' });
		expect(partials).toEqual(['received', 'received five']);
	});

	it('waits for responses to every chunk before resolving', async () => {
		const { r, fake } = await recognizer();
		r.beginUtterance();
		r.pushAudio(chunk());
		r.pushAudio(chunk());
		let resolved = false;
		const done = r.endUtterance().then((res) => ((resolved = true), res));
		fake.partial('sent');
		await Promise.resolve();
		expect(resolved).toBe(false);
		fake.partial('sent five');
		fake.result('sent five nine');
		await expect(done).resolves.toMatchObject({ text: 'sent five nine' });
	});

	it('drops late responses of a cancelled utterance', async () => {
		const { r, fake } = await recognizer();
		r.beginUtterance();
		r.pushAudio(chunk());
		r.cancelUtterance();

		// The next utterance starts before the worker caught up.
		r.beginUtterance();
		r.pushAudio(chunk());
		const done = r.endUtterance();

		fake.partial('juliett'); // stale: first utterance's chunk
		fake.result('juliett lima'); // stale: first utterance's flush
		fake.partial('card');
		fake.result('card requested');
		await expect(done).resolves.toMatchObject({ text: 'card requested' });
	});

	it('rejects when the worker reports an error', async () => {
		const { r, fake } = await recognizer();
		r.beginUtterance();
		r.pushAudio(chunk());
		const done = r.endUtterance();
		fake.error('Recognizer not ready');
		fake.result('');
		await expect(done).rejects.toThrow('Recognizer not ready');
	});
});
