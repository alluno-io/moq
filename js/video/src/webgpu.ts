import { CALIBRATION_TOLERANCE, classifyImport, type ImportModel, PQ_CALIBRATION, PQ_REFERENCE_WHITE } from "./hdr";
import {
	magnifies,
	type Presentation,
	type Rect,
	texturePresentationTransform,
	viewPresentationTransform,
} from "./presentation";
import { TONE, VERTEX } from "./wgsl";
import { Zoom } from "./zoom";

// `tone.z` set means the frame fills only part of the canvas, and the rest stays black.
const SHADER = /* wgsl */ `
struct Params {
	x: vec4<f32>,
	y: vec4<f32>,
	tone: vec4<f32>,
	// Nonzero when the frame weaves two fields.
	interlaced: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var frame: texture_external;
${VERTEX}
${TONE}
@fragment
fn fragment(in: Vertex) -> @location(0) vec4<f32> {
	if (params.tone.z > 0.5 && (any(in.uv < vec2<f32>(0.0)) || any(in.uv > vec2<f32>(1.0)))) {
		return vec4<f32>(0.0, 0.0, 0.0, 1.0);
	}
	let center = textureSampleBaseClampToEdge(frame, samp, in.uv).rgb;
	if (params.interlaced == 0.0) {
		return present(center, params.tone);
	}

	// Adjacent lines come from different fields, so anything that moved between them combs. A
	// [1 2 1] vertical blend hides it at the cost of some vertical detail.
	let line = vec2<f32>(0.0, 1.0 / f32(textureDimensions(frame).y));
	let above = textureSampleBaseClampToEdge(frame, samp, in.uv - line).rgb;
	let below = textureSampleBaseClampToEdge(frame, samp, in.uv + line).rgb;
	return present((above + 2.0 * center + below) * 0.25, params.tone);
}
`;

// GPUBufferUsage is a global only where WebGPU exists, so spell out the bits.
const UNIFORM = 0x40;
const COPY_DST = 0x08;
const MAP_READ = 0x01;
const RENDER_ATTACHMENT = 0x10;
const TEXTURE_COPY_SRC = 0x01;
const READ = 0x01;

const PASSTHROUGH = 0;
const EXTENDED = 1;
const ROLL_OFF = 2;

const PQ_COLOR_SPACE = {
	primaries: "bt2020",
	transfer: "pq",
	matrix: "bt2020-ncl",
	fullRange: false,
} as unknown as VideoColorSpaceInit;

// The deprecated spelling Chrome shipped before GPUAdapterInfo carried it.
type LegacyAdapter = GPUAdapter & { isFallbackAdapter?: boolean };

/**
 * Check WebGPU can render a `VideoFrame`, and return the device it used.
 *
 * Resolves with a reason string when any check fails, so `"auto"` can log why it fell back.
 */
export async function probe(): Promise<GPUDevice | string> {
	if (!navigator.gpu) return "navigator.gpu is missing";

	const adapter = await navigator.gpu.requestAdapter();
	if (!adapter) return "no adapter";
	if (adapter.info?.isFallbackAdapter ?? (adapter as LegacyAdapter).isFallbackAdapter) {
		return "the adapter is a software fallback";
	}

	let device: GPUDevice;
	try {
		device = await adapter.requestDevice();
	} catch (err) {
		return `requestDevice failed: ${err}`;
	}

	// An invalid import returns a texture instead of throwing, so catch it with an error scope too.
	const frame = new VideoFrame(new Uint8Array(4), { format: "RGBA", codedWidth: 1, codedHeight: 1, timestamp: 0 });
	device.pushErrorScope("validation");
	let thrown: unknown;
	try {
		device.importExternalTexture({ source: frame });
	} catch (err) {
		thrown = err;
	} finally {
		frame.close();
	}
	const invalid = await device.popErrorScope();

	if (thrown !== undefined || invalid) {
		device.destroy();
		return `importExternalTexture(VideoFrame) failed: ${thrown ?? invalid?.message}`;
	}

	return device;
}

/** How a device imports PQ video, and whether a canvas on it can present extended range. */
export type HdrSupport = {
	/** How the browser hands a PQ frame to the shader, or undefined when it could not be measured. */
	model?: ImportModel;
	/** Whether a canvas can be configured for extended tone mapping. */
	extended: boolean;
};

/** Measure how `device` imports PQ video and whether it can present extended tone mapping. */
export async function hdrSupport(device: GPUDevice): Promise<HdrSupport> {
	const model = await calibrate(device).catch(() => undefined);
	return { model, extended: extendedToneMapping(device) };
}

function extendedToneMapping(device: GPUDevice): boolean {
	if (typeof OffscreenCanvas === "undefined") return false;
	const context = new OffscreenCanvas(1, 1).getContext("webgpu") as GPUCanvasContext | null;
	if (!context || typeof context.getConfiguration !== "function") return false;
	try {
		context.configure({
			device,
			format: "rgba16float",
			colorSpace: "srgb",
			toneMapping: { mode: "extended" },
			alphaMode: "opaque",
		});
		return context.getConfiguration()?.toneMapping?.mode === "extended";
	} catch {
		return false;
	} finally {
		context.unconfigure();
	}
}

async function calibrate(device: GPUDevice): Promise<ImportModel | undefined> {
	let params: GPUBuffer | undefined;
	let readback: GPUBuffer | undefined;
	let target: GPUTexture | undefined;
	const samples: number[] = [];
	try {
		const module = device.createShaderModule({ code: SHADER });
		const pipeline = createPipeline(device, module, "rgba16float");
		const sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
		params = device.createBuffer({ size: 64, usage: UNIFORM | COPY_DST });
		readback = device.createBuffer({ size: 512, usage: MAP_READ | COPY_DST });
		target = device.createTexture({
			size: [2, 2],
			format: "rgba16float",
			usage: RENDER_ATTACHMENT | TEXTURE_COPY_SRC,
		});
		device.queue.writeBuffer(
			params,
			0,
			new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, PASSTHROUGH, PQ_REFERENCE_WHITE, 0, 0, 0, 0, 0, 0]),
		);

		for (const patch of PQ_CALIBRATION) {
			const source = new VideoFrame(new Uint8Array([patch.code, patch.code, patch.code, patch.code, 128, 128]), {
				format: "I420",
				codedWidth: 2,
				codedHeight: 2,
				timestamp: 0,
				colorSpace: PQ_COLOR_SPACE,
			});
			try {
				const encoder = device.createCommandEncoder();
				const pass = encoder.beginRenderPass({
					colorAttachments: [
						{
							view: target.createView(),
							clearValue: { r: 0, g: 0, b: 0, a: 1 },
							loadOp: "clear",
							storeOp: "store",
						},
					],
				});
				pass.setPipeline(pipeline);
				pass.setBindGroup(
					0,
					device.createBindGroup({
						layout: pipeline.getBindGroupLayout(0),
						entries: [
							{ binding: 0, resource: { buffer: params } },
							{ binding: 1, resource: sampler },
							{ binding: 2, resource: device.importExternalTexture({ source }) },
						],
					}),
				);
				pass.draw(3);
				pass.end();
				encoder.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow: 256 }, [2, 2]);
				device.queue.submit([encoder.finish()]);
				await readback.mapAsync(READ);
				samples.push(f16(new Uint16Array(readback.getMappedRange())[0]));
				readback.unmap();
			} finally {
				source.close();
			}
		}
	} finally {
		target?.destroy();
		readback?.destroy();
		params?.destroy();
	}
	return classifyImport(samples, PQ_CALIBRATION, CALIBRATION_TOLERANCE);
}

function createPipeline(device: GPUDevice, module: GPUShaderModule, format: GPUTextureFormat): GPURenderPipeline {
	return device.createRenderPipeline({
		layout: "auto",
		vertex: { module, entryPoint: "vertex" },
		fragment: { module, entryPoint: "fragment", targets: [{ format }] },
		primitive: { topology: "triangle-list" },
	});
}

function f16(bits: number): number {
	const sign = bits & 0x8000 ? -1 : 1;
	const exponent = (bits >> 10) & 0x1f;
	const mantissa = bits & 0x3ff;
	if (exponent === 0) return sign * 2 ** -14 * (mantissa / 1024);
	if (exponent === 31) return mantissa ? Number.NaN : sign * Number.POSITIVE_INFINITY;
	return sign * 2 ** (exponent - 15) * (1 + mantissa / 1024);
}

function isPq(frame: VideoFrame): boolean {
	const transfer: string | null | undefined = frame.colorSpace?.transfer;
	return transfer === "pq";
}

/** Draws frames into a configured WebGPU canvas context with one device. */
export class Gpu {
	#context: GPUCanvasContext;
	#device: GPUDevice;
	#preferred: GPUTextureFormat;
	#format?: GPUTextureFormat;
	#colorSpace?: PredefinedColorSpace;
	#support: HdrSupport;
	#hdr = false;

	#module: GPUShaderModule;
	#pipelines = new Map<GPUTextureFormat, GPURenderPipeline>();
	#sampler: GPUSampler;
	#params: GPUBuffer;
	#zoom?: Zoom;

	constructor(context: GPUCanvasContext, device: GPUDevice, support: HdrSupport = { extended: false }) {
		this.#context = context;
		this.#device = device;
		this.#preferred = navigator.gpu.getPreferredCanvasFormat();
		this.#support = support;

		this.#module = device.createShaderModule({ code: SHADER });
		this.#sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
		this.#params = device.createBuffer({ size: 64, usage: UNIFORM | COPY_DST });

		this.#configure("srgb", false);
	}

	/** Whether the last frame drawn was presented in HDR. */
	get hdr(): boolean {
		return this.#hdr;
	}

	#configure(colorSpace: PredefinedColorSpace, extended: boolean) {
		const format = extended ? "rgba16float" : this.#preferred;
		if (this.#colorSpace === colorSpace && this.#format === format) return;
		this.#colorSpace = colorSpace;
		this.#format = format;
		this.#context.configure({
			device: this.#device,
			format,
			colorSpace,
			toneMapping: { mode: extended ? "extended" : "standard" },
			alphaMode: "opaque",
		});
	}

	#pipeline(format: GPUTextureFormat): GPURenderPipeline {
		let pipeline = this.#pipelines.get(format);
		if (!pipeline) {
			pipeline = createPipeline(this.#device, this.#module, format);
			this.#pipelines.set(format, pipeline);
		}
		return pipeline;
	}

	/**
	 * Draw `frame`, or clear to black without one; `hdr` allows PQ video to be presented in HDR.
	 * With a `view`, the frame fills that rect of the canvas instead of all of it, and a frame it
	 * magnifies is upscaled and sharpened.
	 *
	 * Import, bind, encode, and submit happen with no `await` in between: the external texture
	 * expires once the frame is closed or the task ends.
	 */
	draw(frame: VideoFrame | undefined, presentation: Presentation | undefined, hdr = false, view?: Rect): boolean {
		let tone = PASSTHROUGH;
		let extended = false;

		// Render in the frame's own gamut so a Display P3 source is not clipped to sRGB. The DOM
		// typings list only the SDR primaries, so widen to compare against "smpte432" (Display P3).
		if (frame) {
			const pq = this.#support.model !== undefined && isPq(frame);
			extended = pq && hdr && this.#support.extended;
			if (pq && this.#support.model === "signal") tone = extended ? EXTENDED : ROLL_OFF;

			const primaries: string | null | undefined = frame.colorSpace?.primaries;
			this.#configure(!pq && primaries === "smpte432" ? "display-p3" : "srgb", extended);
		}
		this.#hdr = extended;

		const canvas = this.#context.canvas;
		const output = { width: canvas.width, height: canvas.height };
		const target = this.#context.getCurrentTexture().createView();
		const format = this.#format ?? this.#preferred;
		const encoder = this.#device.createCommandEncoder();

		const frameSize = frame && { width: frame.displayWidth, height: frame.displayHeight };
		if (frame && frameSize && view && magnifies(frameSize, view, presentation)) {
			this.#zoom ??= new Zoom(this.#device);
			this.#zoom.encode(encoder, {
				frame: this.#device.importExternalTexture({ source: frame, colorSpace: this.#colorSpace }),
				frameSize,
				target,
				format,
				size: output,
				rows: viewPresentationTransform(output, view, presentation),
				tone,
				white: PQ_REFERENCE_WHITE,
			});
			this.#device.queue.submit([encoder.finish()]);
			return true;
		}

		const pass = encoder.beginRenderPass({
			colorAttachments: [
				{
					view: target,
					clearValue: { r: 0, g: 0, b: 0, a: 1 },
					loadOp: "clear",
					storeOp: "store",
				},
			],
		});

		if (frame) {
			const { x, y } = view
				? viewPresentationTransform(output, view, presentation)
				: texturePresentationTransform(output, presentation);
			const interlaced = presentation?.interlaced ? 1 : 0;
			this.#device.queue.writeBuffer(
				this.#params,
				0,
				new Float32Array([...x, 0, ...y, 0, tone, PQ_REFERENCE_WHITE, view ? 1 : 0, 0, interlaced, 0, 0, 0]),
			);

			const pipeline = this.#pipeline(format);
			const texture = this.#device.importExternalTexture({ source: frame, colorSpace: this.#colorSpace });
			const group = this.#device.createBindGroup({
				layout: pipeline.getBindGroupLayout(0),
				entries: [
					{ binding: 0, resource: { buffer: this.#params } },
					{ binding: 1, resource: this.#sampler },
					{ binding: 2, resource: texture },
				],
			});

			pass.setPipeline(pipeline);
			pass.setBindGroup(0, group);
			pass.draw(3);
		}

		pass.end();
		this.#device.queue.submit([encoder.finish()]);
		return true;
	}

	/** Release the GPU resources this surface created. The caller owns the device. */
	close() {
		this.#params.destroy();
		this.#zoom?.close();
		this.#context.unconfigure();
	}
}
