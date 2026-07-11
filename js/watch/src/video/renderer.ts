import { Time } from "@moq/net";
import { Effect, Signal } from "@moq/signals";
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

/** Options for {@link Renderer}. */
export type RendererProps = {
	/** The canvas to render decoded frames to. */
	canvas?: HTMLCanvasElement | Signal<HTMLCanvasElement | undefined>;
	/** Whether playback is paused; when paused only a single preview frame is fetched. */
	paused?: boolean | Signal<boolean>;
	/** When video is downloaded relative to the canvas position. See {@link Visible}. Defaults to `"20%"`. */
	visible?: Visible | Signal<Visible>;
};

// Paints the latest frame to a canvas. Two implementations: an OffscreenCanvas worker (paint
// off the main thread) and a main-thread fallback. Both coalesce: several frames landing within
// one refresh interval collapse to a single paint of the newest, so decode can outrun the display
// without piling up wasted paints. `frame`/`clear` take ownership of the passed VideoFrame.
interface Painter {
	// Set the canvas backing-store size in pixels.
	resize(width: number, height: number): void;
	// Whether to horizontally flip the picture (mirrored capture).
	flip(flip: boolean): void;
	// Hand over the next frame to display; the painter closes it when replaced.
	frame(frame: VideoFrame): void;
	// Drop the held frame and paint black.
	clear(): void;
	// Release the canvas and all held resources.
	close(): void;
}

// The OffscreenCanvas worker body. Kept as a string so it needs no separate bundle step and
// survives being packed into a tarball and re-bundled downstream. It owns the transferred canvas,
// holds only the newest frame, and paints on its own requestAnimationFrame (driven by the
// compositor at the display refresh rate), decoupled from any main-thread jank.
const WORKER_SRC = `
let ctx = null;
let frame = null;
let flip = false;
let raf = 0;

function paint() {
	raf = 0;
	if (!ctx) return;
	const canvas = ctx.canvas;
	ctx.fillStyle = "#000";
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	if (!frame) return;
	if (flip) {
		ctx.save();
		ctx.scale(-1, 1);
		ctx.translate(-canvas.width, 0);
		ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
		ctx.restore();
	} else {
		ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
	}
}

function schedule() {
	if (ctx && !raf) raf = requestAnimationFrame(paint);
}

self.onmessage = (e) => {
	const m = e.data;
	switch (m.type) {
		case "canvas":
			ctx = m.canvas.getContext("2d", { desynchronized: true, alpha: false });
			schedule();
			break;
		case "frame":
			if (frame) frame.close();
			frame = m.frame;
			schedule();
			break;
		case "resize":
			if (ctx && (ctx.canvas.width !== m.width || ctx.canvas.height !== m.height)) {
				ctx.canvas.width = m.width;
				ctx.canvas.height = m.height;
				schedule();
			}
			break;
		case "flip":
			flip = m.flip;
			schedule();
			break;
		case "clear":
			if (frame) { frame.close(); frame = null; }
			schedule();
			break;
	}
};
`;

let workerUrl: string | undefined;

// Build (once) an object URL for the inlined worker source.
function getWorkerUrl(): string {
	if (!workerUrl) {
		const blob = new Blob([WORKER_SRC], { type: "text/javascript" });
		workerUrl = URL.createObjectURL(blob);
	}
	return workerUrl;
}

// True when the canvas can hand control to an OffscreenCanvas worker.
function canUseWorker(canvas: HTMLCanvasElement): boolean {
	return (
		typeof Worker !== "undefined" &&
		typeof OffscreenCanvas !== "undefined" &&
		typeof canvas.transferControlToOffscreen === "function"
	);
}

// Paints on a worker thread via a transferred OffscreenCanvas. Frames are transferred (not copied)
// so the handoff is zero-copy; the worker owns and closes them.
class WorkerPainter implements Painter {
	#worker: Worker;

	constructor(canvas: HTMLCanvasElement) {
		this.#worker = new Worker(getWorkerUrl());

		let offscreen: OffscreenCanvas;
		try {
			offscreen = canvas.transferControlToOffscreen();
		} catch (err) {
			this.#worker.terminate();
			throw err;
		}

		this.#worker.postMessage({ type: "canvas", canvas: offscreen }, [offscreen]);
	}

	resize(width: number, height: number): void {
		this.#worker.postMessage({ type: "resize", width, height });
	}

	flip(flip: boolean): void {
		this.#worker.postMessage({ type: "flip", flip });
	}

	frame(frame: VideoFrame): void {
		this.#worker.postMessage({ type: "frame", frame }, [frame]);
	}

	clear(): void {
		this.#worker.postMessage({ type: "clear" });
	}

	close(): void {
		// Terminating discards the worker scope, releasing the OffscreenCanvas and any held frame.
		this.#worker.terminate();
	}
}

// Main-thread fallback when OffscreenCanvas or workers are unavailable. Same coalescing rAF loop.
class MainPainter implements Painter {
	#ctx: CanvasRenderingContext2D | undefined;
	#frame: VideoFrame | undefined;
	#flip = false;
	#raf = 0;

	constructor(canvas: HTMLCanvasElement) {
		this.#ctx = canvas.getContext("2d", { desynchronized: true, alpha: false }) ?? undefined;
	}

	#schedule(): void {
		if (this.#ctx && !this.#raf) {
			this.#raf = requestAnimationFrame(() => this.#paint());
		}
	}

	#paint(): void {
		this.#raf = 0;
		const ctx = this.#ctx;
		if (!ctx) return;

		const canvas = ctx.canvas;
		ctx.fillStyle = "#000";
		ctx.fillRect(0, 0, canvas.width, canvas.height);

		const frame = this.#frame;
		if (!frame) return;

		if (this.#flip) {
			ctx.save();
			ctx.scale(-1, 1);
			ctx.translate(-canvas.width, 0);
			ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
			ctx.restore();
		} else {
			ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
		}
	}

	resize(width: number, height: number): void {
		const canvas = this.#ctx?.canvas;
		if (canvas && (canvas.width !== width || canvas.height !== height)) {
			canvas.width = width;
			canvas.height = height;
			this.#schedule();
		}
	}

	flip(flip: boolean): void {
		this.#flip = flip;
		this.#schedule();
	}

	frame(frame: VideoFrame): void {
		this.#frame?.close();
		this.#frame = frame;
		this.#schedule();
	}

	clear(): void {
		this.#frame?.close();
		this.#frame = undefined;
		this.#schedule();
	}

	close(): void {
		if (this.#raf) cancelAnimationFrame(this.#raf);
		this.#frame?.close();
		this.#frame = undefined;
		this.#ctx = undefined;
	}
}

// Pick the worker painter when possible, falling back to the main thread on any setup failure.
function createPainter(canvas: HTMLCanvasElement): Painter {
	if (canUseWorker(canvas)) {
		try {
			return new WorkerPainter(canvas);
		} catch (err) {
			console.warn("moq-watch: offscreen render worker unavailable, painting on the main thread", err);
		}
	}
	return new MainPainter(canvas);
}

/** Decodes a video track and paints it to a canvas, gating downloads on canvas visibility. */
export class Renderer {
	decoder: Decoder;

	// The canvas to render the video to.
	canvas: Signal<HTMLCanvasElement | undefined>;

	// Whether the video is paused.
	paused: Signal<boolean>;

	// When video is downloaded relative to the canvas position. See {@link Visible}.
	visible: Signal<Visible>;

	// The most recently displayed frame, updated as decoded frames arrive.
	readonly frame = new Signal<VideoFrame | undefined>(undefined);

	// The media timestamp of the most recently displayed frame.
	readonly timestamp = new Signal<Time.Milli | undefined>(undefined);

	// The active painter for the current canvas (worker or main thread).
	#painter = new Signal<Painter | undefined>(undefined);
	// Whether video should currently download (within the configured margin and tab visible, or forced via "always").
	#visible = new Signal(false);
	#signals = new Effect();

	constructor(decoder: Decoder, props?: RendererProps) {
		this.decoder = decoder;
		this.canvas = Signal.from(props?.canvas);
		this.paused = Signal.from(props?.paused ?? false);
		this.visible = Signal.from(props?.visible ?? "20%");

		this.#signals.run(this.#runPainter.bind(this));
		this.#signals.run(this.#runVisible.bind(this));
		this.#signals.run(this.#runEnabled.bind(this));
		this.#signals.run(this.#runFrame.bind(this));
		this.#signals.run(this.#runResize.bind(this));
		this.#signals.run(this.#runFlip.bind(this));
	}

	// Create (and tear down) the painter as the canvas changes.
	#runPainter(effect: Effect): void {
		const canvas = effect.get(this.canvas);
		if (!canvas) {
			this.#painter.set(undefined);
			return;
		}

		const painter = createPainter(canvas);
		this.#painter.set(painter);
		effect.cleanup(() => {
			painter.close();
			this.#painter.set(undefined);
		});
	}

	#runResize(effect: Effect) {
		const values = effect.getAll([this.#painter, this.decoder.display]);
		if (!values) return; // Keep the current size until we have both a painter and dimensions.
		const [painter, display] = values;
		painter.resize(display.width, display.height);
	}

	#runFlip(effect: Effect) {
		const painter = effect.get(this.#painter);
		if (!painter) return;
		painter.flip(effect.get(this.decoder.source.catalog)?.flip ?? false);
	}

	// Track whether video should currently download.
	#runVisible(effect: Effect): void {
		const visible = effect.get(this.visible);

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
		const canvas = effect.get(this.canvas);
		if (!canvas) {
			this.#visible.set(false);
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

	// Detect when video should be downloaded.
	#runEnabled(effect: Effect): void {
		const paused = effect.get(this.paused);
		const visible = effect.get(this.#visible);

		effect.cleanup(() => this.decoder.enabled.set(false));

		if (!paused) {
			this.decoder.enabled.set(visible);
			return;
		}

		// When paused, fetch a single preview frame then disable.
		const frame = effect.get(this.decoder.frame);
		this.decoder.enabled.set(!frame);
	}

	// Forward each decoded frame to the painter and mirror it on the public signals.
	#runFrame(effect: Effect) {
		const painter = effect.get(this.#painter);
		if (!painter) return;

		const frame = effect.get(this.decoder.frame);
		if (frame) {
			// Clone once for the painter (which takes ownership) and once for the public signal.
			painter.frame(frame.clone());
			this.frame.update((current) => {
				current?.close();
				return frame.clone();
			});
			this.timestamp.set(Time.Milli.fromMicro(frame.timestamp as Time.Micro));
		} else {
			painter.clear();
			this.frame.update((current) => {
				current?.close();
				return undefined;
			});
			this.timestamp.set(undefined);
		}
	}

	// Close the track and all associated resources.
	close() {
		this.frame.update((current) => {
			current?.close();
			return undefined;
		});
		this.timestamp.set(undefined);
		this.#signals.close();
	}
}
