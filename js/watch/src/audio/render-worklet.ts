import type { Message, State } from "./render";
import { AudioRingBuffer } from "./ring-buffer";
import { SharedRingBuffer } from "./shared-ring-buffer";

class Render extends AudioWorkletProcessor {
	// Set after init, depending on which path the main thread chose.
	#backend?: SharedRingBuffer | AudioRingBuffer;
	#underflow = 0;
	#stateCounter = 0;
	#lastSample = new Float32Array(0);

	constructor() {
		super();

		this.port.onmessage = (event: MessageEvent<Message>) => {
			const msg = event.data;
			if (msg.type === "init-shared") {
				console.log("[audio-worklet] init-shared: using SharedArrayBuffer path");
				this.#backend = new SharedRingBuffer(msg);
				this.#underflow = 0;
			} else if (msg.type === "init-post") {
				console.log("[audio-worklet] init-post: using postMessage path");
				this.#backend = new AudioRingBuffer(msg);
				this.#underflow = 0;
			} else if (msg.type === "data") {
				// Only meaningful in post mode.
				if (this.#backend instanceof AudioRingBuffer) this.#backend.write(msg.timestamp, msg.data);
			} else if (msg.type === "latency") {
				// Only meaningful in post mode.
				if (this.#backend instanceof AudioRingBuffer) this.#backend.resize(msg.latency);
			} else if (msg.type === "reset") {
				// Only meaningful in post mode; shared mode resets via the control array.
				if (this.#backend instanceof AudioRingBuffer) this.#backend.reset();
			}
		};
	}

	process(_inputs: Float32Array[][], outputs: Float32Array[][], _parameters: Record<string, Float32Array>) {
		const output = outputs[0];
		if (!output || !output[0]) return true;
		const backend = this.#backend;
		const channels = output.length;
		const frames = output[0].length;
		if (this.#lastSample.length !== channels) this.#lastSample = new Float32Array(channels);
		const samplesRead = backend?.read(output) ?? 0;

		if (samplesRead < frames) {
			this.#underflow += frames - samplesRead;
			// Packet-loss concealment: read() leaves the unfilled tail as silence, which clicks.
			// Fade from the last real sample (or the previous frame's, on a full stall) down to
			// zero across the gap instead. Runs only on underrun, so it adds no latency.
			const gap = frames - samplesRead;
			for (let ch = 0; ch < channels; ch++) {
				const buf = output[ch];
				const last = samplesRead > 0 ? buf[samplesRead - 1] : this.#lastSample[ch];
				for (let i = 0; i < gap; i++) {
					buf[samplesRead + i] = last * (1 - (i + 1) / gap);
				}
			}
		} else if (this.#underflow > 0 && backend) {
			console.debug(`audio underflow: ${Math.round((1000 * this.#underflow) / backend.rate)}ms`);
			this.#underflow = 0;
		}

		// Remember the tail so a fully-stalled next frame keeps fading from the real waveform.
		for (let ch = 0; ch < channels; ch++) {
			this.#lastSample[ch] = output[ch][frames - 1];
		}

		// In post mode the main thread can't read worklet state directly, so we
		// periodically ship it across via postMessage. In shared mode the main
		// thread reads the shared control array directly.
		if (backend instanceof AudioRingBuffer) {
			this.#stateCounter++;
			if (this.#stateCounter >= 5) {
				this.#stateCounter = 0;
				const state: State = {
					type: "state",
					timestamp: backend.timestamp,
					stalled: backend.stalled,
				};
				this.port.postMessage(state);
			}
		}

		return true;
	}
}

registerProcessor("render", Render);
