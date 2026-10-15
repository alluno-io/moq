import { CALIBRATION_TOLERANCE, classifyImport, type ImportModel, PQ_CALIBRATION, PQ_REFERENCE_WHITE } from "./hdr";
import { type Presentation, texturePresentationTransform } from "./presentation";

// One oversized triangle covers the viewport, so there is no vertex buffer and no diagonal seam.
// The vertex stage maps each canvas coordinate to the frame coordinate it shows, which handles
// rotation and flip; the interpolation is exact because the map is affine.
const SHADER = /* wgsl */ `
struct Params {
	x: vec4<f32>,
	y: vec4<f32>,
	tone: vec4<f32>,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var frame: texture_external;

struct Vertex {
	@builtin(position) position: vec4<f32>,
	@location(0) uv: vec2<f32>,
}

@vertex
fn vertex(@builtin(vertex_index) index: u32) -> Vertex {
	let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
	let p = vec3<f32>(uv, 1.0);
	var out: Vertex;
	out.position = vec4<f32>(uv * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), 0.0, 1.0);
	out.uv = vec2<f32>(dot(params.x.xyz, p), dot(params.y.xyz, p));
	return out;
}

const BT709_TO_BT2020 = mat3x3<f32>(
	vec3<f32>(0.627402, 0.069095, 0.016394),
	vec3<f32>(0.329292, 0.919544, 0.088028),
	vec3<f32>(0.043306, 0.011360, 0.895578));
const BT2020_TO_BT709 = mat3x3<f32>(
	vec3<f32>(1.660491, -0.124550, -0.018151),
	vec3<f32>(-0.587641, 1.132900, -0.100579),
	vec3<f32>(-0.072850, -0.008349, 1.118730));

fn srgb_decode(c: vec3<f32>) -> vec3<f32> {
	let a = abs(c);
	let lo = a / 12.92;
	let hi = pow((a + 0.055) / 1.055, vec3<f32>(2.4));
	return sign(c) * select(hi, lo, a <= vec3<f32>(0.04045));
}

fn srgb_encode(c: vec3<f32>) -> vec3<f32> {
	let a = abs(c);
	let lo = a * 12.92;
	let hi = 1.055 * pow(a, vec3<f32>(1.0 / 2.4)) - 0.055;
	return sign(c) * select(hi, lo, a <= vec3<f32>(0.0031308));
}

fn pq_eotf(e: vec3<f32>) -> vec3<f32> {
	let m1 = 0.1593017578125;
	let m2 = 78.84375;
	let c1 = 0.8359375;
	let c2 = 18.8515625;
	let c3 = 18.6875;
	let ep = pow(clamp(e, vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(1.0 / m2));
	let num = max(ep - c1, vec3<f32>(0.0));
	let den = c2 - c3 * ep;
	return pow(num / den, vec3<f32>(1.0 / m1)) * 10000.0;
}

fn roll_off(c: vec3<f32>) -> vec3<f32> {
	let y = dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
	let knee = 0.8;
	if (y <= knee) {
		return c;
	}
	let t = (y - knee) / (1.0 - knee);
	let yn = knee + (1.0 - knee) * (1.0 - exp(-t));
	return c * (yn / y);
}

@fragment
fn fragment(in: Vertex) -> @location(0) vec4<f32> {
	let rgb = textureSampleBaseClampToEdge(frame, samp, in.uv).rgb;
	if (params.tone.x < 0.5) {
		return vec4<f32>(rgb, 1.0);
	}
	var light = BT2020_TO_BT709 * (pq_eotf(BT709_TO_BT2020 * srgb_decode(rgb)) / params.tone.y);
	if (params.tone.x > 1.5) {
		light = clamp(roll_off(max(light, vec3<f32>(0.0))), vec3<f32>(0.0), vec3<f32>(1.0));
	}
	return vec4<f32>(srgb_encode(light), 1.0);
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
		params = device.createBuffer({ size: 48, usage: UNIFORM | COPY_DST });
		readback = device.createBuffer({ size: 512, usage: MAP_READ | COPY_DST });
		target = device.createTexture({
			size: [2, 2],
			format: "rgba16float",
			usage: RENDER_ATTACHMENT | TEXTURE_COPY_SRC,
		});
		device.queue.writeBuffer(
			params,
			0,
			new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, PASSTHROUGH, PQ_REFERENCE_WHITE, 0, 0]),
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

	constructor(context: GPUCanvasContext, device: GPUDevice, support: HdrSupport = { extended: false }) {
		this.#context = context;
		this.#device = device;
		this.#preferred = navigator.gpu.getPreferredCanvasFormat();
		this.#support = support;

		this.#module = device.createShaderModule({ code: SHADER });
		this.#sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
		this.#params = device.createBuffer({ size: 48, usage: UNIFORM | COPY_DST });

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
	 *
	 * Import, bind, encode, and submit happen with no `await` in between: the external texture
	 * expires once the frame is closed or the task ends.
	 */
	draw(frame: VideoFrame | undefined, presentation: Presentation | undefined, hdr = false): boolean {
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

		const encoder = this.#device.createCommandEncoder();
		const pass = encoder.beginRenderPass({
			colorAttachments: [
				{
					view: this.#context.getCurrentTexture().createView(),
					clearValue: { r: 0, g: 0, b: 0, a: 1 },
					loadOp: "clear",
					storeOp: "store",
				},
			],
		});

		if (frame) {
			const canvas = this.#context.canvas;
			const { x, y } = texturePresentationTransform({ width: canvas.width, height: canvas.height }, presentation);
			this.#device.queue.writeBuffer(
				this.#params,
				0,
				new Float32Array([...x, 0, ...y, 0, tone, PQ_REFERENCE_WHITE, 0, 0]),
			);

			const pipeline = this.#pipeline(this.#format ?? this.#preferred);
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
		this.#context.unconfigure();
	}
}
