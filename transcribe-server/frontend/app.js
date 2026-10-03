import { SAMPLE_RATE, TranscribeRecognizer, transcribeFile } from './recognizer.js';

const $ = (/** @type {string} */ id) => {
	const element = document.getElementById(id);
	if (!element) throw new Error(`Missing element: ${id}`);
	return element;
};
const ptt = /** @type {HTMLButtonElement} */ ($('ptt'));
const enableMic = /** @type {HTMLButtonElement} */ ($('enable-mic'));
const fileInput = /** @type {HTMLInputElement} */ ($('audio-file'));
const send = /** @type {HTMLButtonElement} */ ($('send'));
const prompt = /** @type {HTMLTextAreaElement} */ ($('prompt'));
const keywords = /** @type {HTMLTextAreaElement} */ ($('keywords'));
const languages = /** @type {HTMLInputElement} */ ($('languages'));
const provider = /** @type {HTMLSelectElement} */ ($('provider'));
const boost = /** @type {HTMLInputElement} */ ($('boost'));
const abnf = /** @type {HTMLTextAreaElement} */ ($('abnf'));
const models = new Map();
let connected = false;
let currentProvider = 'openai';
const languageSettings = new Map([
	['openai', 'en'],
	['google', 'en-US'],
	['google-v1', 'en-US']
]);
const playback = /** @type {HTMLAudioElement} */ ($('playback'));
const download = /** @type {HTMLAnchorElement} */ ($('download'));
const status = $('status');
const error = $('error');
const history = $('history');
let busy = false;
let recording = false;
let opening = false;
/** @type {File | null} */
let audioFile = null;
let audioUrl = '';
/** @type {AudioContext | null} */
let context = null;
/** @type {MediaStream | null} */
let stream = null;
/** @type {AudioWorkletNode | null} */
let node = null;
/** @type {MediaStreamAudioSourceNode | null} */
let source = null;
/** @type {(() => void) | null} */
let stopped = null;
let recordingStarted = 0;
let recordingTimer = 0;
let pointer = /** @type {number | null} */ (null);
let keyboard = false;

function hints() {
	return {
		provider: provider.value,
		prompt: provider.value.startsWith('google') ? '' : prompt.value,
		...(provider.value.startsWith('google') ? { boost: Number(boost.value) } : {}),
		...(provider.value === 'google-v1' && abnf.value.trim() ? { abnf: abnf.value } : {}),
		keywords: keywords.value
			.split(/\r?\n/)
			.map((value) => value.trim())
			.filter(Boolean),
		languages: languages.value
			.split(',')
			.map((value) => value.trim())
			.filter(Boolean)
	};
}
const recognizer = new TranscribeRecognizer(hints);

function update() {
	ptt.disabled = !connected || !node || busy || opening;
	enableMic.disabled = busy || recording || opening;
	fileInput.disabled = busy || recording || opening;
	send.disabled = !connected || !audioFile || busy || recording || opening;
	provider.disabled = !connected;
	prompt.disabled = provider.value.startsWith('google');
	/** @type {HTMLFieldSetElement} */ ($('hint-fields')).disabled = busy || recording;
	/** @type {HTMLButtonElement} */ ($('reset-hints')).disabled = busy || recording;
	ptt.setAttribute('aria-pressed', String(recording));
}
function updateProvider() {
	const google = provider.value.startsWith('google');
	const v1 = provider.value === 'google-v1';
	$('google-boost').hidden = !google;
	$('abnf-fields').hidden = !v1;
	languages.placeholder = google ? 'en-US, ja-JP' : 'en, ja';
	$('model').textContent = models.get(provider.value) ?? '—';
	$('provider-note').textContent = v1
		? 'ADC · Global endpoint · SRGS ABNF · One language · WAV or FLAC · Up to 10 MB / 60 s'
		: google
			? 'ADC on the server · Keywords use PhraseSet · Up to 10 MB / 60 s · WAV, FLAC, MP3, OGG or WebM'
			: 'API key on the server · Up to 25 MB';
	update();
}
function showError(/** @type {unknown} */ reason) {
	error.textContent = reason instanceof Error ? reason.message : String(reason);
	error.hidden = false;
}
function clearError() {
	error.hidden = true;
	error.textContent = '';
}
/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} milliseconds
 * @param {string} message
 */
async function deadline(promise, milliseconds, message) {
	let timer = 0;
	try {
		return await Promise.race([
			promise,
			/** @type {Promise<never>} */ (
				new Promise((_, reject) => {
					timer = setTimeout(() => reject(new Error(message)), milliseconds);
				})
			)
		]);
	} finally {
		clearTimeout(timer);
	}
}
function setLevel(/** @type {number} */ level) {
	const value = Math.min(100, Math.round(level * 400));
	$('level-fill').style.width = `${value}%`;
	$('level-fill').parentElement?.setAttribute('aria-valuenow', String(value));
}
function selectAudio(/** @type {File} */ file) {
	if (audioUrl) URL.revokeObjectURL(audioUrl);
	audioFile = file;
	audioUrl = URL.createObjectURL(file);
	playback.src = audioUrl;
	download.href = audioUrl;
	download.download = file.name;
	$('filename').textContent = `${file.name} · ${(file.size / 1024).toFixed(1)} KB`;
	$('recording').hidden = false;
	update();
}

async function openMicrophone() {
	if (node) {
		await closeMicrophone();
		return;
	}
	opening = true;
	clearError();
	status.textContent = 'Opening microphone…';
	update();
	let pendingContext;
	let pendingStream;
	try {
		if (!navigator.mediaDevices?.getUserMedia)
			throw new Error('Microphone access requires localhost or HTTPS.');
		pendingContext = new AudioContext({
			sampleRate: SAMPLE_RATE,
			latencyHint: 'interactive'
		});
		await deadline(pendingContext.resume(), 5000, 'Audio did not start.');
		const request = navigator.mediaDevices.getUserMedia({
			audio: {
				channelCount: 1,
				echoCancellation: true,
				noiseSuppression: true
			}
		});
		try {
			pendingStream = await deadline(request, 30_000, 'The microphone did not respond.');
		} catch (reason) {
			request.then(
				(lateStream) => lateStream.getTracks().forEach((track) => track.stop()),
				() => {}
			);
			throw reason;
		}
		await deadline(pendingContext.resume(), 5000, 'Audio did not start.');
		if (document.hidden) throw new Error('Return to this page before enabling the microphone.');
		if (pendingContext.sampleRate !== SAMPLE_RATE)
			throw new Error(
				'This browser does not support a 16 kHz audio context. Try uploading a recording.'
			);
		await deadline(
			pendingContext.audioWorklet.addModule('/pcm-worklet.js'),
			10_000,
			'The audio processor did not load.'
		);
		context = pendingContext;
		stream = pendingStream;
		source = context.createMediaStreamSource(stream);
		node = new AudioWorkletNode(context, 'qso-pcm', {
			numberOfInputs: 1,
			numberOfOutputs: 0
		});
		node.port.onmessage = ({ data }) => {
			if (data.type === 'audio') {
				recognizer.pushAudio(data.samples);
				if (recording) setLevel(data.level);
			}
			if (data.type === 'stopped') stopped?.();
		};
		source.connect(node);
		enableMic.textContent = 'Disable microphone';
		status.textContent = 'Ready. Hold to talk.';
	} catch (reason) {
		pendingStream?.getTracks().forEach((track) => track.stop());
		await pendingContext?.close().catch(() => {});
		context = null;
		stream = null;
		node = null;
		source = null;
		showError(reason);
		status.textContent = 'Microphone unavailable.';
	} finally {
		opening = false;
		update();
		if (node) ptt.focus();
	}
}
async function closeMicrophone() {
	cancelRecording();
	source?.disconnect();
	node?.disconnect();
	stream?.getTracks().forEach((track) => track.stop());
	const previous = context;
	context = null;
	stream = null;
	node = null;
	source = null;
	enableMic.textContent = 'Enable microphone';
	if (!busy) status.textContent = 'Microphone off.';
	update();
	await previous?.close().catch(() => {});
}
function beginRecording() {
	if (!connected || !node || busy || recording || opening) return;
	if (!context || context.state !== 'running') {
		showError(new Error('Audio is suspended. Disable and enable the microphone, then try again.'));
		return;
	}
	playback.pause();
	clearError();
	recording = true;
	recognizer.beginUtterance();
	node.port.postMessage('start');
	recordingStarted = performance.now();
	$('duration').textContent = '00.0 s';
	status.textContent = 'Listening…';
	recordingTimer = window.setInterval(() => {
		const seconds = (performance.now() - recordingStarted) / 1000;
		$('duration').textContent = `${seconds.toFixed(1).padStart(4, '0')} s`;
		if (seconds >= 30) void finishRecording();
	}, 100);
	update();
}
function cancelRecording() {
	pointer = null;
	keyboard = false;
	if (!recording) return;
	recording = false;
	clearInterval(recordingTimer);
	node?.port.postMessage('stop');
	recognizer.cancelUtterance();
	setLevel(0);
	status.textContent = 'Recording cancelled.';
	update();
}
async function flushAudio() {
	const processor = node;
	if (!processor) throw new Error('The microphone is no longer available.');
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			stopped = null;
			reject(new Error('Audio did not stop. Enable the microphone again.'));
		}, 1000);
		stopped = () => {
			clearTimeout(timer);
			stopped = null;
			resolve(undefined);
		};
		processor.port.postMessage('stop');
	});
}
async function finishRecording() {
	if (!recording) return;
	recording = false;
	pointer = null;
	keyboard = false;
	clearInterval(recordingTimer);
	busy = true;
	status.textContent = 'Finishing recording…';
	update();
	try {
		await flushAudio();
		await submit(null);
	} catch (reason) {
		recognizer.cancelUtterance();
		showError(reason);
		status.textContent = 'Recording failed.';
	} finally {
		busy = false;
		setLevel(0);
		update();
	}
}
async function submit(/** @type {File | null} */ file) {
	busy = true;
	clearError();
	status.textContent = 'Transcribing…';
	const options = hints();
	update();
	try {
		const pending = file ? transcribeFile(file, options) : recognizer.endUtterance();
		if (!file && recognizer.lastRecording) selectAudio(recognizer.lastRecording);
		const result = await pending;
		addResult(result, file?.name ?? 'utterance.wav', options);
		status.textContent = node ? 'Ready. Hold to talk.' : 'Ready for another recording.';
	} catch (reason) {
		showError(reason);
		status.textContent = 'Transcription failed. You can retry this audio.';
	} finally {
		busy = false;
		update();
	}
}
function addResult(
	/** @type {import('./recognizer.js').Transcript} */ result,
	/** @type {string} */ filename,
	/** @type {import('./recognizer.js').Hints} */ options
) {
	const fragment = /** @type {HTMLTemplateElement} */ ($('result-template')).content.cloneNode(
		true
	);
	const row = /** @type {DocumentFragment} */ (fragment).querySelector('li');
	if (!row) throw new Error('Missing result template.');
	const text = (/** @type {string} */ selector, /** @type {string} */ value) => {
		const element = row.querySelector(selector);
		if (element) element.textContent = value;
	};
	text(
		'.result-source',
		`${filename} · ${result.provider ?? options.provider ?? 'openai'} / ${result.model}`
	);
	text('.result-timing', `${(result.elapsed_ms / 1000).toFixed(2)} s`);
	text('.transcript', result.text || '(Empty transcript)');
	if (result.adaptation_info?.adaptationTimeout) {
		const warning = /** @type {HTMLElement | null} */ (row.querySelector('.adaptation-warning'));
		if (warning) {
			warning.hidden = false;
			warning.textContent =
				'Google reported an adaptation timeout; this result may not reflect your grammar or keywords.';
		}
	}
	text(
		'.result-context',
		`${options.abnf ? 'With ABNF · ' : ''}${options.boost !== undefined ? `Boost ${options.boost}` : options.prompt.trim() ? 'With prompt' : 'No prompt'} · ${options.keywords.length} keywords · ${options.languages.join(', ')}`
	);
	text(
		'.result-details',
		JSON.stringify(
			{
				hints: options,
				request_id: result.request_id,
				results: result.results,
				adaptation_info: result.adaptation_info
			},
			null,
			2
		)
	);
	history.prepend(fragment);
	while (history.children.length > 20) history.lastElementChild?.remove();
	$('empty-results').hidden = true;
	/** @type {HTMLButtonElement} */ ($('clear-results')).disabled = false;
}

enableMic.addEventListener('click', () => void openMicrophone());
ptt.addEventListener('pointerdown', (event) => {
	if (event.button !== 0 || pointer !== null || keyboard) return;
	event.preventDefault();
	ptt.focus();
	pointer = event.pointerId;
	ptt.setPointerCapture(pointer);
	beginRecording();
});
ptt.addEventListener('pointerup', (event) => {
	if (pointer === event.pointerId) void finishRecording();
});
ptt.addEventListener('pointercancel', cancelRecording);
ptt.addEventListener('lostpointercapture', () => {
	if (pointer !== null) cancelRecording();
});
ptt.addEventListener('keydown', (event) => {
	if (!['Space', 'Enter'].includes(event.code)) return;
	event.preventDefault();
	if (!event.repeat && pointer === null) {
		keyboard = true;
		beginRecording();
	}
});
ptt.addEventListener('keyup', (event) => {
	if (['Space', 'Enter'].includes(event.code) && keyboard) {
		event.preventDefault();
		void finishRecording();
	}
});
ptt.addEventListener('blur', () => {
	if (keyboard) cancelRecording();
});
window.addEventListener('blur', cancelRecording);
document.addEventListener('visibilitychange', () => {
	if (document.hidden) void closeMicrophone();
});
fileInput.addEventListener('change', () => {
	clearError();
	const file = fileInput.files?.[0];
	if (!file) return;
	if (!file.size || file.size > 25_000_000) {
		showError(new Error('Choose a nonempty audio file up to 25 MB.'));
		fileInput.value = '';
		return;
	}
	selectAudio(file);
	status.textContent = 'Audio selected. Ready to transcribe.';
});
send.addEventListener('click', () => {
	if (audioFile && !busy) void submit(audioFile);
});
$('reset-hints').addEventListener('click', () => {
	prompt.value = '';
	keywords.value = '';
	languages.value = provider.value.startsWith('google') ? 'en-US' : 'en';
	boost.value = '0';
	abnf.value = '';
});
provider.addEventListener('change', () => {
	languageSettings.set(currentProvider, languages.value);
	currentProvider = provider.value;
	languages.value = languageSettings.get(currentProvider) ?? '';
	clearError();
	updateProvider();
});
$('clear-results').addEventListener('click', () => {
	history.replaceChildren();
	$('empty-results').hidden = false;
	/** @type {HTMLButtonElement} */ ($('clear-results')).disabled = true;
});
window.addEventListener('pagehide', () => {
	void closeMicrophone();
	recognizer.dispose();
	if (audioUrl) URL.revokeObjectURL(audioUrl);
});

fetch('/api/health')
	.then(async (response) => {
		if (!response.ok) throw new Error('Server unavailable');
		const result = await response.json();
		for (const option of provider.options) {
			const setting = result.providers.find(
				(/** @type {{ id: string }} */ item) => item.id === option.value
			);
			option.disabled = !setting;
			if (setting) models.set(setting.id, setting.model);
		}
		provider.value = result.providers[0].id;
		currentProvider = provider.value;
		languages.value = languageSettings.get(currentProvider) ?? '';
		connected = true;
		updateProvider();
		$('connection').textContent = 'Server connected';
		$('connection').dataset.connected = 'true';
	})
	.catch(() => {
		$('connection').textContent = 'Server unavailable';
	});
