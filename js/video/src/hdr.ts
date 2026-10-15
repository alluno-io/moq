/**
 * HDR presentation helpers for the renderer's main-thread WebGPU painter.
 *
 * A PQ (HDR10) frame imported into WebGPU arrives through the browser's own colour
 * conversion, and what that conversion does to a PQ signal is not specified. The
 * painter measures it once with a synthetic frame ({@link PQ_CALIBRATION}) and picks a
 * decode model with {@link classifyImport}; the shader then undoes that conversion and
 * applies the PQ transfer itself.
 *
 * @module
 */

/**
 * How the browser hands a PQ frame to a WebGPU shader.
 *
 * - `"signal"`: the PQ signal is passed through as if it were linear light, gamut-converted
 *   and sRGB-encoded (Chromium 153). The shader decodes the signal itself.
 * - `"native"`: the browser applied the PQ transfer and presents SDR white at 1.0, so the
 *   sampled values are already display-ready and are passed through.
 */
export type ImportModel = "signal" | "native";

/** PQ reference white in nits (ITU-R BT.2408), mapped onto the display's SDR white. */
export const PQ_REFERENCE_WHITE = 203;

/** The PQ signal (0..1) for an absolute luminance in nits (SMPTE ST 2084 inverse EOTF). */
export function pqEncode(nits: number): number {
	const m1 = 0.1593017578125;
	const m2 = 78.84375;
	const c1 = 0.8359375;
	const c2 = 18.8515625;
	const c3 = 18.6875;
	const y = (Math.max(nits, 0) / 10000) ** m1;
	return ((c1 + c2 * y) / (1 + c3 * y)) ** m2;
}

/** The sRGB-encoded value of a linear component, extended symmetrically below zero. */
export function srgbEncode(linear: number): number {
	const a = Math.abs(linear);
	const encoded = a <= 0.0031308 ? 12.92 * a : 1.055 * a ** (1 / 2.4) - 0.055;
	return Math.sign(linear) * encoded;
}

/** One calibration patch: the 8-bit limited-range PQ luma code and what each model predicts for it. */
export interface CalibrationPatch {
	/** Absolute luminance of the patch in nits. */
	nits: number;
	/** 8-bit limited-range luma code carrying that luminance as PQ. */
	code: number;
	/** What a `"signal"` import returns for the patch (grey, so one channel suffices). */
	signal: number;
	/** What a `"native"` import returns for the patch, relative to SDR white. */
	native: number;
}

function patch(nits: number): CalibrationPatch {
	const code = Math.round(16 + 219 * pqEncode(nits));
	const decoded = (code - 16) / 219;
	return {
		nits,
		code,
		signal: srgbEncode(decoded),
		native: srgbEncode(nits / PQ_REFERENCE_WHITE),
	};
}

/** The grey patches the painter renders to identify the browser's PQ import behaviour. */
export const PQ_CALIBRATION: readonly CalibrationPatch[] = [patch(PQ_REFERENCE_WHITE), patch(1000)];

/** Largest per-patch deviation a model prediction may have and still be accepted. */
export const CALIBRATION_TOLERANCE = 0.03;

/**
 * The import model whose predictions match the measured calibration samples, or `undefined`
 * when neither does, in which case HDR presentation is not attempted.
 */
export function classifyImport(
	samples: readonly number[],
	patches: readonly { signal: number; native: number }[],
	tolerance: number,
): ImportModel | undefined {
	if (samples.length !== patches.length || samples.length === 0) return undefined;
	let signal = true;
	let native = true;
	for (let i = 0; i < samples.length; i++) {
		const sample = samples[i];
		if (!Number.isFinite(sample)) return undefined;
		if (Math.abs(sample - patches[i].signal) > tolerance) signal = false;
		if (
			Math.abs(sample - Math.min(patches[i].native, 1)) > tolerance &&
			Math.abs(sample - patches[i].native) > tolerance
		) {
			native = false;
		}
	}
	if (signal) return "signal";
	if (native) return "native";
	return undefined;
}
