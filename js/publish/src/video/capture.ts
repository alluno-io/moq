import { Time } from "@moq/net";
import { Effect, type Getter, getter, type Inputs, type Readonlys, readonlys, Signal } from "@moq/signals";
import { Fanout } from "../fanout";
import { reportsRotation, watchRotation } from "./orientation";
import { type Stamped, TrackProcessor } from "./processor";
import { normalizeSource, type Source } from "./types";

// The raw capture source to pump frames from.
export type CaptureInput = {
	source: Getter<Source | undefined>;
};

type CaptureOutput = {
	// The captured frames, replaced whenever the source changes. Subscribe for a stream of your own,
	// starting with a copy of the current picture; each reader owns the frames it receives and must
	// close them.
	frames: Signal<Fanout<VideoFrame> | undefined>;
	// The captured dimensions, source scale, and the clockwise turn the picture is shown with, sampled
	// together for each frame.
	display: Signal<Display | undefined>;
};

type Display = { width: number; height: number; scale?: number; rotation?: number };

/**
 * Pumps frames off a capture {@link Source} and distributes them to any number of readers.
 *
 * Split out of the encoders so one capture feeds every rendition, the preview, and the stats. Each
 * reader gets its own copy of every frame and closes what it receives; a reader that falls behind
 * loses its own oldest rather than stalling the capture. A new reader starts with the current
 * picture, so a still source (a screen share of an unchanging slide) is visible to it.
 */
export class Capture {
	readonly in: Readonlys<CaptureInput>;

	readonly #out: CaptureOutput = {
		frames: new Signal<Fanout<VideoFrame> | undefined>(undefined),
		display: new Signal<Display | undefined>(undefined),
	};
	readonly out = readonlys(this.#out);

	#signals = new Effect();

	constructor(props?: Inputs<CaptureInput>) {
		this.in = {
			source: getter(props?.source),
		};

		this.#signals.run(this.#run.bind(this));
	}

	#run(effect: Effect) {
		const source = effect.get(this.in.source);
		if (!source) return;

		// A capture track goes through MediaStreamTrackProcessor, which times each frame on our wall
		// clock so they stay consistent when the source changes or the encoder reloads. A FrameSource
		// already stamps against that clock, so take its frames as they are.
		const stream: ReadableStream<Stamped> =
			"frames" in source ? source.frames.pipeThrough(asStamped()) : TrackProcessor(normalizeSource(source).track);

		const rotation = new Signal(0);
		if (!("frames" in source) && !reportsRotation()) watchRotation(effect, normalizeSource(source).track, rotation);

		const fanout = new Frames(stream.pipeThrough(this.#measure(source, rotation)));
		effect.cleanup(() => fanout.close());

		effect.set(this.#out.frames, fanout, undefined);
		effect.cleanup(() => {
			this.#out.display.set(undefined);
		});
	}

	// Sample live source metadata even when the coded dimensions stay unchanged.
	#measure(source: Source, rotation: Signal<number>): TransformStream<Stamped, Stamped> {
		return new TransformStream<Stamped, Stamped>({
			transform: (stamped, controller) => {
				const { frame } = stamped;
				try {
					const scale = "frames" in source ? undefined : normalizeSource(source).scale;
					const turn = (frame as VideoFrame & { rotation?: number }).rotation ?? rotation.peek();
					this.#out.display.set({
						width: frame.codedWidth,
						height: frame.codedHeight,
						scale,
						rotation: turn || undefined,
					});
					controller.enqueue(stamped);
				} catch (error) {
					frame.close();
					throw error;
				}
			},
		});
	}

	close() {
		this.#signals.close();
	}
}

// A fanout that holds the newest frame and opens every new reader with a copy of it. A still source
// delivers a frame only when its picture changes, so without this a reader that attaches later (a
// late viewer, an encoder resuming after a demand gap) waits for a change that may never come.
// Video only: replaying audio would repeat sound.
class Frames extends Fanout<VideoFrame> {
	// The newest frame through, owned here and dropped once closed. Boxed because the tap that fills
	// it is built before super().
	readonly #held: Held;

	// Copies handed to new readers and not yet read, released on close like the fanout's own queues.
	readonly #unread = new Set<VideoFrame>();

	constructor(source: ReadableStream<Stamped>) {
		const held: Held = { closed: false };
		const hold = new TransformStream<Stamped, VideoFrame>({
			transform: ({ frame, timestamp }, controller) => {
				held.frame?.close();
				held.frame = held.closed ? undefined : frame.clone();
				if (frame.timestamp === timestamp) {
					controller.enqueue(frame);
					return;
				}

				let stamped: VideoFrame;
				try {
					stamped = new VideoFrame(frame, { timestamp });
				} finally {
					frame.close();
				}
				controller.enqueue(stamped);
			},
		});

		super(source.pipeThrough(hold), {
			// A frame is a resource with an explicit lifetime, so every reader needs its own handle
			// and closes it. Sharing one would let the first reader close it under the others.
			clone: (frame) => frame.clone(),
			release: (frame) => frame.close(),
		});

		this.#held = held;
	}

	override subscribe(effect: Effect, queue?: number): ReadableStream<VideoFrame> {
		const live = super.subscribe(effect, queue);
		const held = this.#held.frame;
		if (!held) return live;

		// Re-stamped to now. The held frame may be minutes old, and publishing it at its capture time
		// would deliver it that late, a delay the jitter estimate keeps for the life of the stream.
		const at = Time.Micro.fromMilli(performance.now() as Time.Milli);
		let first: VideoFrame | undefined = new VideoFrame(held, { timestamp: at });
		this.#unread.add(first);
		const release = () => {
			if (first && this.#unread.delete(first)) first.close();
			first = undefined;
		};
		effect.cleanup(release);

		const reader = live.getReader();
		return new ReadableStream<VideoFrame>(
			{
				pull: async (controller) => {
					const copy = first;
					first = undefined;
					// Already released if the capture closed first.
					if (copy && this.#unread.delete(copy)) {
						controller.enqueue(copy);
						return;
					}

					for (;;) {
						const { value } = await reader.read();
						if (!value) {
							controller.close();
							return;
						}

						// A frame captured just before the copy's stamp would run time backwards.
						if (value.timestamp > at) {
							controller.enqueue(value);
							return;
						}

						value.close();
					}
				},
				cancel: async (reason) => {
					release();
					await reader.cancel(reason);
				},
			},
			// Pull on demand, so the fanout's queue stays the only buffer and its drop policy holds.
			{ highWaterMark: 0 },
		);
	}

	override close(): void {
		super.close();
		this.#held.closed = true;
		this.#held.frame?.close();
		this.#held.frame = undefined;

		for (const frame of this.#unread) frame.close();
		this.#unread.clear();
	}
}

type Held = { frame?: VideoFrame; closed: boolean };

function asStamped(): TransformStream<VideoFrame, Stamped> {
	return new TransformStream<VideoFrame, Stamped>({
		transform: (frame, controller) => controller.enqueue({ frame, timestamp: frame.timestamp }),
	});
}
