// AudioContext performs the device-rate conversion before this worklet receives mono PCM.
class PcmProcessor extends AudioWorkletProcessor {
	active = false;
	buffer = new Float32Array(1600);
	filled = 0;

	constructor() {
		super();
		this.port.onmessage = ({ data }) => {
			if (data === 'start') {
				this.filled = 0;
				this.active = true;
			}
			if (data === 'stop') {
				this.flush();
				this.active = false;
				this.port.postMessage({ type: 'stopped' });
			}
		};
	}
	flush() {
		if (!this.filled) return;
		const samples = this.buffer.slice(0, this.filled);
		this.filled = 0;
		let energy = 0;
		for (const sample of samples) energy += sample * sample;
		this.port.postMessage({ type: 'audio', samples, level: Math.sqrt(energy / samples.length) }, [
			samples.buffer
		]);
	}
	process(/** @type {Float32Array[][]} */ inputs) {
		const channels = inputs[0];
		if (!this.active || !channels?.length) return true;
		for (let i = 0; i < channels[0].length; i++) {
			let sample = 0;
			for (const channel of channels) sample += channel[i];
			this.buffer[this.filled++] = sample / channels.length;
			if (this.filled === this.buffer.length) this.flush();
		}
		return true;
	}
}
registerProcessor('qso-pcm', PcmProcessor);
