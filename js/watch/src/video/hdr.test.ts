import { describe, expect, test } from "bun:test";
import { CALIBRATION_TOLERANCE, classifyImport, PQ_CALIBRATION, PQ_REFERENCE_WHITE, pqEncode, srgbEncode } from "./hdr";

describe("pq", () => {
	test("encodes the ST 2084 anchors", () => {
		expect(pqEncode(0)).toBeCloseTo(0, 5);
		expect(pqEncode(PQ_REFERENCE_WHITE)).toBeCloseTo(0.5811, 3);
		expect(pqEncode(1000)).toBeCloseTo(0.7518, 3);
		expect(pqEncode(10000)).toBeCloseTo(1, 6);
	});

	test("the calibration patches carry reference white and a highlight as 8-bit limited codes", () => {
		expect(PQ_CALIBRATION.map((p) => p.code)).toEqual([143, 181]);
		expect(PQ_CALIBRATION[0].signal).toBeCloseTo(srgbEncode((143 - 16) / 219), 6);
		expect(PQ_CALIBRATION[0].native).toBeCloseTo(1, 6);
		expect(PQ_CALIBRATION[1].native).toBeGreaterThan(1);
	});
});

describe("srgbEncode", () => {
	test("is symmetric below zero", () => {
		expect(srgbEncode(-0.5)).toBeCloseTo(-srgbEncode(0.5), 9);
		expect(srgbEncode(0.001)).toBeCloseTo(0.01292, 5);
	});
});

describe("classifyImport", () => {
	const patches = PQ_CALIBRATION;

	test("recognises a browser that hands the PQ signal through as if linear", () => {
		// Chromium 153: measured 0.7856 and 0.8799 for 203 and 1000 nits.
		expect(classifyImport([0.7856, 0.8799], patches, CALIBRATION_TOLERANCE)).toBe("signal");
	});

	test("recognises a browser that applies the transfer itself, clipped or extended", () => {
		expect(classifyImport([1, 1], patches, CALIBRATION_TOLERANCE)).toBe("native");
		expect(classifyImport([1, patches[1].native], patches, CALIBRATION_TOLERANCE)).toBe("native");
	});

	test("rejects tone-mapped, partial and non-finite samples", () => {
		// The 2D canvas mapping (187/255 and 254/255) matches neither model.
		expect(classifyImport([0.733, 0.996], patches, CALIBRATION_TOLERANCE)).toBeUndefined();
		expect(classifyImport([0.7856], patches, CALIBRATION_TOLERANCE)).toBeUndefined();
		expect(classifyImport([Number.NaN, 0.8799], patches, CALIBRATION_TOLERANCE)).toBeUndefined();
		expect(classifyImport([], [], CALIBRATION_TOLERANCE)).toBeUndefined();
	});
});
