import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Signal } from "@moq/signals";
import { PQ_CALIBRATION } from "./hdr";
import type { Rect } from "./presentation";
import { type Backend, Renderer } from "./renderer";

// Let the probe's promise chain and the effects it wakes run to completion.
async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

type Kind = "2d" | "webgpu";

// A canvas that, like a real one, keeps the first kind of context it hands out.
class FakeCanvas extends EventTarget {
	width = 640;
	height = 360;
	kind?: Kind;
	draws: unknown[][] = [];
	transforms: number[][] = [];
	configured: GPUCanvasConfiguration[] = [];
	unconfigured = 0;
	lost = false;

	getContext(kind: Kind): unknown {
		if (this.kind && this.kind !== kind) return null;
		this.kind = kind;
		if (kind === "2d") {
			return {
				canvas: this,
				fillStyle: "",
				save: () => {},
				restore: () => {},
				fillRect: () => {},
				setTransform: (...matrix: number[]) => this.transforms.push(matrix),
				drawImage: (...args: unknown[]) => this.draws.push(args),
				isContextLost: () => this.lost,
			};
		}
		return {
			canvas: this,
			configure: (config: GPUCanvasConfiguration) => this.configured.push(config),
			unconfigure: () => this.unconfigured++,
			getCurrentTexture: () => ({ createView: () => ({}) }),
		};
	}
}

type DeviceOptions = { importThrows?: boolean; importInvalid?: boolean; calibration?: number[] };

function half(value: number): number {
	const bits = new Uint32Array(new Float32Array([value]).buffer)[0];
	const sign = (bits >> 16) & 0x8000;
	const exponent = ((bits >> 23) & 0xff) - 112;
	if (exponent <= 0) return sign;
	if (exponent >= 31) return sign | 0x7c00;
	return sign | (exponent << 10) | ((bits & 0x7fffff) >> 13);
}

// Just enough of a GPUDevice for the probe and one pipeline.
class FakeDevice {
	destroyed = false;
	draws = 0;
	scratch: number[][] = [];
	imports: unknown[] = [];
	writes: Float32Array[] = [];
	options: DeviceOptions;
	#lose!: (info: { reason: string; message: string }) => void;
	lost = new Promise<{ reason: string; message: string }>((resolve) => {
		this.#lose = resolve;
	});
	#invalid?: { message: string };
	#samples: number[];

	constructor(options: DeviceOptions = {}) {
		this.options = options;
		this.#samples = [...(options.calibration ?? [])];
	}

	createTexture(descriptor: { size: number[]; usage: number }) {
		// A sampled texture belongs to the zoom; only the calibration reads one back.
		if (descriptor.usage & 0x04) {
			this.scratch.push(descriptor.size);
			return { width: descriptor.size[0], height: descriptor.size[1], createView: () => ({}), destroy: () => {} };
		}
		if (!this.options.calibration) throw new Error("no readback in this test");
		return { createView: () => ({}), destroy: () => {} };
	}

	lose() {
		this.#lose({ reason: "unknown", message: "test" });
	}

	destroy() {
		this.destroyed = true;
		this.#lose({ reason: "destroyed", message: "" });
	}

	pushErrorScope() {
		this.#invalid = undefined;
	}

	async popErrorScope() {
		return this.#invalid ?? null;
	}

	importExternalTexture(descriptor: { source: unknown }) {
		if (this.options.importThrows) throw new Error("import failed");
		if (this.options.importInvalid) this.#invalid = { message: "invalid import" };
		this.imports.push(descriptor.source);
		return {};
	}

	createShaderModule() {
		return {};
	}

	createRenderPipeline() {
		return { getBindGroupLayout: () => ({}) };
	}

	createSampler() {
		return {};
	}

	createBuffer() {
		let sample = Number.NaN;
		return {
			destroy: () => {},
			mapAsync: async () => {
				sample = this.#samples.shift() ?? Number.NaN;
			},
			getMappedRange: () => new Uint16Array([half(sample)]).buffer,
			unmap: () => {},
		};
	}

	createBindGroup() {
		return {};
	}

	createCommandEncoder() {
		return {
			beginRenderPass: () => ({
				setPipeline: () => {},
				setBindGroup: () => {},
				draw: () => this.draws++,
				end: () => {},
			}),
			copyTextureToBuffer: () => {},
			finish: () => ({}),
		};
	}

	queue = {
		writeBuffer: (_buffer: unknown, _offset: number, data: Float32Array) => this.writes.push(data),
		submit: () => {},
	};
}

type AdapterOptions = { fallback?: boolean; legacyFallback?: boolean; deviceThrows?: boolean; device?: DeviceOptions };

class Gpu {
	adapters: (AdapterOptions | null)[] = [];
	devices: FakeDevice[] = [];
	requests = 0;

	async requestAdapter() {
		this.requests++;
		const options = this.adapters.length > 1 ? this.adapters.shift() : this.adapters[0];
		if (!options) return null;
		return {
			info: options.legacyFallback ? undefined : { isFallbackAdapter: options.fallback ?? false },
			isFallbackAdapter: options.legacyFallback,
			requestDevice: async () => {
				if (options.deviceThrows) throw new Error("no device");
				const device = new FakeDevice(options.device);
				this.devices.push(device);
				return device;
			},
		};
	}

	getPreferredCanvasFormat() {
		return "bgra8unorm";
	}
}

function frame(timestamp = 1_000, colorSpace: object = { primaries: "bt709" }): VideoFrame {
	return {
		timestamp,
		colorSpace,
		clone() {
			return this;
		},
		close() {},
	} as unknown as VideoFrame;
}

function pqFrame(): VideoFrame {
	return frame(1_000, { primaries: "bt2020", transfer: "pq", matrix: "bt2020-ncl", fullRange: false });
}

class FakeQuery extends EventTarget {
	matches: boolean;

	constructor(matches: boolean) {
		super();
		this.matches = matches;
	}

	change(matches: boolean) {
		this.matches = matches;
		this.dispatchEvent(new Event("change"));
	}
}

const SIGNAL = PQ_CALIBRATION.map((patch) => patch.signal);
const NATIVE = PQ_CALIBRATION.map((patch) => Math.min(patch.native, 1));

describe("Renderer", () => {
	let callbacks: Map<number, FrameRequestCallback>;
	let nextCallback: number;
	let gpu: Gpu;
	const saved = new Map<string, PropertyDescriptor | undefined>();

	function stub(target: object, key: string, value: unknown) {
		const id = `${target === globalThis ? "global" : "navigator"}.${key}`;
		if (!saved.has(id)) saved.set(id, Object.getOwnPropertyDescriptor(target, key));
		Object.defineProperty(target, key, { configurable: true, writable: true, value });
	}

	beforeEach(() => {
		callbacks = new Map();
		nextCallback = 0;
		gpu = new Gpu();

		stub(globalThis, "requestAnimationFrame", (callback: FrameRequestCallback) => {
			const id = ++nextCallback;
			callbacks.set(id, callback);
			return id;
		});
		stub(globalThis, "cancelAnimationFrame", (id: number) => callbacks.delete(id));
		stub(
			globalThis,
			"VideoFrame",
			class {
				close() {}
			},
		);
		stub(navigator, "gpu", gpu);
	});

	afterEach(() => {
		for (const [id, descriptor] of saved) {
			const [scope, key] = id.split(".");
			const target = scope === "global" ? globalThis : navigator;
			if (descriptor) Object.defineProperty(target, key, descriptor);
			else Reflect.deleteProperty(target, key);
		}
		saved.clear();
	});

	function paint(): number {
		const pending = [...callbacks.values()];
		callbacks.clear();
		for (const callback of pending) callback(0);
		return pending.length;
	}

	function create(canvas: FakeCanvas | Signal<FakeCanvas | undefined>, backend: Backend = "auto") {
		return new Renderer({
			canvas: canvas as unknown as Signal<HTMLCanvasElement | undefined>,
			frame: frame(),
			backend,
		});
	}

	describe("painted", () => {
		function create2d(
			canvas: FakeCanvas,
			source: Signal<VideoFrame | undefined>,
			display?: Signal<{ width: number; height: number }>,
		) {
			return new Renderer({
				canvas: canvas as unknown as HTMLCanvasElement,
				frame: source,
				display,
				backend: "2d",
			});
		}

		it("counts a frame once it is painted, not when it is handed over", async () => {
			const canvas = new FakeCanvas();
			const source = new Signal<VideoFrame | undefined>(frame(1_000));
			const renderer = create2d(canvas, source);
			try {
				await settle();
				expect(renderer.out.painted.peek()).toBe(0);
				paint();
				expect(renderer.out.painted.peek()).toBe(1);

				source.set(frame(2_000));
				await settle();
				expect(renderer.out.painted.peek()).toBe(1);
				paint();
				expect(renderer.out.painted.peek()).toBe(2);
			} finally {
				renderer.close();
			}
		});

		it("counts each frame once however often it is repainted", async () => {
			const canvas = new FakeCanvas();
			const source = new Signal<VideoFrame | undefined>(frame(1_000));
			const display = new Signal({ width: 640, height: 360 });
			const renderer = create2d(canvas, source, display);
			try {
				await settle();
				paint();
				display.set({ width: 320, height: 180 });
				await settle();
				paint();
				expect(canvas.draws).toHaveLength(2);
				expect(renderer.out.painted.peek()).toBe(1);
			} finally {
				renderer.close();
			}
		});

		it("counts frames that land within one refresh as the one painted", async () => {
			const canvas = new FakeCanvas();
			const source = new Signal<VideoFrame | undefined>(frame(1_000));
			const renderer = create2d(canvas, source);
			try {
				await settle();
				paint();
				source.set(frame(2_000));
				source.set(frame(3_000));
				await settle();
				expect(paint()).toBe(1);
				expect(renderer.out.painted.peek()).toBe(2);
				expect(renderer.out.frame.peek()?.timestamp).toBe(3_000);
			} finally {
				renderer.close();
			}
		});

		it("paints and counts nothing while the 2d context is lost, and repaints once it is restored", async () => {
			const canvas = new FakeCanvas();
			const source = new Signal<VideoFrame | undefined>(frame(1_000));
			const renderer = create2d(canvas, source);
			try {
				await settle();
				canvas.lost = true;
				paint();
				expect(canvas.draws).toHaveLength(0);
				expect(renderer.out.painted.peek()).toBe(0);

				canvas.lost = false;
				canvas.dispatchEvent(new Event("contextrestored"));
				await settle();
				paint();
				expect(canvas.draws).toHaveLength(1);
				expect(renderer.out.painted.peek()).toBe(1);
			} finally {
				renderer.close();
			}
		});
	});

	it("picks WebGPU where it can import a VideoFrame", async () => {
		gpu.adapters = [{}];
		const canvas = new FakeCanvas();
		const renderer = create(canvas);
		try {
			await settle();
			expect(canvas.kind).toBe("webgpu");
			expect(paint()).toBe(1);
			expect(gpu.devices).toHaveLength(1);
			expect(gpu.devices[0].draws).toBe(1);
			expect(renderer.out.frame.peek()?.timestamp).toBe(1_000);
		} finally {
			renderer.close();
		}
		expect(gpu.devices[0].destroyed).toBe(true);
		expect(canvas.unconfigured).toBe(1);
	});

	const fallbacks: [string, () => void][] = [
		["navigator.gpu is missing", () => stub(navigator, "gpu", undefined)],
		["there is no adapter", () => (gpu.adapters = [null])],
		["the adapter is a software fallback", () => (gpu.adapters = [{ fallback: true }])],
		["the legacy adapter is a software fallback", () => (gpu.adapters = [{ legacyFallback: true }])],
		["requestDevice fails", () => (gpu.adapters = [{ deviceThrows: true }])],
		["the import throws", () => (gpu.adapters = [{ device: { importThrows: true } }])],
		["the import is invalid", () => (gpu.adapters = [{ device: { importInvalid: true } }])],
	];

	it.each(fallbacks)("falls back to Canvas2D when %s", async (_, setup) => {
		setup();
		const canvas = new FakeCanvas();
		const renderer = create(canvas);
		try {
			await settle();
			expect(canvas.kind).toBe("2d");
			expect(paint()).toBe(1);
			expect(canvas.draws).toHaveLength(1);
			expect(renderer.out.error.peek()).toBeUndefined();
			for (const device of gpu.devices) expect(device.destroyed).toBe(true);
		} finally {
			renderer.close();
		}
	});

	it.each(fallbacks)('refuses an explicit "webgpu" when %s', async (_, setup) => {
		setup();
		const canvas = new FakeCanvas();
		const renderer = create(canvas, "webgpu");
		try {
			await settle();
			expect(renderer.out.error.peek()?.name).toBe("NotSupportedError");
			expect(canvas.kind).toBeUndefined();
			expect(paint()).toBe(0);
		} finally {
			renderer.close();
		}
	});

	it('never probes WebGPU for "2d"', async () => {
		gpu.adapters = [{}];
		const canvas = new FakeCanvas();
		const renderer = create(canvas, "2d");
		try {
			await settle();
			expect(gpu.requests).toBe(0);
			expect(canvas.kind).toBe("2d");
			expect(paint()).toBe(1);
		} finally {
			renderer.close();
		}
	});

	it("replaces a lost device and keeps drawing", async () => {
		gpu.adapters = [{}];
		const canvas = new FakeCanvas();
		const renderer = create(canvas);
		try {
			await settle();
			expect(paint()).toBe(1);

			gpu.devices[0].lose();
			await settle();

			expect(gpu.devices).toHaveLength(2);
			expect(renderer.out.error.peek()).toBeUndefined();
			expect(paint()).toBe(1);
			expect(gpu.devices[1].draws).toBe(1);
			expect(canvas.configured.at(-1)?.device).toBe(gpu.devices[1] as unknown as GPUDevice);
		} finally {
			renderer.close();
		}
		expect(gpu.devices[1].destroyed).toBe(true);
	});

	it("reports InvalidStateError when no device replaces a lost one, and recovers on a fresh canvas", async () => {
		gpu.adapters = [{}];
		const canvas = new Signal<FakeCanvas | undefined>(new FakeCanvas());
		const renderer = create(canvas);
		try {
			await settle();
			expect(paint()).toBe(1);

			gpu.adapters = [null];
			gpu.devices[0].lose();
			await settle();

			expect(renderer.out.error.peek()?.name).toBe("InvalidStateError");
			expect(paint()).toBe(0);

			// The lost canvas only hands out WebGPU, so recovery is a fresh canvas, which "auto"
			// draws to with Canvas2D while WebGPU is gone.
			const fresh = new FakeCanvas();
			canvas.set(fresh);
			await settle();

			expect(renderer.out.error.peek()).toBeUndefined();
			expect(fresh.kind).toBe("2d");
			expect(paint()).toBe(1);
			expect(fresh.draws).toHaveLength(1);
		} finally {
			renderer.close();
		}
	});

	it("reports InvalidStateError for a canvas that holds another kind of context", async () => {
		const canvas = new FakeCanvas();
		canvas.getContext("webgpu");
		const renderer = create(canvas, "2d");
		try {
			await settle();
			expect(renderer.out.error.peek()?.name).toBe("InvalidStateError");
		} finally {
			renderer.close();
		}
	});

	describe("view", () => {
		function sized(width: number, height: number): VideoFrame {
			return Object.assign(frame(), { displayWidth: width, displayHeight: height });
		}

		function view(canvas: FakeCanvas, source: VideoFrame, rect: Rect, backend: Backend = "auto") {
			return new Renderer({
				canvas: canvas as unknown as HTMLCanvasElement,
				frame: source,
				view: rect,
				backend,
			});
		}

		it("draws the frame into the view's rect on Canvas2D", async () => {
			const canvas = new FakeCanvas();
			const renderer = view(canvas, sized(1920, 1080), { x: -320, y: -180, width: 1280, height: 720 }, "2d");
			try {
				await settle();
				expect(paint()).toBe(1);
				expect(canvas.transforms.at(-1)).toEqual([1, 0, 0, 1, -320, -180]);
				expect(canvas.draws.at(-1)?.slice(1)).toEqual([0, 0, 1280, 720]);
			} finally {
				renderer.close();
			}
		});

		it("copies, upscales and then sharpens a frame the view magnifies, in three WebGPU passes", async () => {
			gpu.adapters = [{}];
			const canvas = new FakeCanvas();
			const renderer = view(canvas, sized(320, 180), { x: 0, y: 0, width: 640, height: 360 });
			try {
				await settle();
				expect(paint()).toBe(1);
				const device = gpu.devices[0];
				expect(device.draws).toBe(3);
				expect(device.scratch).toEqual([
					[320, 180],
					[640, 360],
				]);
			} finally {
				renderer.close();
			}
		});

		it("draws a view that does not magnify in one WebGPU pass, black around it", async () => {
			gpu.adapters = [{}];
			const canvas = new FakeCanvas();
			const renderer = view(canvas, sized(1920, 1080), { x: 0, y: 90, width: 320, height: 180 });
			try {
				await settle();
				expect(paint()).toBe(1);
				const device = gpu.devices[0];
				expect(device.draws).toBe(1);
				expect(device.scratch).toEqual([]);
				expect(device.writes.at(-1)?.[10]).toBe(1);
			} finally {
				renderer.close();
			}
		});

		it("fills the canvas with no view, as before", async () => {
			gpu.adapters = [{}];
			const canvas = new FakeCanvas();
			const renderer = create(canvas);
			try {
				await settle();
				expect(paint()).toBe(1);
				expect(gpu.devices[0].writes.at(-1)?.[10]).toBe(0);
			} finally {
				renderer.close();
			}
		});
	});

	it("repaints with the new presentation", async () => {
		const canvas = new FakeCanvas();
		const presentation = new Signal({ rotation: 0 });
		const renderer = new Renderer({
			canvas: canvas as unknown as HTMLCanvasElement,
			frame: frame(),
			presentation,
			backend: "2d",
		});
		try {
			await settle();
			expect(paint()).toBe(1);

			presentation.set({ rotation: 90 });
			await settle();

			expect(paint()).toBe(1);
			expect(canvas.transforms.at(-1)).toEqual([0, 1, -1, 0, 640, 0]);
			expect(canvas.draws.at(-1)?.slice(1)).toEqual([0, 0, 360, 640]);
		} finally {
			renderer.close();
		}
	});

	describe("hdr", () => {
		let display: FakeQuery;

		function setup(
			options: { calibration?: number[]; display?: boolean; extended?: boolean; element?: boolean } = {},
		) {
			gpu.adapters = [{ device: { calibration: options.calibration ?? SIGNAL } }];
			display = new FakeQuery(options.display ?? true);
			stub(globalThis, "matchMedia", () => display);
			const extended = options.extended ?? true;
			stub(
				globalThis,
				"OffscreenCanvas",
				class {
					getContext() {
						let config: GPUCanvasConfiguration | undefined;
						return {
							configure: (next: GPUCanvasConfiguration) => {
								config = next;
							},
							getConfiguration: () =>
								extended ? config : { ...config, toneMapping: { mode: "standard" } },
							unconfigure: () => {},
						};
					}
				},
			);
			if (options.element ?? true) stub(globalThis, "HTMLCanvasElement", FakeCanvas);
		}

		function render(canvas: FakeCanvas, source: VideoFrame, hdr: boolean | Signal<boolean> = true) {
			return new Renderer({ canvas: canvas as unknown as HTMLCanvasElement, frame: source, hdr });
		}

		function tone(): number | undefined {
			return gpu.devices[0].writes.at(-1)?.[8];
		}

		it("presents PQ video in HDR on an HDR display", async () => {
			setup();
			const canvas = new FakeCanvas();
			const renderer = render(canvas, pqFrame());
			try {
				await settle();
				expect(paint()).toBe(1);
				expect(canvas.configured.at(-1)).toMatchObject({
					format: "rgba16float",
					colorSpace: "srgb",
					toneMapping: { mode: "extended" },
				});
				expect(tone()).toBe(1);
				expect(renderer.out.hdr.peek()).toBe(true);
			} finally {
				renderer.close();
			}
		});

		it("rolls PQ highlights off into SDR on an SDR display", async () => {
			setup({ display: false });
			const canvas = new FakeCanvas();
			const renderer = render(canvas, pqFrame());
			try {
				await settle();
				expect(paint()).toBe(1);
				expect(canvas.configured.at(-1)).toMatchObject({
					format: "bgra8unorm",
					toneMapping: { mode: "standard" },
				});
				expect(tone()).toBe(2);
				expect(renderer.out.hdr.peek()).toBe(false);
			} finally {
				renderer.close();
			}
		});

		it("follows the display out of HDR and back", async () => {
			setup();
			const canvas = new FakeCanvas();
			const renderer = render(canvas, pqFrame());
			try {
				await settle();
				paint();
				expect(renderer.out.hdr.peek()).toBe(true);

				display.change(false);
				await settle();
				expect(paint()).toBe(1);
				expect(canvas.configured.at(-1)).toMatchObject({
					format: "bgra8unorm",
					toneMapping: { mode: "standard" },
				});
				expect(tone()).toBe(2);
				expect(renderer.out.hdr.peek()).toBe(false);

				display.change(true);
				await settle();
				expect(paint()).toBe(1);
				expect(canvas.configured.at(-1)).toMatchObject({
					format: "rgba16float",
					toneMapping: { mode: "extended" },
				});
				expect(tone()).toBe(1);
				expect(renderer.out.hdr.peek()).toBe(true);
			} finally {
				renderer.close();
			}
		});

		it("keeps SDR video as it is on an HDR display", async () => {
			setup();
			const canvas = new FakeCanvas();
			const renderer = render(canvas, frame());
			try {
				await settle();
				expect(paint()).toBe(1);
				expect(canvas.configured.at(-1)).toMatchObject({
					format: "bgra8unorm",
					toneMapping: { mode: "standard" },
				});
				expect(tone()).toBe(0);
				expect(renderer.out.hdr.peek()).toBe(false);
			} finally {
				renderer.close();
			}
		});

		it("keeps PQ in SDR while hdr is off, and presents it once hdr is on", async () => {
			setup();
			const canvas = new FakeCanvas();
			const hdr = new Signal(false);
			const renderer = render(canvas, pqFrame(), hdr);
			try {
				await settle();
				expect(paint()).toBe(1);
				expect(tone()).toBe(2);
				expect(renderer.out.hdr.peek()).toBe(false);

				hdr.set(true);
				await settle();
				expect(paint()).toBe(1);
				expect(tone()).toBe(1);
				expect(renderer.out.hdr.peek()).toBe(true);
			} finally {
				renderer.close();
			}
		});

		it("passes PQ through untouched when the import model cannot be measured", async () => {
			setup({ calibration: [0.1, 0.1] });
			const canvas = new FakeCanvas();
			const renderer = render(canvas, pqFrame());
			try {
				await settle();
				expect(paint()).toBe(1);
				expect(canvas.configured.at(-1)).toMatchObject({
					format: "bgra8unorm",
					toneMapping: { mode: "standard" },
				});
				expect(tone()).toBe(0);
				expect(renderer.out.hdr.peek()).toBe(false);
			} finally {
				renderer.close();
			}
		});

		it("uses the browser's own PQ conversion when it applies one", async () => {
			setup({ calibration: NATIVE });
			const canvas = new FakeCanvas();
			const renderer = render(canvas, pqFrame());
			try {
				await settle();
				expect(paint()).toBe(1);
				expect(canvas.configured.at(-1)).toMatchObject({
					format: "rgba16float",
					toneMapping: { mode: "extended" },
				});
				expect(tone()).toBe(0);
				expect(renderer.out.hdr.peek()).toBe(true);
			} finally {
				renderer.close();
			}
		});

		it("rolls off instead of presenting HDR where extended tone mapping is unavailable", async () => {
			setup({ extended: false });
			const canvas = new FakeCanvas();
			const renderer = render(canvas, pqFrame());
			try {
				await settle();
				expect(paint()).toBe(1);
				expect(canvas.configured.at(-1)).toMatchObject({ format: "bgra8unorm" });
				expect(tone()).toBe(2);
				expect(renderer.out.hdr.peek()).toBe(false);
			} finally {
				renderer.close();
			}
		});

		it("never presents HDR on a canvas outside the document", async () => {
			setup({ element: false });
			const canvas = new FakeCanvas();
			const renderer = render(canvas, pqFrame());
			try {
				await settle();
				expect(paint()).toBe(1);
				expect(canvas.configured.at(-1)).toMatchObject({ format: "bgra8unorm" });
				expect(tone()).toBe(2);
				expect(renderer.out.hdr.peek()).toBe(false);
			} finally {
				renderer.close();
			}
		});

		it("measures the import again on a replacement device", async () => {
			setup();
			gpu.adapters = [{ device: { calibration: SIGNAL } }, { device: { calibration: [0.1, 0.1] } }];
			const canvas = new FakeCanvas();
			const renderer = render(canvas, pqFrame());
			try {
				await settle();
				paint();
				expect(renderer.out.hdr.peek()).toBe(true);

				gpu.devices[0].lose();
				await settle();
				expect(paint()).toBe(1);
				expect(gpu.devices[1].writes.at(-1)?.[8]).toBe(0);
				expect(renderer.out.hdr.peek()).toBe(false);
			} finally {
				renderer.close();
			}
		});
	});
});
