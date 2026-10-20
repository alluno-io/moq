import { describe, expect, it } from "bun:test";
import {
	canvasPresentationTransform,
	magnifies,
	type Presentation,
	rotateVideoDimensions,
	texturePresentationTransform,
	viewPresentationTransform,
} from "./presentation";

const output = { width: 640, height: 360 };
type Matrix = [number, number, number, number, number, number];
type Dimensions = { width: number; height: number };

const rotations: [number, Matrix, Dimensions][] = [
	[0, [1, 0, 0, 1, 0, 0], output],
	[90, [0, 1, -1, 0, 640, 0], { width: 360, height: 640 }],
	[180, [-1, 0, 0, -1, 640, 360], output],
	[270, [0, -1, 1, 0, 0, 360], { width: 360, height: 640 }],
];

const flips: [number, Matrix][] = [
	[0, [-1, 0, 0, 1, 640, 0]],
	[90, [0, 1, 1, 0, 0, 0]],
	[180, [1, 0, 0, -1, 0, 360]],
	[270, [0, -1, -1, 0, 640, 360]],
];

function video(rotation: number, flip = false): Presentation {
	return { rotation, flip };
}

describe("video presentation", () => {
	it.each(rotations)("rotates %i degrees clockwise", (rotation, matrix, source) => {
		expect(canvasPresentationTransform(output, video(rotation))).toEqual({ matrix, source });
		expect(rotateVideoDimensions(output, rotation)).toEqual(source);
	});

	it.each(flips)("flips the %i degree presentation horizontally", (rotation, matrix) => {
		expect(canvasPresentationTransform(output, video(rotation, true)).matrix).toEqual(matrix);
	});

	it("normalizes rotations to the nearest quarter-turn", () => {
		expect(canvasPresentationTransform(output, video(44)).matrix).toEqual([1, 0, 0, 1, 0, 0]);
		expect(canvasPresentationTransform(output, video(46)).matrix).toEqual([0, 1, -1, 0, 640, 0]);
		expect(canvasPresentationTransform(output, video(-90)).matrix).toEqual([0, -1, 1, 0, 0, 360]);
		expect(canvasPresentationTransform(output, video(450)).matrix).toEqual([0, 1, -1, 0, 640, 0]);
	});
});

describe("texture presentation", () => {
	const cases = [0, 90, 180, 270].flatMap((rotation) => [
		[rotation, false],
		[rotation, true],
	]) as [number, boolean][];

	// Wherever Canvas2D puts a point of the frame, WebGPU must sample that same point there.
	it.each(cases)("matches Canvas2D at %i degrees, flip %p", (rotation, flip) => {
		const presentation = video(rotation, flip);
		const { matrix, source } = canvasPresentationTransform(output, presentation);
		const [a, b, c, d, e, f] = matrix;
		const { x, y } = texturePresentationTransform(output, presentation);

		for (const [sx, sy] of [
			[0, 0],
			[source.width, 0],
			[0, source.height],
			[source.width, source.height],
			[source.width / 4, source.height / 3],
		]) {
			const u = (a * sx + c * sy + e) / output.width;
			const v = (b * sx + d * sy + f) / output.height;
			expect(x[0] * u + x[1] * v + x[2]).toBeCloseTo(sx / source.width);
			expect(y[0] * u + y[1] * v + y[2]).toBeCloseTo(sy / source.height);
		}
	});

	it("is the identity without rotation or flip", () => {
		expect(texturePresentationTransform(output)).toEqual({ x: [1, 0, 0], y: [0, 1, 0] });
	});
});

describe("view presentation", () => {
	const cases = [0, 90, 180, 270].flatMap((rotation) => [
		[rotation, false],
		[rotation, true],
	]) as [number, boolean][];

	function at(rows: { x: number[]; y: number[] }, u: number, v: number): [number, number] {
		return [rows.x[0] * u + rows.x[1] * v + rows.x[2], rows.y[0] * u + rows.y[1] * v + rows.y[2]];
	}

	it.each(cases)("is the texture map when the view is the canvas, at %i degrees, flip %p", (rotation, flip) => {
		const full = { x: 0, y: 0, ...output };
		const rows = viewPresentationTransform(output, full, video(rotation, flip));
		const expected = texturePresentationTransform(output, video(rotation, flip));
		for (const [u, v] of [
			[0, 0],
			[1, 0.25],
			[0.5, 1],
		]) {
			const [fu, fv] = at(rows, u, v);
			const [eu, ev] = at(expected, u, v);
			expect(fu).toBeCloseTo(eu);
			expect(fv).toBeCloseTo(ev);
		}
	});

	it("maps the view's corners to the frame's, and the canvas inside it to the part it shows", () => {
		const rows = viewPresentationTransform(output, { x: -320, y: -180, width: 1280, height: 720 });
		expect(at(rows, -0.5, -0.5)).toEqual([0, 0]);
		expect(at(rows, 1.5, 1.5)).toEqual([1, 1]);
		expect(at(rows, 0, 0)).toEqual([0.25, 0.25]);
		expect(at(rows, 1, 1)).toEqual([0.75, 0.75]);
	});

	it("turns the frame within the view", () => {
		const rows = viewPresentationTransform(output, { x: 160, y: 0, width: 320, height: 360 }, video(90));
		const [lu, lv] = at(rows, 0.25, 0);
		expect(lu).toBeCloseTo(0);
		expect(lv).toBeCloseTo(1);
		const [ru, rv] = at(rows, 0.75, 0);
		expect(ru).toBeCloseTo(0);
		expect(rv).toBeCloseTo(0);
	});

	it("magnifies only when the view spreads the shown frame over more pixels than it has", () => {
		const frame = { width: 1920, height: 1080 };
		expect(magnifies(frame, { x: 0, y: 0, width: 1920, height: 1080 })).toBe(false);
		expect(magnifies(frame, { x: 0, y: 0, width: 1290, height: 726 })).toBe(false);
		expect(magnifies(frame, { x: -500, y: -300, width: 3840, height: 2160 })).toBe(true);
		expect(magnifies(frame, { x: 0, y: 0, width: 1600, height: 2840 })).toBe(false);
		expect(magnifies(frame, { x: 0, y: 0, width: 1600, height: 2840 }, video(90))).toBe(true);
	});
});
