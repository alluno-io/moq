import type * as Moq from "@moq/net";
import { Time } from "@moq/net";
import { Effect, Signal } from "@moq/signals";

/** A single latency bound: `"real-time"` adapts to the RTT; a `Time.Milli` fixes the jitter buffer. */
export type Bound = "real-time" | "adaptive" | Time.Milli;

/**
 * Latency target. A scalar (or `"real-time"`) collapses the range and minimizes latency, the live
 * default. An object opens a range `[min, max]`: playback buffers freely between the floor and the
 * ceiling and only skips ahead once latency would exceed the ceiling, so faster-than-real-time
 * frames (e.g. a TTS response with future timestamps) build up instead of being skipped. Both
 * bounds default to `"real-time"` when omitted. The ceiling is always finite (no uncapped buffering),
 * so worst case the audio ring drops its oldest samples rather than exhausting memory.
 */
export type Latency = Bound | { min?: Bound; max?: Bound };

/** Resolve a {@link Latency} into explicit floor/ceiling bounds (a scalar collapses to `min == max`). */
export function latencyBounds(latency: Latency): { min: Bound; max: Bound } {
	if (latency === "real-time" || latency === "adaptive" || typeof latency === "number") {
		return { min: latency, max: latency };
	}
	return { min: latency.min ?? "real-time", max: latency.max ?? "real-time" };
}

/** Build a {@link Latency} from explicit bounds, collapsing to a scalar when they're equal. */
export function latencyFromBounds(min: Bound, max: Bound): Latency {
	return min === max ? min : { min, max };
}

const MIN_JITTER = 20 as Time.Milli;
const FALLBACK_JITTER = 100 as Time.Milli;

// Adaptive audio buffer: floor at MIN_JITTER, cap so latency stays bounded on a bad link, and cover
// the tail of the delay distribution with a multiple of the smoothed inter-arrival jitter.
const ADAPTIVE_MAX = 400 as Time.Milli;
const ADAPTIVE_MULTIPLIER = 4;

export interface SyncProps {
	// Latency target: a scalar minimizes (collapsed range), an object opens a range. See {@link Latency}.
	latency?: Latency | Signal<Latency>;

	connection?: Signal<Moq.Connection.Established | undefined>;
	audio?: Time.Milli | Signal<Time.Milli | undefined>;
	video?: Time.Milli | Signal<Time.Milli | undefined>;
}

export class Sync {
	// The earliest time we've received a frame, relative to its timestamp.
	// This will keep being updated as we catch up to the live playhead then will be relatively static.
	#reference = new Signal<Time.Milli | undefined>(undefined);
	readonly reference: Signal<Time.Milli | undefined> = this.#reference;

	// The latency target: a scalar minimizes (collapsed range), an object opens a range. See {@link Latency}.
	latency: Signal<Latency>;

	// The audio jitter buffer in milliseconds (always numeric). In "real-time" mode it tracks RTT;
	// a fixed `latency` sets it to that number. Only audio honors this, so raising `latency` buffers
	// audio without delaying video (which paces off `#videoJitter`).
	jitter: Signal<Time.Milli>;

	// The real-time (RTT-derived) floor, tracked even in fixed-latency mode. Video always paces off
	// this, so a raised `latency` never adds video latency. Set alongside `jitter` in `#runJitter`.
	#videoJitter = new Signal<Time.Milli>(FALLBACK_JITTER);

	// Any additional delay required for audio or video.
	audio: Signal<Time.Milli | undefined>;
	video: Signal<Time.Milli | undefined>;

	// Derived: true when the ceiling sits above the floor. Buffered playback lets the reference
	// stay anchored so future-dated frames build up a buffer, re-anchoring (skipping ahead) only
	// when latency would exceed the ceiling. See `reset()`.
	#buffered = new Signal<boolean>(false);
	readonly buffered: Signal<boolean> = this.#buffered;

	// Derived cap on buffered audio (ms), consumed by the audio ring to size itself. Always finite.
	#maxBuffer = new Signal<Time.Milli>(Time.Milli.zero);
	readonly maxBuffer: Signal<Time.Milli> = this.#maxBuffer;

	// The video playout floor: jitter + video delay. Audio uses `#audioBuffer` instead, so video
	// stays low-latency and is not dragged by audio's larger headroom.
	#buffer = new Signal<Time.Milli>(Time.Milli.zero);
	readonly buffer: Signal<Time.Milli> = this.#buffer;

	// The audio-only floor and ceiling: jitter + max(audio, video). Kept independent of `#buffer` so
	// audio can carry more jitter headroom (and thus sit slightly behind video) without adding video
	// latency. The audio ring sizes itself from these; `max(audio, video)` keeps audio from ever
	// leading video (audio-ahead is the intolerant lip-sync direction).
	#audioBuffer = new Signal<Time.Milli>(Time.Milli.zero);
	readonly audioBuffer: Signal<Time.Milli> = this.#audioBuffer;

	#audioMaxBuffer = new Signal<Time.Milli>(Time.Milli.zero);
	readonly audioMaxBuffer: Signal<Time.Milli> = this.#audioMaxBuffer;

	// A ghetto way to learn when the reference/buffer changes.
	// There's probably a way to use Effect, but lets keep it simple for now.
	#update: PromiseWithResolvers<void>;

	// The media timestamp of the most recently received frame.
	readonly timestamp = new Signal<Time.Milli | undefined>(undefined);

	// Per-label late-frame tracking: accumulate count and max lateness, flush on recovery.
	#late = new Map<string, { count: number; maxMs: number }>();

	// The connection used for "real-time" jitter: PROBE supplies RTT.
	#connection?: Signal<Moq.Connection.Established | undefined>;

	// Minimum RTT seen, used as the baseline for jitter calculation.
	// Avoids inflating jitter due to bufferbloat.
	#minRtt: number | undefined;

	// Adaptive-mode state: an RFC3550-style smoothed inter-arrival deviation for the audio stream and
	// the derived audio floor, updated per received audio frame and consumed by `#runJitter`.
	#audioJitter = 0;
	#lastAudioArrival: Time.Milli | undefined;
	#lastAudioTs: Time.Milli | undefined;
	#audioAdaptive = new Signal<Time.Milli>(MIN_JITTER);

	signals = new Effect();

	constructor(props?: SyncProps) {
		this.latency = Signal.from(props?.latency ?? ("real-time" as Latency));
		this.jitter = new Signal<Time.Milli>(FALLBACK_JITTER);
		this.#connection = props?.connection;
		this.audio = Signal.from(props?.audio);
		this.video = Signal.from(props?.video);

		this.#update = Promise.withResolvers();

		this.signals.run(this.#runJitter.bind(this));
		this.signals.run(this.#runBuffer.bind(this));
		this.signals.run(this.#runRange.bind(this));
	}

	// Derive `buffered` / `maxBuffer` from the floor (`buffer`) and the ceiling (the `max` bound).
	#runRange(effect: Effect): void {
		const { max } = latencyBounds(effect.get(this.latency));
		const floor = effect.get(this.buffer);
		const audioFloor = effect.get(this.audioBuffer);

		if (max === "real-time" || max === "adaptive") {
			// Ceiling tracks the floor: minimize latency (real-time) or size from jitter (adaptive).
			this.#buffered.set(false);
			this.#maxBuffer.set(floor);
			this.#audioMaxBuffer.set(audioFloor);
		} else {
			// Buffered only when the ceiling is above the floor; otherwise it collapses to minimize.
			this.#buffered.set(max > floor);
			this.#maxBuffer.set(Time.Milli.max(max, floor));
			this.#audioMaxBuffer.set(Time.Milli.max(max, audioFloor));
		}
	}

	// The maximum total latency (lookahead + floor) we tolerate before re-anchoring, in ms.
	// Used by `received()` to decide when to skip ahead.
	#latencyCap(): Time.Milli {
		const { max } = latencyBounds(this.latency.peek());
		const floor = this.#buffer.peek();
		if (max === "real-time" || max === "adaptive") return floor;
		return Time.Milli.max(max, floor);
	}

	#runJitter(effect: Effect): void {
		const { min } = latencyBounds(effect.get(this.latency));

		// Real-time (RTT-derived) floor, computed regardless of the latency mode so video always paces
		// off it. Buffer enough for a retransmit (1 RTT for ACK + retransmit).
		const conn = this.#connection ? effect.get(this.#connection) : undefined;
		const rttSignal = conn?.rtt;
		const rtt = rttSignal ? effect.get(rttSignal) : undefined;
		let realtime: Time.Milli;
		if (rtt !== undefined) {
			// Track minimum RTT as baseline, ignoring bufferbloat.
			this.#minRtt = this.#minRtt !== undefined ? Math.min(this.#minRtt, rtt) : rtt;
			realtime = Math.max(MIN_JITTER, this.#minRtt * 1.25) as Time.Milli;
		} else {
			// No RTT available: fall back to static default.
			this.#minRtt = undefined;
			realtime = FALLBACK_JITTER;
		}
		this.#videoJitter.set(realtime);

		// Audio floor: a fixed `latency` buffers audio at that value; "adaptive" sizes it from measured
		// inter-arrival jitter; "real-time" tracks the RTT floor. Video always uses `realtime`.
		this.jitter.set(
			typeof min === "number" ? min : min === "adaptive" ? effect.get(this.#audioAdaptive) : realtime,
		);
	}

	#runBuffer(effect: Effect): void {
		const jitter = effect.get(this.jitter);
		const videoJitter = effect.get(this.#videoJitter);
		const video = effect.get(this.video) ?? Time.Milli.zero;
		const audio = effect.get(this.audio) ?? Time.Milli.zero;

		// Video paces off the real-time floor so it stays low-latency; audio honors the (possibly
		// larger) `latency`-driven jitter for its own delivery-jitter headroom.
		const videoBuffer = Time.Milli.add(video, videoJitter);
		this.#buffer.set(videoBuffer);
		// Never let the audio floor drop below the video floor: audio may lag video but must not lead it
		// (audio-ahead is the intolerant lip-sync direction), e.g. adaptive/low latency on a high-RTT link.
		this.#audioBuffer.set(Time.Milli.max(videoBuffer, Time.Milli.add(Time.Milli.max(video, audio), jitter)));

		this.#update.resolve();
		this.#update = Promise.withResolvers();
	}

	// Fold a newly received frame into the reference. The reference anchors playback to the
	// wall clock; we lower it (skip ahead) only when keeping it would push latency past the cap.
	received(timestamp: Time.Milli, label = ""): void {
		this.timestamp.update((current) => (current === undefined || timestamp > current ? timestamp : current));
		const now = Time.Milli.now();

		if (label === "audio") this.#observeAudioJitter(now, timestamp);

		const ref = Time.Milli.sub(now, timestamp);
		const currentRef = this.#reference.peek();

		// First frame anchors the reference.
		if (currentRef === undefined) {
			this.#setReference(ref);
			return;
		}

		// Check if `wait()` would not sleep at all.
		// NOTE: We check here instead of in `wait()` so we can identify when frames are received late.
		// Otherwise, chained `wait()` calls would cause a false-positive during CPU starvation.
		const floor = this.#buffer.peek();
		const sleep = Time.Milli.add(Time.Milli.sub(currentRef, ref), floor);
		if (sleep < 0) {
			const entry = this.#late.get(label);
			if (entry) {
				entry.count++;
				entry.maxMs = Math.max(entry.maxMs, -sleep);
			} else {
				this.#late.set(label, { count: 1, maxMs: -sleep });
			}
		} else {
			const entry = this.#late.get(label);
			if (entry) {
				const prefix = label ? `sync[${label}]` : "sync";
				const behind = Sync.#formatDuration(entry.maxMs);
				console.debug(`${prefix}: ${entry.count} late frame(s), max ${behind} behind`);
				this.#late.delete(label);
			}
		}

		// Frame isn't earlier than the anchor: it can't lower latency, so keep the reference.
		if (ref >= currentRef) return;

		// Frame is earlier (more lookahead). `sleep` is the latency keeping the anchor would impose.
		const cap = this.#latencyCap();
		if (sleep <= cap) return; // within budget: let the buffer grow instead of skipping ahead

		// Over the cap: re-anchor down so the resulting latency is exactly the cap.
		this.#setReference(Time.Milli.add(ref, (cap - floor) as Time.Milli));
	}

	// Update the adaptive audio floor from inter-arrival jitter. `d` is the deviation between actual
	// and expected inter-arrival (arrival delta minus timestamp delta); smoothed RFC3550-style, then a
	// clamped multiple of it becomes the floor so it grows on a jittery link and settles when stable.
	#observeAudioJitter(arrival: Time.Milli, timestamp: Time.Milli): void {
		if (this.#lastAudioArrival !== undefined && this.#lastAudioTs !== undefined) {
			const arrivalDelta = Number(Time.Milli.sub(arrival, this.#lastAudioArrival));
			const tsDelta = Number(Time.Milli.sub(timestamp, this.#lastAudioTs));
			const d = Math.abs(arrivalDelta - tsDelta);
			this.#audioJitter += (d - this.#audioJitter) / 16;
			const floor = Math.min(ADAPTIVE_MAX, Math.max(MIN_JITTER, this.#audioJitter * ADAPTIVE_MULTIPLIER));
			// Round so sub-ms drift doesn't re-run the buffer/ring resize every frame.
			this.#audioAdaptive.set(Math.round(floor) as Time.Milli);
		}
		this.#lastAudioArrival = arrival;
		this.#lastAudioTs = timestamp;
	}

	#setReference(ref: Time.Milli): void {
		this.#reference.set(ref);
		this.#update.resolve();
		this.#update = Promise.withResolvers();
	}

	// Re-anchor playback to the next frame received. Call this at an utterance boundary
	// in buffered mode (typically alongside flushing the audio buffer) so the new content
	// plays from its own first frame instead of inheriting the previous reference.
	reset(): void {
		this.#reference.set(undefined);
		this.#late.clear();
		// Re-anchor the adaptive inter-arrival baseline so a timeline rewind (utterance boundary /
		// publisher rewind) doesn't feed a huge bogus deviation into the estimator. The smoothed
		// network estimate itself persists (a content discontinuity isn't a network change).
		this.#lastAudioArrival = undefined;
		this.#lastAudioTs = undefined;
		this.#update.resolve();
		this.#update = Promise.withResolvers();
	}

	// The PTS that should be rendering right now, derived from the reference + buffer.
	// Returns undefined if no frames have been received yet.
	now(): Time.Milli | undefined {
		const reference = this.#reference.peek();
		if (reference === undefined) return undefined;
		return Time.Milli.sub(Time.Milli.sub(Time.Milli.now(), reference), this.#buffer.peek());
	}

	// Sleep until it's time to render this frame.
	async wait(timestamp: Time.Milli): Promise<void> {
		const reference = this.#reference.peek();
		if (reference === undefined) {
			throw new Error("reference not set; call update() first");
		}

		for (;;) {
			// Sleep until it's time to decode the next frame.
			// NOTE: This function runs in parallel for each frame.
			const now = Time.Milli.now();
			const ref = Time.Milli.sub(now, timestamp);

			const currentRef = this.#reference.peek();
			if (currentRef === undefined) return;

			const sleep = Time.Milli.add(Time.Milli.sub(currentRef, ref), this.#buffer.peek());
			if (sleep <= 0) return;

			// Skip setTimeout for small sleeps; the timer resolution (~4ms) would overshoot.
			if (sleep < 5) return;

			const wait = new Promise((resolve) => setTimeout(resolve, sleep)).then(() => true);

			const ok = await Promise.race([this.#update.promise, wait]);
			if (ok) return;
		}
	}

	static #formatDuration(ms: number): string {
		ms = Math.round(ms);
		if (ms < 1000) return `${ms}ms`;
		const s = ms / 1000;
		if (s < 60) return `${Math.round(s * 10) / 10}s`;
		const m = s / 60;
		return `${Math.round(m * 10) / 10}m`;
	}

	close() {
		this.signals.close();
	}
}
