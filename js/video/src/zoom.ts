// The EASU and RCAS passes port FSR 1 from AMD FidelityFX, under its MIT license:
//
// Copyright (c) 2021 Advanced Micro Devices, Inc. All rights reserved.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

import type { Dimensions } from "./presentation";
import { TONE, VERTEX } from "./wgsl";

// COPY converts the frame to RGB once, at its own size, with its luma in alpha for EASU.
const COPY = /* wgsl */ `
@group(0) @binding(0) var frame: texture_external;
@group(0) @binding(1) var linear: sampler;

struct Copy {
	@builtin(position) position: vec4<f32>,
	@location(0) uv: vec2<f32>,
}

@vertex
fn vertex(@builtin(vertex_index) index: u32) -> Copy {
	let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
	var out: Copy;
	out.position = vec4<f32>(uv * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), 0.0, 1.0);
	out.uv = uv;
	return out;
}

@fragment
fn fragment(in: Copy) -> @location(0) vec4<f32> {
	let c = textureSampleBaseClampToEdge(frame, linear, in.uv).rgb;
	return vec4<f32>(c, c.b * 0.5 + (c.r * 0.5 + c.g));
}
`;

// EASU reads the 12 texels of the copy around each canvas pixel, finds the local edge direction
// from their luma, and blends them with a Lanczos-like lobe stretched along that edge, clamped to
// the four nearest texels so it never rings past them.
const EASU = /* wgsl */ `
struct Params {
	x: vec4<f32>,
	y: vec4<f32>,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var frame: texture_2d<f32>;
${VERTEX}
fn tap(p: vec2<i32>, size: vec2<i32>) -> vec4<f32> {
	return textureLoad(frame, clamp(p, vec2<i32>(0), size - vec2<i32>(1)), 0);
}

fn edge(acc: ptr<function, vec3<f32>>, w: f32, a: f32, b: f32, c: f32, d: f32, e: f32) {
	let dx = d - b;
	var lx = clamp(abs(dx) / max(max(abs(d - c), abs(c - b)), 1.0e-8), 0.0, 1.0);
	lx = lx * lx;
	let dy = e - a;
	var ly = clamp(abs(dy) / max(max(abs(e - c), abs(c - a)), 1.0e-8), 0.0, 1.0);
	ly = ly * ly;
	*acc += vec3<f32>(dx, dy, lx + ly) * w;
}

fn lobe(acc: ptr<function, vec4<f32>>, off: vec2<f32>, dir: vec2<f32>, len: vec2<f32>, lob: f32, clp: f32, c: vec3<f32>) {
	let v = vec2<f32>(off.x * dir.x + off.y * dir.y, off.y * dir.x - off.x * dir.y) * len;
	let d2 = min(dot(v, v), clp);
	var wb = 2.0 / 5.0 * d2 - 1.0;
	var wa = lob * d2 - 1.0;
	wb = wb * wb;
	wa = wa * wa;
	wb = 25.0 / 16.0 * wb - (25.0 / 16.0 - 1.0);
	let w = wb * wa;
	*acc += vec4<f32>(c * w, w);
}

@fragment
fn fragment(in: Vertex) -> @location(0) vec4<f32> {
	if (any(in.uv < vec2<f32>(0.0)) || any(in.uv > vec2<f32>(1.0))) {
		return vec4<f32>(0.0, 0.0, 0.0, 1.0);
	}

	let size = vec2<i32>(textureDimensions(frame));
	let pos = in.uv * vec2<f32>(size) - vec2<f32>(0.5);
	let base = floor(pos);
	let pp = pos - base;
	let o = vec2<i32>(base);

	let b = tap(o + vec2<i32>(0, -1), size);
	let c = tap(o + vec2<i32>(1, -1), size);
	let e = tap(o + vec2<i32>(-1, 0), size);
	let f = tap(o, size);
	let g = tap(o + vec2<i32>(1, 0), size);
	let h = tap(o + vec2<i32>(2, 0), size);
	let i = tap(o + vec2<i32>(-1, 1), size);
	let j = tap(o + vec2<i32>(0, 1), size);
	let k = tap(o + vec2<i32>(1, 1), size);
	let l = tap(o + vec2<i32>(2, 1), size);
	let n = tap(o + vec2<i32>(0, 2), size);
	let m = tap(o + vec2<i32>(1, 2), size);

	var acc = vec3<f32>(0.0);
	edge(&acc, (1.0 - pp.x) * (1.0 - pp.y), b.a, e.a, f.a, g.a, j.a);
	edge(&acc, pp.x * (1.0 - pp.y), c.a, f.a, g.a, h.a, k.a);
	edge(&acc, (1.0 - pp.x) * pp.y, f.a, i.a, j.a, k.a, n.a);
	edge(&acc, pp.x * pp.y, g.a, j.a, k.a, l.a, m.a);

	var dir = acc.xy;
	let r2 = dot(dir, dir);
	let zro = r2 < 1.0 / 32768.0;
	dir.x = select(dir.x, 1.0, zro);
	dir = dir * select(inverseSqrt(max(r2, 1.0e-20)), 1.0, zro);

	var len = acc.z * 0.5;
	len = len * len;
	let stretch = dot(dir, dir) / max(abs(dir.x), abs(dir.y));
	let len2 = vec2<f32>(1.0 + (stretch - 1.0) * len, 1.0 - 0.5 * len);
	let lob = 0.5 + ((1.0 / 4.0 - 0.04) - 0.5) * len;
	let clp = 1.0 / lob;

	var sum = vec4<f32>(0.0);
	lobe(&sum, vec2<f32>(0.0, -1.0) - pp, dir, len2, lob, clp, b.rgb);
	lobe(&sum, vec2<f32>(1.0, -1.0) - pp, dir, len2, lob, clp, c.rgb);
	lobe(&sum, vec2<f32>(-1.0, 1.0) - pp, dir, len2, lob, clp, i.rgb);
	lobe(&sum, vec2<f32>(0.0, 1.0) - pp, dir, len2, lob, clp, j.rgb);
	lobe(&sum, vec2<f32>(0.0, 0.0) - pp, dir, len2, lob, clp, f.rgb);
	lobe(&sum, vec2<f32>(-1.0, 0.0) - pp, dir, len2, lob, clp, e.rgb);
	lobe(&sum, vec2<f32>(1.0, 1.0) - pp, dir, len2, lob, clp, k.rgb);
	lobe(&sum, vec2<f32>(2.0, 1.0) - pp, dir, len2, lob, clp, l.rgb);
	lobe(&sum, vec2<f32>(2.0, 0.0) - pp, dir, len2, lob, clp, h.rgb);
	lobe(&sum, vec2<f32>(1.0, 0.0) - pp, dir, len2, lob, clp, g.rgb);
	lobe(&sum, vec2<f32>(1.0, 2.0) - pp, dir, len2, lob, clp, m.rgb);
	lobe(&sum, vec2<f32>(0.0, 2.0) - pp, dir, len2, lob, clp, n.rgb);

	let lo = min(min(f.rgb, g.rgb), min(j.rgb, k.rgb));
	let hi = max(max(f.rgb, g.rgb), max(j.rgb, k.rgb));
	return vec4<f32>(min(hi, max(lo, sum.rgb / max(sum.a, 1.0e-6))), 1.0);
}
`;

// RCAS sharpens each upscaled pixel against its four neighbours, as far as it can without
// pushing past their range, then presents it through the same tone path as a plain draw.
const RCAS = /* wgsl */ `
struct Params {
	tone: vec4<f32>,
	sharpen: vec4<f32>,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var source: texture_2d<f32>;
${TONE}
@vertex
fn vertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
	let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
	return vec4<f32>(uv * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), 0.0, 1.0);
}

fn load(p: vec2<i32>, size: vec2<i32>) -> vec3<f32> {
	return textureLoad(source, clamp(p, vec2<i32>(0), size - vec2<i32>(1)), 0).rgb;
}

@fragment
fn fragment(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
	let size = vec2<i32>(textureDimensions(source));
	let p = vec2<i32>(position.xy);
	let b = load(p + vec2<i32>(0, -1), size);
	let d = load(p + vec2<i32>(-1, 0), size);
	let e = load(p, size);
	let f = load(p + vec2<i32>(1, 0), size);
	let h = load(p + vec2<i32>(0, 1), size);

	let lo = min(min(b, d), min(f, h));
	let hi = max(max(b, d), max(f, h));
	let hit_min = lo / max(4.0 * hi, vec3<f32>(1.0e-5));
	let hit_max = (vec3<f32>(1.0) - hi) / min(4.0 * lo - vec3<f32>(4.0), vec3<f32>(-1.0e-5));
	let lobes = max(-hit_min, hit_max);
	let lobe = max(-0.1875, min(max(lobes.r, max(lobes.g, lobes.b)), 0.0)) * params.sharpen.x;
	return present((lobe * (b + d + f + h) + e) / (4.0 * lobe + 1.0), params.tone);
}
`;

// FSR 1's sharpness in stops: 0 is the strongest, each stop halves it.
const SHARPNESS = 0.2;

// GPUBufferUsage and GPUTextureUsage are globals only where WebGPU exists, so spell out the bits.
const UNIFORM = 0x40;
const COPY_DST = 0x08;
const TEXTURE_BINDING = 0x04;
const RENDER_ATTACHMENT = 0x10;

/** What {@link Zoom.encode} draws, and where. */
export type ZoomDraw = {
	/** The frame, imported for this submission. */
	frame: GPUExternalTexture;
	/** The frame's display size, which its RGB copy takes. */
	frameSize: Dimensions;
	/** The canvas texture to present into. */
	target: GPUTextureView;
	/** The canvas texture's format. */
	format: GPUTextureFormat;
	/** The canvas size in pixels. */
	size: Dimensions;
	/** The rows mapping a canvas coordinate to the frame coordinate it shows. */
	rows: { x: [number, number, number]; y: [number, number, number] };
	/** The tone mode the plain draw would present with. */
	tone: number;
	/** The PQ reference white, in nits. */
	white: number;
};

/**
 * Copies a magnified frame to RGB, upscales the copy with FSR 1's EASU, then sharpens it with RCAS,
 * on one device.
 */
export class Zoom {
	#device: GPUDevice;
	#copy: GPURenderPipeline;
	#easu: GPURenderPipeline;
	#rcas: GPUShaderModule;
	#presenters = new Map<GPUTextureFormat, GPURenderPipeline>();
	#sampler: GPUSampler;
	#rows: GPUBuffer;
	#params: GPUBuffer;
	#rgb?: GPUTexture;
	#scratch?: GPUTexture;

	constructor(device: GPUDevice) {
		this.#device = device;
		this.#copy = this.#pipeline(device.createShaderModule({ code: COPY }), "rgba16float");
		this.#easu = this.#pipeline(device.createShaderModule({ code: EASU }), "rgba16float");
		this.#rcas = device.createShaderModule({ code: RCAS });
		this.#sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
		this.#rows = device.createBuffer({ size: 32, usage: UNIFORM | COPY_DST });
		this.#params = device.createBuffer({ size: 32, usage: UNIFORM | COPY_DST });
	}

	#pipeline(module: GPUShaderModule, format: GPUTextureFormat): GPURenderPipeline {
		return this.#device.createRenderPipeline({
			layout: "auto",
			vertex: { module, entryPoint: "vertex" },
			fragment: { module, entryPoint: "fragment", targets: [{ format }] },
			primitive: { topology: "triangle-list" },
		});
	}

	#presenter(format: GPUTextureFormat): GPURenderPipeline {
		let pipeline = this.#presenters.get(format);
		if (!pipeline) {
			pipeline = this.#pipeline(this.#rcas, format);
			this.#presenters.set(format, pipeline);
		}
		return pipeline;
	}

	// A texture one pass draws and the next reads, kept while its size still fits.
	#sized(current: GPUTexture | undefined, size: Dimensions): GPUTexture {
		if (current && current.width === size.width && current.height === size.height) return current;
		current?.destroy();
		return this.#device.createTexture({
			size: [size.width, size.height],
			format: "rgba16float",
			usage: RENDER_ATTACHMENT | TEXTURE_BINDING,
		});
	}

	#pass(encoder: GPUCommandEncoder, view: GPUTextureView, pipeline: GPURenderPipeline, entries: GPUBindGroupEntry[]) {
		const pass = encoder.beginRenderPass({
			colorAttachments: [{ view, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }],
		});
		pass.setPipeline(pipeline);
		pass.setBindGroup(0, this.#device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }));
		pass.draw(3);
		pass.end();
	}

	/**
	 * Encode the copy into an RGB texture the frame's size, the upscale into a scratch texture the
	 * canvas's size, and the sharpen pass onto `draw.target`.
	 */
	encode(encoder: GPUCommandEncoder, draw: ZoomDraw): void {
		const rgb = this.#sized(this.#rgb, draw.frameSize);
		const scratch = this.#sized(this.#scratch, draw.size);
		this.#rgb = rgb;
		this.#scratch = scratch;
		const { x, y } = draw.rows;
		this.#device.queue.writeBuffer(this.#rows, 0, new Float32Array([...x, 0, ...y, 0]));
		this.#device.queue.writeBuffer(
			this.#params,
			0,
			new Float32Array([draw.tone, draw.white, 0, 0, 2 ** -SHARPNESS, 0, 0, 0]),
		);

		this.#pass(encoder, rgb.createView(), this.#copy, [
			{ binding: 0, resource: draw.frame },
			{ binding: 1, resource: this.#sampler },
		]);
		this.#pass(encoder, scratch.createView(), this.#easu, [
			{ binding: 0, resource: { buffer: this.#rows } },
			{ binding: 1, resource: rgb.createView() },
		]);
		this.#pass(encoder, draw.target, this.#presenter(draw.format), [
			{ binding: 0, resource: { buffer: this.#params } },
			{ binding: 1, resource: scratch.createView() },
		]);
	}

	/** Release the buffers and textures. The caller owns the device. */
	close(): void {
		this.#rgb?.destroy();
		this.#scratch?.destroy();
		this.#rows.destroy();
		this.#params.destroy();
	}
}
