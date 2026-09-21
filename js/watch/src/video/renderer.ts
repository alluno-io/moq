/// <reference types="@webgpu/types" />
import { Time } from "@moq/net";
import { Effect, Signal } from "@moq/signals";
import type { Decoder } from "./decoder";
import { CALIBRATION_TOLERANCE, classifyImport, type ImportModel, PQ_CALIBRATION, PQ_REFERENCE_WHITE } from "./hdr";

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

/** Which surface paints the video: a main-thread WebGPU context (HDR capable) or a 2D canvas context. */
export type PaintPath = "webgpu" | "2d";

/** Options for {@link Renderer}. */
export type RendererProps = {
	/** The canvas to render decoded frames to. */
	canvas?: HTMLCanvasElement | Signal<HTMLCanvasElement | undefined>;
	/** Whether playback is paused; when paused only a single preview frame is fetched. */
	paused?: boolean | Signal<boolean>;
	/** When video is downloaded relative to the canvas position. See {@link Visible}. Defaults to `"20%"`. */
	visible?: Visible | Signal<Visible>;
	/**
	 * Present PQ (HDR10) video in HDR when the canvas sits on an HDR display and the browser
	 * can paint it through WebGPU on the main thread (Chromium); otherwise the 2D canvas
	 * worker tone-maps to SDR. Read when a canvas is attached, since a canvas can hand
	 * control to one painter only. Defaults to `true`.
	 */
	hdr?: boolean | Signal<boolean>;
};

// Paints the latest frame to a canvas. Every implementation coalesces: several frames landing
// within one refresh interval collapse to a single paint of the newest, so decode can outrun the
// display without piling up wasted paints. `frame`/`clear` take ownership of the passed VideoFrame.
interface Painter {
	// Whether the frame on screen is presented in HDR.
	readonly hdr: Signal<boolean>;
	// Which surface ended up painting, once known.
	readonly path: Signal<PaintPath | undefined>;
	// Set the canvas backing-store size in pixels.
	resize(width: number, height: number): void;
	// Whether to horizontally flip the picture (mirrored capture).
	flip(flip: boolean): void;
	// Whether the display the canvas sits on can show HDR.
	display(hdr: boolean): void;
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
	readonly hdr = new Signal(false);
	readonly path = new Signal<PaintPath | undefined>("2d");
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

	display(): void {}

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
	readonly hdr = new Signal(false);
	readonly path = new Signal<PaintPath | undefined>("2d");
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

	display(): void {}

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

// The WebGPU paint shader. Mode 0 passes the browser's conversion through (SDR video, or a
// browser that already presents PQ natively). Modes 1 and 2 take a PQ frame the browser handed
// over as its raw signal (see hdr.ts): undo the gamut matrix and sRGB encoding it applied, run the
// PQ transfer to absolute light, scale reference white onto SDR white, and either emit extended
// sRGB for an HDR display (1) or roll highlights off into SDR (2).
const SHADER_SRC = `
struct Uniforms { flip: u32, mode: u32, white: f32, pad: f32 };
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var smp: sampler;
@group(0) @binding(2) var tex: texture_external;

struct VSOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };

@vertex fn vs(@builtin(vertex_index) i: u32) -> VSOut {
	var p = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
	var o: VSOut;
	o.pos = vec4(p[i], 0.0, 1.0);
	var uv = vec2(p[i].x * 0.5 + 0.5, 1.0 - (p[i].y * 0.5 + 0.5));
	if (u.flip == 1u) { uv.x = 1.0 - uv.x; }
	o.uv = uv;
	return o;
}

const M709_TO_2020 = mat3x3<f32>(
	vec3(0.627402, 0.069095, 0.016394),
	vec3(0.329292, 0.919544, 0.088028),
	vec3(0.043306, 0.011360, 0.895578));
const M2020_TO_709 = mat3x3<f32>(
	vec3(1.660491, -0.124550, -0.018151),
	vec3(-0.587641, 1.132900, -0.100579),
	vec3(-0.072850, -0.008349, 1.118730));

fn srgb_decode(c: vec3<f32>) -> vec3<f32> {
	let a = abs(c);
	let lo = a / 12.92;
	let hi = pow((a + 0.055) / 1.055, vec3(2.4));
	return sign(c) * select(hi, lo, a <= vec3(0.04045));
}

fn srgb_encode(c: vec3<f32>) -> vec3<f32> {
	let a = abs(c);
	let lo = a * 12.92;
	let hi = 1.055 * pow(a, vec3(1.0 / 2.4)) - 0.055;
	return sign(c) * select(hi, lo, a <= vec3(0.0031308));
}

fn pq_eotf(e: vec3<f32>) -> vec3<f32> {
	let m1 = 0.1593017578125;
	let m2 = 78.84375;
	let c1 = 0.8359375;
	let c2 = 18.8515625;
	let c3 = 18.6875;
	let ep = pow(clamp(e, vec3(0.0), vec3(1.0)), vec3(1.0 / m2));
	let num = max(ep - c1, vec3(0.0));
	let den = c2 - c3 * ep;
	return pow(num / den, vec3(1.0 / m1)) * 10000.0;
}

fn roll_off(c: vec3<f32>) -> vec3<f32> {
	let y = dot(c, vec3(0.2126, 0.7152, 0.0722));
	let knee = 0.8;
	if (y <= knee) { return c; }
	let t = (y - knee) / (1.0 - knee);
	let yn = knee + (1.0 - knee) * (1.0 - exp(-t));
	return c * (yn / y);
}

@fragment fn fs(in: VSOut) -> @location(0) vec4<f32> {
	let s = textureSampleBaseClampToEdge(tex, smp, in.uv);
	if (u.mode == 0u) { return vec4(s.rgb, 1.0); }
	let signal = M709_TO_2020 * srgb_decode(s.rgb);
	var lin = M2020_TO_709 * (pq_eotf(signal) / u.white);
	if (u.mode == 2u) { lin = clamp(roll_off(max(lin, vec3(0.0))), vec3(0.0), vec3(1.0)); }
	return vec4(srgb_encode(lin), 1.0);
}
`;

// Read one half-precision float.
function f16(bits: number): number {
	const s = bits & 0x8000 ? -1 : 1;
	const e = (bits >> 10) & 0x1f;
	const m = bits & 0x3ff;
	if (e === 0) return s * 2 ** -14 * (m / 1024);
	if (e === 31) return m ? Number.NaN : s * Number.POSITIVE_INFINITY;
	return s * 2 ** (e - 15) * (1 + m / 1024);
}

// The bundled DOM typings predate the PQ and BT.2020 WebCodecs colour space names.
const PQ_COLOR_SPACE = {
	primaries: "bt2020",
	transfer: "pq",
	matrix: "bt2020-ncl",
	fullRange: false,
} as unknown as VideoColorSpaceInit;

function isPq(frame: VideoFrame): boolean {
	return (frame.colorSpace?.transfer as string | null | undefined) === "pq";
}

// Everything a WebGPU painter needs besides its canvas, proven to work before the canvas is touched.
type GpuState = {
	device: GPUDevice;
	module: GPUShaderModule;
	sampler: GPUSampler;
	uniform: GPUBuffer;
	pipelines: Map<GPUTextureFormat, GPURenderPipeline>;
	preferred: GPUTextureFormat;
	model: ImportModel;
};

function pipelineFor(state: GpuState, format: GPUTextureFormat): GPURenderPipeline {
	let pipeline = state.pipelines.get(format);
	if (!pipeline) {
		pipeline = state.device.createRenderPipeline({
			layout: "auto",
			vertex: { module: state.module, entryPoint: "vs" },
			fragment: { module: state.module, entryPoint: "fs", targets: [{ format }] },
			primitive: { topology: "triangle-list" },
		});
		state.pipelines.set(format, pipeline);
	}
	return pipeline;
}

// Encode one full-canvas draw of `source` into `view`.
function encodeDraw(
	state: GpuState,
	view: GPUTextureView,
	format: GPUTextureFormat,
	source: VideoFrame,
	mode: number,
	flip: boolean,
): GPUCommandEncoder {
	const pipeline = pipelineFor(state, format);
	state.device.queue.writeBuffer(state.uniform, 0, new Uint32Array([flip ? 1 : 0, mode]));
	state.device.queue.writeBuffer(state.uniform, 8, new Float32Array([PQ_REFERENCE_WHITE, 0]));
	const external = state.device.importExternalTexture({ source });
	const bind = state.device.createBindGroup({
		layout: pipeline.getBindGroupLayout(0),
		entries: [
			{ binding: 0, resource: { buffer: state.uniform } },
			{ binding: 1, resource: state.sampler },
			{ binding: 2, resource: external },
		],
	});
	const encoder = state.device.createCommandEncoder();
	const pass = encoder.beginRenderPass({
		colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
	});
	pass.setPipeline(pipeline);
	pass.setBindGroup(0, bind);
	pass.draw(3);
	pass.end();
	return encoder;
}

// Render the calibration patches through the passthrough mode and classify what came back.
async function calibrate(state: Omit<GpuState, "model">): Promise<ImportModel | undefined> {
	const texture = state.device.createTexture({
		size: [2, 2],
		format: "rgba16float",
		usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
	});
	const buffer = state.device.createBuffer({ size: 512, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
	const samples: number[] = [];
	try {
		for (const patch of PQ_CALIBRATION) {
			const c = patch.code;
			const source = new VideoFrame(new Uint8Array([c, c, c, c, 128, 128]), {
				format: "I420",
				codedWidth: 2,
				codedHeight: 2,
				timestamp: 0,
				colorSpace: PQ_COLOR_SPACE,
			});
			try {
				const encoder = encodeDraw(
					{ ...state, model: "signal" },
					texture.createView(),
					"rgba16float",
					source,
					0,
					false,
				);
				encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: 256 }, [2, 2]);
				state.device.queue.submit([encoder.finish()]);
				await buffer.mapAsync(GPUMapMode.READ);
				samples.push(f16(new Uint16Array(buffer.getMappedRange())[0]));
				buffer.unmap();
			} finally {
				source.close();
			}
		}
	} finally {
		texture.destroy();
		buffer.destroy();
	}
	return classifyImport(samples, PQ_CALIBRATION, CALIBRATION_TOLERANCE);
}

// Paints on the main thread through WebGPU so a PQ frame reaches the compositor in HDR. This
// has to be the main thread: a worker's transferred OffscreenCanvas is presented clamped to SDR
// white even when extended tone mapping was accepted (Chromium 153, measured through the
// desktop's FP16 duplication). `create` proves the adapter, extended tone mapping and the
// calibration on a throwaway canvas before binding the real one, because a canvas that has
// handed out a WebGPU context can no longer be transferred to the worker painter.
class GpuPainter implements Painter {
	readonly hdr = new Signal(false);
	readonly path = new Signal<PaintPath | undefined>("webgpu");
	#state: GpuState;
	#context: GPUCanvasContext;
	#format: GPUTextureFormat | undefined;
	#frame: VideoFrame | undefined;
	#flip = false;
	#displayHdr = false;
	#raf = 0;

	private constructor(state: GpuState, context: GPUCanvasContext) {
		this.#state = state;
		this.#context = context;
	}

	static async create(canvas: HTMLCanvasElement): Promise<GpuPainter | undefined> {
		if (typeof navigator === "undefined" || !navigator.gpu || typeof OffscreenCanvas === "undefined")
			return undefined;
		const adapter = await navigator.gpu.requestAdapter();
		if (!adapter) return undefined;
		const device = await adapter.requestDevice();
		const probe = new OffscreenCanvas(1, 1).getContext("webgpu");
		if (!probe || typeof probe.getConfiguration !== "function") return undefined;
		probe.configure({
			device,
			format: "rgba16float",
			toneMapping: { mode: "extended" },
			colorSpace: "srgb",
			alphaMode: "opaque",
		});
		const configured = probe.getConfiguration();
		probe.unconfigure();
		if (configured?.toneMapping?.mode !== "extended") return undefined;

		const base = {
			device,
			module: device.createShaderModule({ code: SHADER_SRC }),
			sampler: device.createSampler({ magFilter: "linear", minFilter: "linear" }),
			uniform: device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
			pipelines: new Map<GPUTextureFormat, GPURenderPipeline>(),
			preferred: navigator.gpu.getPreferredCanvasFormat(),
		};
		const model = await calibrate(base);
		if (!model) return undefined;
		const context = canvas.getContext("webgpu");
		if (!context) return undefined;
		return new GpuPainter({ ...base, model }, context);
	}

	#configure(hdr: boolean): void {
		const format = hdr ? "rgba16float" : this.#state.preferred;
		if (this.#format === format) return;
		this.#context.configure({
			device: this.#state.device,
			format,
			toneMapping: { mode: hdr ? "extended" : "standard" },
			colorSpace: "srgb",
			alphaMode: "opaque",
		});
		this.#format = format;
	}

	#schedule(): void {
		if (!this.#raf) this.#raf = requestAnimationFrame(() => this.#paint());
	}

	#paint(): void {
		this.#raf = 0;
		try {
			const frame = this.#frame;
			const pq = !!frame && isPq(frame);
			const hdr = pq && this.#displayHdr;
			this.#configure(hdr);
			const format = this.#format ?? this.#state.preferred;
			const view = this.#context.getCurrentTexture().createView();
			let encoder: GPUCommandEncoder;
			if (frame) {
				const mode = !pq || this.#state.model === "native" ? 0 : hdr ? 1 : 2;
				encoder = encodeDraw(this.#state, view, format, frame, mode, this.#flip);
			} else {
				encoder = this.#state.device.createCommandEncoder();
				encoder
					.beginRenderPass({
						colorAttachments: [
							{ view, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } },
						],
					})
					.end();
			}
			this.#state.device.queue.submit([encoder.finish()]);
			this.hdr.set(hdr);
		} catch (err) {
			console.warn("moq-watch: webgpu paint failed", err);
		}
	}

	resize(width: number, height: number): void {
		const canvas = this.#context.canvas;
		if (canvas.width !== width || canvas.height !== height) {
			canvas.width = width;
			canvas.height = height;
			this.#schedule();
		}
	}

	flip(flip: boolean): void {
		this.#flip = flip;
		this.#schedule();
	}

	display(hdr: boolean): void {
		this.#displayHdr = hdr;
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
		this.hdr.set(false);
		this.#context.unconfigure();
		this.#state.device.destroy();
	}
}

// Holds what arrives while the WebGPU probe runs, then replays it into whichever painter wins.
class PendingPainter implements Painter {
	readonly hdr = new Signal(false);
	readonly path = new Signal<PaintPath | undefined>(undefined);
	#size: { width: number; height: number } | undefined;
	#flip: boolean | undefined;
	#display: boolean | undefined;
	#frame: VideoFrame | undefined;

	resize(width: number, height: number): void {
		this.#size = { width, height };
	}

	flip(flip: boolean): void {
		this.#flip = flip;
	}

	display(hdr: boolean): void {
		this.#display = hdr;
	}

	frame(frame: VideoFrame): void {
		this.#frame?.close();
		this.#frame = frame;
	}

	clear(): void {
		this.#frame?.close();
		this.#frame = undefined;
	}

	close(): void {
		this.#frame?.close();
		this.#frame = undefined;
	}

	// Replay the held state into `painter`, handing over the held frame.
	handOver(painter: Painter): void {
		if (this.#size) painter.resize(this.#size.width, this.#size.height);
		if (this.#flip !== undefined) painter.flip(this.#flip);
		if (this.#display !== undefined) painter.display(this.#display);
		if (this.#frame) {
			painter.frame(this.#frame);
			this.#frame = undefined;
		}
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

// Whether the canvas sits on a display that can show HDR right now.
function displayIsHdr(): boolean {
	return typeof matchMedia === "function" && matchMedia("(dynamic-range: high)").matches;
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

	// Whether PQ video may be presented in HDR through WebGPU. See {@link RendererProps.hdr}.
	hdr: Signal<boolean>;

	// The most recently displayed frame, updated as decoded frames arrive.
	readonly frame = new Signal<VideoFrame | undefined>(undefined);

	// The media timestamp of the most recently displayed frame.
	readonly timestamp = new Signal<Time.Milli | undefined>(undefined);

	// Which surface paints the video, once the painter has settled on one.
	readonly path = new Signal<PaintPath | undefined>(undefined);

	// The active painter for the current canvas (worker, main thread, or pending a probe).
	#painter = new Signal<Painter | undefined>(undefined);
	// Whether video should currently download (within the configured margin and tab visible, or forced via "always").
	#visible = new Signal(false);
	#signals = new Effect();

	constructor(decoder: Decoder, props?: RendererProps) {
		this.decoder = decoder;
		this.canvas = Signal.from(props?.canvas);
		this.paused = Signal.from(props?.paused ?? false);
		this.visible = Signal.from(props?.visible ?? "20%");
		this.hdr = Signal.from(props?.hdr ?? true);

		this.#signals.run(this.#runPainter.bind(this));
		this.#signals.run(this.#runStatus.bind(this));
		this.#signals.run(this.#runDisplay.bind(this));
		this.#signals.run(this.#runVisible.bind(this));
		this.#signals.run(this.#runEnabled.bind(this));
		this.#signals.run(this.#runFrame.bind(this));
		this.#signals.run(this.#runResize.bind(this));
		this.#signals.run(this.#runFlip.bind(this));
	}

	// Create (and tear down) the painter as the canvas changes. On an HDR display with `hdr`
	// on, the WebGPU probe runs first and the worker is the fallback; everything that arrives
	// meanwhile is held by a pending painter and replayed into the winner.
	#runPainter(effect: Effect): void {
		const canvas = effect.get(this.canvas);
		if (!canvas) {
			this.#painter.set(undefined);
			return;
		}

		let live: Painter | undefined;
		let cancelled = false;
		effect.cleanup(() => {
			cancelled = true;
			live?.close();
			live = undefined;
			this.#painter.set(undefined);
		});

		if (!this.hdr.peek() || !displayIsHdr()) {
			live = createPainter(canvas);
			this.#painter.set(live);
			return;
		}

		const pending = new PendingPainter();
		live = pending;
		this.#painter.set(pending);
		GpuPainter.create(canvas).then(
			(gpu) => {
				if (cancelled) {
					gpu?.close();
					return;
				}
				const painter = gpu ?? createPainter(canvas);
				pending.handOver(painter);
				live = painter;
				this.#painter.set(painter);
			},
			(err) => {
				if (cancelled) return;
				console.warn("moq-watch: webgpu unavailable, painting through the 2d canvas", err);
				const painter = createPainter(canvas);
				pending.handOver(painter);
				live = painter;
				this.#painter.set(painter);
			},
		);
	}

	// Mirror the painter's HDR and path status onto the decoder and the public path signal.
	#runStatus(effect: Effect): void {
		const painter = effect.get(this.#painter);
		if (!painter) {
			this.decoder.hdr.set(false);
			this.path.set(undefined);
			return;
		}
		effect.proxy(this.decoder.hdr, painter.hdr);
		effect.proxy(this.path, painter.path);
	}

	// Tell the painter whether the display can show HDR, following the display as it changes.
	#runDisplay(effect: Effect): void {
		const painter = effect.get(this.#painter);
		if (!painter || typeof matchMedia !== "function") return;

		const query = matchMedia("(dynamic-range: high)");
		const update = () => painter.display(query.matches);
		update();
		effect.event(query, "change", update);
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
