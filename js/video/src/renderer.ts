import { Effect, type Getter, getter, type Inputs, type Readonlys, readonlys, Signal } from "@moq/signals";
import { Canvas2D } from "./canvas2d";
import type { Dimensions, Presentation, Rect } from "./presentation";
import { Gpu, hdrSupport, probe } from "./webgpu";

/**
 * Which graphics API draws the frames.
 *
 * - `"auto"`: WebGPU where it can render a `VideoFrame`, else Canvas2D. Logs the choice.
 * - `"webgpu"`: WebGPU only; refuses with the `"unsupported"` error where it is missing.
 * - `"2d"`: Canvas2D only.
 */
export type Backend = "auto" | "webgpu" | "2d";

/**
 * Why the renderer stopped drawing.
 *
 * - `"unsupported"`: `"webgpu"` was requested where WebGPU cannot render a `VideoFrame`.
 * - `"surface-lost"`: the canvas cannot be drawn to anymore, because the GPU went away with no
 *   replacement or the canvas already holds another kind of context. Pass a fresh canvas to recover.
 */
export type RendererError = "unsupported" | "surface-lost";

/** A canvas the renderer can draw into, on the main thread or in a worker. */
export type Canvas = HTMLCanvasElement | OffscreenCanvas;

/** Signals the renderer reads. */
export type RendererInput = {
	/** The canvas to draw into. A new canvas clears {@link RendererOutput.error} and selects again. */
	canvas: Getter<Canvas | undefined>;
	/** The frame to draw. Borrowed: the renderer clones what it keeps. */
	frame: Getter<VideoFrame | undefined>;
	/** The canvas size in pixels. Undefined leaves the canvas size alone. */
	display: Getter<Dimensions | undefined>;
	/** The rotation and flip to draw the frame with. */
	presentation: Getter<Presentation | undefined>;
	/**
	 * Where the frame lands on the canvas, in canvas pixels; undefined fills the canvas. It may reach
	 * past the canvas edges to show part of the frame, and WebGPU upscales and sharpens a frame it
	 * magnifies.
	 */
	view: Getter<Rect | undefined>;
	/** Which graphics API to draw with. Defaults to `"auto"`. */
	backend: Getter<Backend>;
	/** Whether PQ video may be presented in HDR on an HDR display. Defaults to true. */
	hdr: Getter<boolean>;
};

/** Constructor options for {@link Renderer}. */
export type RendererProps = Inputs<RendererInput>;

/** Signals the renderer writes. */
export type RendererOutput = {
	/** The most recently painted frame, owned by the renderer and closed when replaced. */
	frame: Signal<VideoFrame | undefined>;
	/** Why drawing stopped, or undefined while healthy. */
	error: Signal<RendererError | undefined>;
	/** How many distinct frames have reached the canvas, each counted on its first paint. */
	painted: Signal<number>;
	/** Whether the painted frame is presented in HDR. */
	hdr: Signal<boolean>;
};

type Surface = Gpu | Canvas2D;

/**
 * Draws video frames into a canvas, once per animation frame, through WebGPU or Canvas2D.
 *
 * The graphics API is chosen once per canvas, before touching it, since a canvas keeps the first
 * kind of context it hands out. A lost GPU device is replaced; with no replacement the renderer
 * stops and reports `"surface-lost"` rather than switching APIs on a canvas it already drew to.
 */
export class Renderer {
	/** Inputs wired into the renderer. */
	readonly in: Readonlys<RendererInput>;

	readonly #out: RendererOutput = {
		frame: new Signal<VideoFrame | undefined>(undefined),
		error: new Signal<RendererError | undefined>(undefined),
		painted: new Signal<number>(0),
		hdr: new Signal<boolean>(false),
	};
	/** The painted frame and error state. */
	readonly out = readonlys(this.#out);

	#surface = new Signal<Surface | undefined>(undefined);
	#restored = new Signal<number>(0);
	#displayHdr = new Signal<boolean>(false);
	#counted?: VideoFrame;
	#signals = new Effect();

	constructor(props?: RendererProps) {
		this.in = {
			canvas: getter(props?.canvas),
			frame: getter(props?.frame),
			display: getter(props?.display),
			presentation: getter(props?.presentation),
			view: getter(props?.view),
			backend: getter(props?.backend ?? "auto"),
			hdr: getter(props?.hdr ?? true),
		};

		this.#signals.run(this.#runSurface.bind(this));
		this.#signals.run(this.#runResize.bind(this));
		this.#signals.run(this.#runRender.bind(this));

		if (typeof matchMedia === "function") {
			const query = matchMedia("(dynamic-range: high)");
			const update = () => this.#displayHdr.set(query.matches);
			update();
			this.#signals.event(query, "change", update);
		}
	}

	#runSurface(effect: Effect): void {
		const canvas = effect.get(this.in.canvas);
		const backend = effect.get(this.in.backend);

		this.#out.error.set(undefined);
		if (!canvas) return;

		if (backend === "2d") {
			this.#use2d(effect, canvas);
			return;
		}

		effect.spawn(async () => {
			const device = await probe();
			if (effect.abort.aborted) {
				if (typeof device !== "string") device.destroy();
				return;
			}

			if (typeof device === "string") {
				if (backend === "webgpu") {
					console.error(`[video] backend="webgpu" is unsupported: ${device}`);
					this.#out.error.set("unsupported");
					return;
				}

				console.debug(`[video] rendering with Canvas2D: ${device}`);
				this.#use2d(effect, canvas);
				return;
			}

			// getContext overloads do not resolve on a union receiver, so name the result.
			const context = canvas.getContext("webgpu") as GPUCanvasContext | null;
			if (!context) {
				device.destroy();

				// Only "auto" may fall back, and only because nothing has drawn to the canvas through
				// WebGPU: the canvas already holds a 2d context, which it will hand back.
				if (backend === "auto") {
					this.#use2d(effect, canvas);
					return;
				}

				this.#out.error.set("surface-lost");
				return;
			}

			console.debug("[video] rendering with WebGPU");
			await this.#useGpu(effect, context, device, presentable(canvas));
		});
	}

	#use2d(effect: Effect, canvas: Canvas): void {
		const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
		if (!ctx) {
			this.#out.error.set("surface-lost");
			return;
		}

		effect.set(this.#surface, new Canvas2D(ctx), undefined);
		effect.event(canvas, "contextrestored", () => this.#restored.update((count) => count + 1));
	}

	// Keep drawing through `device`, replacing it whenever it is lost, until the run ends.
	async #useGpu(effect: Effect, context: GPUCanvasContext, device: GPUDevice, hdr: boolean): Promise<void> {
		let current = device;
		let surface: Gpu | undefined;

		effect.cleanup(() => {
			this.#surface.set(undefined);
			surface?.close();
			current.destroy();
		});

		for (;;) {
			const support = await hdrSupport(current);
			if (effect.abort.aborted) return;

			surface = new Gpu(context, current, { model: support.model, extended: hdr && support.extended });
			this.#surface.set(surface);

			const lost = await effect.race(current.lost);
			if (!lost) return;

			this.#surface.set(undefined);
			surface.close();
			surface = undefined;
			console.warn(`[video] WebGPU device lost (${lost.reason}): ${lost.message}`);

			const next = await probe();
			if (effect.abort.aborted) {
				if (typeof next !== "string") next.destroy();
				return;
			}

			// The canvas already has a WebGPU context and never hands out a 2d one, so there is
			// nothing to fall back to on this canvas.
			if (typeof next === "string") {
				console.error(`[video] WebGPU device lost with no replacement: ${next}`);
				this.#out.error.set("surface-lost");
				return;
			}

			current = next;
		}
	}

	#runResize(effect: Effect): void {
		const values = effect.getAll([this.in.canvas, this.in.display]);
		if (!values) return;
		const [canvas, display] = values;

		// Setting the size clears the canvas, even to the same value.
		if (canvas.width !== display.width || canvas.height !== display.height) {
			canvas.width = display.width;
			canvas.height = display.height;
		}
	}

	#runRender(effect: Effect): void {
		const surface = effect.get(this.#surface);
		if (!surface) {
			this.#out.hdr.set(false);
			return;
		}

		const frame = effect.get(this.in.frame);
		const presentation = effect.get(this.in.presentation);
		const view = effect.get(this.in.view);
		const hdr = effect.get(this.in.hdr) && effect.get(this.#displayHdr);

		// A resize clears the canvas, so paint again afterwards.
		effect.get(this.in.display);
		effect.get(this.#restored);

		// Draw at the display's refresh rate. Always draw, even when paused, to show the last frame.
		let animate: number | undefined = requestAnimationFrame(() => {
			animate = undefined;
			const drawn =
				surface instanceof Gpu
					? surface.draw(frame, presentation, hdr, view)
					: surface.draw(frame, presentation, view);
			if (!drawn) return;
			this.#out.hdr.set(surface instanceof Gpu && surface.hdr);

			this.#out.frame.update((current) => {
				current?.close();
				return frame?.clone();
			});
			if (frame && frame !== this.#counted) {
				this.#counted = frame;
				this.#out.painted.update((count) => count + 1);
			}
		});

		effect.cleanup(() => {
			if (animate !== undefined) cancelAnimationFrame(animate);
		});
	}

	/** Stop drawing and release the canvas context, the GPU device, and the painted frame. */
	close(): void {
		this.#out.hdr.set(false);
		this.#signals.close();
		this.#out.frame.update((current) => {
			current?.close();
			return undefined;
		});
	}
}

function presentable(canvas: Canvas): boolean {
	return typeof HTMLCanvasElement !== "undefined" && canvas instanceof HTMLCanvasElement;
}
