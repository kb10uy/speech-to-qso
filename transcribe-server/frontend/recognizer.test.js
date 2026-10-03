import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav, TranscribeRecognizer } from './recognizer.js';

test('WAV preserves chunk order and describes clipped, little-endian 16 kHz mono PCM', async () => {
	const wav = encodeWav([new Float32Array([-2, -0.5, 0]), new Float32Array([0.5, 2, NaN])]);
	const buffer = await wav.arrayBuffer();
	const view = new DataView(buffer);
	assert.equal(wav.type, 'audio/wav');
	assert.equal(new TextDecoder().decode(buffer.slice(0, 4)), 'RIFF');
	assert.equal(new TextDecoder().decode(buffer.slice(8, 12)), 'WAVE');
	assert.equal(view.getUint32(4, true), buffer.byteLength - 8);
	assert.equal(view.getUint16(20, true), 1);
	assert.equal(view.getUint16(22, true), 1);
	assert.equal(view.getUint32(24, true), 16_000);
	assert.equal(view.getUint32(28, true), 32_000);
	assert.equal(view.getUint16(32, true), 2);
	assert.equal(view.getUint16(34, true), 16);
	assert.equal(view.getUint32(40, true), 12);
	assert.deepEqual(
		Array.from({ length: 6 }, (_, i) => view.getInt16(44 + i * 2, true)),
		[-32768, -16384, 0, 16384, 32767, 0]
	);
});

test('recognizer drops idle and cancelled audio and starts every utterance fresh', async () => {
	const recognizer = new TranscribeRecognizer(() => ({
		prompt: '',
		keywords: [],
		languages: ['en']
	}));
	recognizer.pushAudio(new Float32Array([0.9]));
	recognizer.beginUtterance();
	recognizer.pushAudio(new Float32Array([0.8]));
	recognizer.cancelUtterance();
	recognizer.pushAudio(new Float32Array([0.7]));
	recognizer.beginUtterance();
	const samples = new Float32Array([0.5]);
	recognizer.pushAudio(samples);
	samples[0] = 0;
	const recording = recognizer.finishRecording();
	const view = new DataView(await recording.arrayBuffer());
	assert.equal(recording.size, 46);
	assert.equal(view.getInt16(44, true), 16384);
	recognizer.beginUtterance();
	assert.throws(() => recognizer.finishRecording(), /No audio captured/);
	recognizer.dispose();
	assert.equal(recognizer.lastRecording, null);
});
