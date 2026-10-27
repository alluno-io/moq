import { type Micro, Milli } from "@moq/clock";
import { Derived, Effect, type Getter, getter, type Inputs, type Readonlys, readonlys, Signal } from "@moq/signals";
import * as Video from "@moq/video";
import type { Decoder } from "./decoder";

// Fraction of the canvas that must intersect the viewport before it counts as visible.
const INTERSECTION_THRESHOLD = 0.01;

/**
 * Controls when video is downloaded relative to the canvas position.
 *
 * - `"never"`: never download video.
 * - `"always"`: always download video, regardless of the canvas position or tab visibility.
 * - a CSS length (`"0px"`, `"200px"`, `"100%"`, ...): download while the canvas is within
 *   that distance of the viewport (used as the {@link IntersectionObserver} `rootMargin`) and
 *   the tab is visible. `"0px"` means strictly on screen; larger values pre-warm the video
 *   before it scrolls in.
 */
export type Visible = "never" | "always" | (string & {});

/** Signals the renderer reads. */
export type RendererInput = {
	// A canvas element, or an OffscreenCanvas in a worker. A canvas outside the document counts as visible.
	canvas: Getter<Video.Canvas | undefined>;

	// When video is downloaded relative to the canvas position. See {@link Visible}. Defaults to "20%".
	visible: Getter<Visible>;

	// Which graphics API draws the frames. See {@link Video.Backend}. Defaults to "auto".
	backend: Getter<Video.Backend>;

	// Whether PQ video may be presented in HDR on an HDR display. Defaults to true.
	hdr: Getter<boolean>;

	// Whether the canvas is on screen. See {@link Video.RendererInput.presented}.
	presented: Getter<boolean | undefined>;

	// Whether the display shows HDR. See {@link Video.RendererInput.hdrDisplay}.
	hdrDisplay: Getter<boolean | undefined>;
};

/** Constructor properties for {@link Renderer}. */
export type RendererProps = Inputs<RendererInput> & {
	/** Decoder supplying video frames. */
	decoder: Decoder;
};

/** Renders decoded video to a canvas. */
export class Renderer {
	/** The decoder supplying frames. */
	readonly decoder: Decoder;

	/** The wired inputs, read-only. */
	readonly in: Readonlys<RendererInput>;

	// Whether the canvas should currently download per the configured distance and tab focus.
	// The owner combines this with `paused` to drive the decoder's `enabled` input.
	#visible = new Signal(false);

	#video: Video.Renderer;

	/** The derived outputs, read-only. */
	readonly out: Readonlys<{
		// The most recently rendered frame, updated after each paint.
		frame: Getter<VideoFrame | undefined>;
		// The media timestamp of the most recently rendered frame.
		timestamp: Getter<Milli | undefined>;
		// Whether the canvas should currently download per the configured distance and tab focus.
		visible: Getter<boolean>;
		// Why drawing stopped, or undefined while healthy. See {@link Video.RendererOutput.error}.
		error: Getter<Error | undefined>;
		// How many distinct frames have reached the canvas, each counted on its first paint.
		painted: Getter<number>;
		// Whether the painted frame is presented in HDR.
		hdr: Getter<boolean>;
	}>;

	#signals = new Effect();

	constructor(props: RendererProps) {
		this.decoder = props.decoder;
		this.in = {
			canvas: getter(props?.canvas),
			visible: getter(props?.visible ?? "20%"),
			backend: getter(props?.backend ?? "auto"),
			hdr: getter(props?.hdr ?? true),
			presented: getter(props?.presented),
			hdrDisplay: getter(props?.hdrDisplay),
		};

		this.#video = new Video.Renderer({
			canvas: this.in.canvas,
			frame: this.decoder.out.frame,
			display: this.decoder.out.display,
			presentation: new Derived(
				[this.decoder.source.out.catalog, this.decoder.out.interlaced],
				(catalog, interlaced) => ({ rotation: catalog?.rotation, flip: catalog?.flip, interlaced }),
			),
			backend: this.in.backend,
			hdr: this.in.hdr,
			presented: this.in.presented,
			hdrDisplay: this.in.hdrDisplay,
		});
		this.#signals.cleanup(() => this.#video.close());

		const frame = this.#video.out.frame;
		this.out = readonlys({
			frame,
			timestamp: new Derived([frame], (frame) => (frame ? Milli.fromMicro(frame.timestamp as Micro) : undefined)),
			visible: this.#visible,
			error: this.#video.out.error,
			painted: this.#video.out.painted,
			hdr: this.#video.out.hdr,
		});

		this.#signals.run(this.#runVisible.bind(this));
	}

	// Track whether the canvas should currently download per the configured distance and tab focus.
	#runVisible(effect: Effect): void {
		const visible = effect.get(this.in.visible);

		// "never" forces the check off; "always" forces it on regardless of viewport or tab state.
		if (visible === "never") {
			this.#visible.set(false);
			return;
		}

		if (visible === "always") {
			this.#visible.set(true);
			effect.cleanup(() => this.#visible.set(false));
			return;
		}

		// A distance gates on the viewport (used as the rootMargin) and the tab being visible.
		const canvas = effect.get(this.in.canvas);
		if (!canvas) {
			this.#visible.set(false);
			return;
		}

		// Nothing can observe a canvas outside the document, so its owner decides through `visible` alone.
		if (typeof HTMLCanvasElement === "undefined" || !(canvas instanceof HTMLCanvasElement)) {
			this.#visible.set(true);
			effect.cleanup(() => this.#visible.set(false));
			return;
		}

		let intersecting = false;
		const update = () => {
			this.#visible.set(intersecting && !document.hidden);
		};

		const callback = (entries: IntersectionObserverEntry[]) => {
			for (const entry of entries) {
				intersecting = entry.isIntersecting;
				update();
			}
		};

		// `visible` is a CSS length, but the programmatic API accepts arbitrary strings. An
		// invalid rootMargin throws a SyntaxError, so fall back to the default margin.
		let observer: IntersectionObserver;
		try {
			observer = new IntersectionObserver(callback, { threshold: INTERSECTION_THRESHOLD, rootMargin: visible });
		} catch {
			console.warn(`moq-watch: invalid visible margin "${visible}", using "0px"`);
			observer = new IntersectionObserver(callback, { threshold: INTERSECTION_THRESHOLD });
		}

		update();
		effect.event(document, "visibilitychange", update);
		observer.observe(canvas);
		effect.cleanup(() => observer.disconnect());
		effect.cleanup(() => this.#visible.set(false));
	}

	/** Close the track and all associated resources. */
	close() {
		this.#signals.close();
	}
}
