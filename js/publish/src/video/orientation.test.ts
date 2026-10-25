import { expect, mock, test } from "bun:test";
import { Effect, Signal } from "@moq/signals";
import { bestTurn, reportsRotation, watchRotation } from "./orientation";
import type { StreamTrack } from "./types";

mock.module("./capture-worker.ts?worklet", () => ({ default: async () => "blob:fake-worker" }));
const { Capture } = await import("./capture");

const SIZE = 16;

function picture(): Float32Array {
	const grid = new Float32Array(SIZE * SIZE);
	for (let y = 0; y < SIZE; y++) {
		for (let x = 0; x < SIZE; x++) grid[y * SIZE + x] = (x * 13 + y * y * 7 + ((x * y) % 11) * 5) % 256;
	}
	return grid;
}

function clockwise(grid: Float32Array): Float32Array {
	const out = new Float32Array(grid.length);
	for (let y = 0; y < SIZE; y++) {
		for (let x = 0; x < SIZE; x++) out[y * SIZE + x] = grid[(SIZE - 1 - x) * SIZE + y];
	}
	return out;
}

function mirror(grid: Float32Array): Float32Array {
	const out = new Float32Array(grid.length);
	for (let y = 0; y < SIZE; y++) {
		for (let x = 0; x < SIZE; x++) out[y * SIZE + x] = grid[y * SIZE + (SIZE - 1 - x)];
	}
	return out;
}

function present(grid: Float32Array, turn: number, flip: boolean): Float32Array {
	let out = grid;
	for (let i = 0; i < turn / 90; i++) out = clockwise(out);
	return flip ? mirror(out) : out;
}

test("a clockwise turn takes the top left corner to the top right", () => {
	const grid = new Float32Array(SIZE * SIZE);
	grid[0] = 255;
	expect(clockwise(grid)[SIZE - 1]).toBe(255);
});

test("the turn a picture is painted with is found, mirrored or not", () => {
	const raw = picture();
	for (const turn of [0, 90, 180, 270]) {
		for (const flip of [false, true]) {
			expect(bestTurn(raw, present(raw, turn, flip), SIZE)).toBe(turn);
		}
	}
});

test("the turn survives the resampling noise of two paint paths", () => {
	const raw = picture();
	const shown = present(raw, 270, false).map((value, i) => value + ((i * 7) % 5) - 2);
	expect(bestTurn(raw, shown, SIZE)).toBe(270);
});

test("a flat picture gives no turn", () => {
	const flat = new Float32Array(SIZE * SIZE).fill(128);
	expect(bestTurn(flat, flat, SIZE)).toBeUndefined();
});

test("an engine reports rotation when its VideoFrame has the attribute, or has no VideoFrame", () => {
	const original = Object.getOwnPropertyDescriptor(globalThis, "VideoFrame");
	try {
		Object.defineProperty(globalThis, "VideoFrame", { configurable: true, value: class {} });
		expect(reportsRotation()).toBe(false);
		Object.defineProperty(globalThis, "VideoFrame", {
			configurable: true,
			value: class {
				get rotation() {
					return 0;
				}
			},
		});
		expect(reportsRotation()).toBe(true);
		Reflect.deleteProperty(globalThis, "VideoFrame");
		expect(reportsRotation()).toBe(true);
	} finally {
		if (original) Object.defineProperty(globalThis, "VideoFrame", original);
		else Reflect.deleteProperty(globalThis, "VideoFrame");
	}
});

function rgba(grid: Float32Array): Uint8ClampedArray {
	const out = new Uint8ClampedArray(grid.length * 4);
	for (let i = 0; i < grid.length; i++) out.fill(grid[i], 4 * i, 4 * i + 3);
	return out;
}

function page(turn: number, video: { width: number; height: number }) {
	const globals = ["document", "MediaStream", "VideoFrame"] as const;
	const saved = globals.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));

	const raw = picture();
	const element = Object.assign(new EventTarget(), {
		HAVE_CURRENT_DATA: 2,
		readyState: 2,
		videoWidth: video.width,
		videoHeight: video.height,
		muted: false,
		playsInline: false,
		srcObject: null as unknown,
		play: () => Promise.resolve(),
	});

	let painted: unknown;
	const context = {
		drawImage: (source: unknown) => {
			painted = source;
		},
		getImageData: () => ({ data: rgba(painted === element ? present(raw, turn, false) : raw) }),
	};
	const canvas = { width: 0, height: 0, getContext: () => context };

	const frames: { closed: boolean }[] = [];
	class Frame {
		displayWidth = 1280;
		displayHeight = 720;
		codedWidth = 1280;
		codedHeight = 720;
		timestamp: number;
		closed = false;
		constructor(_source?: unknown, init?: { timestamp?: number }) {
			this.timestamp = init?.timestamp ?? 0;
			frames.push(this);
		}
		clone() {
			return new Frame(this, { timestamp: this.timestamp });
		}
		close() {
			this.closed = true;
		}
	}

	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: { createElement: (tag: string) => (tag === "canvas" ? canvas : element) },
	});
	Object.defineProperty(globalThis, "MediaStream", { configurable: true, value: class {} });
	Object.defineProperty(globalThis, "VideoFrame", { configurable: true, value: Frame });

	return {
		element,
		frames,
		Frame,
		[Symbol.dispose]() {
			globals.forEach((name, i) => {
				const descriptor = saved[i];
				if (descriptor) Object.defineProperty(globalThis, name, descriptor);
				else Reflect.deleteProperty(globalThis, name);
			});
		},
	};
}

test("the rotation follows how the engine paints the camera", () => {
	using engine = page(90, { width: 720, height: 1280 });
	const effect = new Effect();
	const rotation = new Signal<number | undefined>(undefined);

	watchRotation(effect, {} as StreamTrack, rotation);
	engine.element.dispatchEvent(new Event("loadeddata"));
	expect(rotation.peek()).toBe(90);
	expect(engine.frames.length).toBeGreaterThan(0);
	expect(engine.frames.every((frame) => frame.closed)).toBe(true);

	effect.close();
	expect(engine.element.srcObject).toBeNull();
});

test("a painting that disagrees with the element's size is ignored", () => {
	using engine = page(90, { width: 1280, height: 720 });
	const effect = new Effect();
	const rotation = new Signal<number | undefined>(undefined);

	watchRotation(effect, {} as StreamTrack, rotation);
	engine.element.dispatchEvent(new Event("loadeddata"));
	expect(rotation.peek()).toBeUndefined();

	effect.close();
});

test("a capture takes the turn the engine paints its camera with over the screen's", async () => {
	using engine = page(180, { width: 1280, height: 720 });
	const processor = Object.getOwnPropertyDescriptor(globalThis, "MediaStreamTrackProcessor");
	let controller!: ReadableStreamDefaultController<VideoFrame>;
	const readable = new ReadableStream<VideoFrame>({
		start: (value) => {
			controller = value;
		},
	});
	Object.defineProperty(globalThis, "MediaStreamTrackProcessor", {
		configurable: true,
		value: class {
			readonly readable = readable;
		},
	});

	const capture = new Capture({ source: {} as StreamTrack, orientation: new Signal(0) });
	try {
		const display = capture.out.display.changed();
		controller.enqueue(new engine.Frame() as unknown as VideoFrame);
		expect(await display).toMatchObject({ width: 1280, height: 720 });
		expect(capture.out.rotation.peek()).toBe(0);

		const rotation = capture.out.rotation.changed();
		engine.element.dispatchEvent(new Event("loadeddata"));
		expect(await rotation).toBe(180);
	} finally {
		capture.close();
		if (processor) Object.defineProperty(globalThis, "MediaStreamTrackProcessor", processor);
		else Reflect.deleteProperty(globalThis, "MediaStreamTrackProcessor");
	}
	expect(capture.out.rotation.peek()).toBe(0);
	expect(engine.element.srcObject).toBeNull();
});
