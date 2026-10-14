import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Signal } from "@moq/signals";
import type { Decoder } from "./decoder";
import { Renderer } from "./renderer";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await flush();
}

let queued: FrameRequestCallback[] = [];
const realRequest = globalThis.requestAnimationFrame;
const realCancel = globalThis.cancelAnimationFrame;

beforeEach(() => {
	queued = [];
	Object.assign(globalThis, {
		requestAnimationFrame: (callback: FrameRequestCallback) => queued.push(callback),
		cancelAnimationFrame: () => {},
	});
});

afterEach(() => {
	Object.assign(globalThis, { requestAnimationFrame: realRequest, cancelAnimationFrame: realCancel });
});

function refresh(): void {
	for (const callback of queued.splice(0)) callback(0);
}

class FakeContext {
	fillStyle = "";
	lost = false;
	saved = 0;
	failNext = false;
	readonly drawn: unknown[] = [];
	readonly canvas: FakeCanvas;

	constructor(canvas: FakeCanvas) {
		this.canvas = canvas;
	}

	isContextLost(): boolean {
		return this.lost;
	}

	fillRect(): void {}
	scale(): void {}
	translate(): void {}

	save(): void {
		this.saved++;
	}

	restore(): void {
		this.saved--;
	}

	drawImage(frame: unknown): void {
		if (this.failNext) {
			this.failNext = false;
			throw new Error("draw failed");
		}
		this.drawn.push(frame);
	}
}

class FakeCanvas extends EventTarget {
	width = 0;
	height = 0;
	readonly context = new FakeContext(this);

	getContext(): FakeContext {
		return this.context;
	}
}

class FakeFrame {
	readonly timestamp: number;

	constructor(timestamp: number) {
		this.timestamp = timestamp;
	}

	clone(): FakeFrame {
		return new FakeFrame(this.timestamp);
	}

	close(): void {}
}

function frame(timestamp: number): VideoFrame {
	return new FakeFrame(timestamp) as unknown as VideoFrame;
}

function setup() {
	const decoder = {
		frame: new Signal<VideoFrame | undefined>(undefined),
		display: new Signal<{ width: number; height: number } | undefined>({ width: 4, height: 4 }),
		hdr: new Signal(false),
		enabled: new Signal(false),
		source: { catalog: new Signal<{ flip?: boolean } | undefined>(undefined) },
	};
	const canvas = new FakeCanvas();
	const renderer = new Renderer(decoder as unknown as Decoder, {
		canvas: canvas as unknown as HTMLCanvasElement,
		visible: "always",
	});
	return { decoder, canvas, renderer };
}

describe("Renderer painted count", () => {
	it("counts a frame once it is painted, not when the decoder hands it over", async () => {
		const { decoder, canvas, renderer } = setup();

		decoder.frame.set(frame(1));
		await settle();
		expect(renderer.painted.peek()).toBe(0);

		refresh();
		expect(canvas.context.drawn).toHaveLength(1);
		expect(renderer.painted.peek()).toBe(1);

		renderer.close();
	});

	it("counts each frame once however often it is repainted", async () => {
		const { decoder, canvas, renderer } = setup();

		decoder.frame.set(frame(1));
		await settle();
		refresh();
		decoder.display.set({ width: 8, height: 8 });
		await settle();
		refresh();

		expect(canvas.context.drawn).toHaveLength(2);
		expect(renderer.painted.peek()).toBe(1);

		renderer.close();
	});

	it("counts frames that land within one refresh as the one painted", async () => {
		const { decoder, canvas, renderer } = setup();

		decoder.frame.set(frame(1));
		await settle();
		decoder.frame.set(frame(2));
		await settle();
		refresh();

		expect(canvas.context.drawn).toHaveLength(1);
		expect(renderer.painted.peek()).toBe(1);

		renderer.close();
	});

	it("paints and counts nothing while the context is lost, and catches up once it is restored", async () => {
		const { decoder, canvas, renderer } = setup();

		canvas.context.lost = true;
		decoder.frame.set(frame(1));
		await settle();
		refresh();
		expect(canvas.context.drawn).toHaveLength(0);
		expect(renderer.painted.peek()).toBe(0);

		canvas.context.lost = false;
		canvas.dispatchEvent(new Event("contextrestored"));
		refresh();
		expect(canvas.context.drawn).toHaveLength(1);
		expect(renderer.painted.peek()).toBe(1);

		renderer.close();
	});

	it("leaves the canvas unmirrored and the frame uncounted when a mirrored paint throws", async () => {
		const { decoder, canvas, renderer } = setup();

		decoder.source.catalog.set({ flip: true });
		canvas.context.failNext = true;
		decoder.frame.set(frame(1));
		await settle();
		expect(refresh).toThrow("draw failed");
		expect(canvas.context.saved).toBe(0);
		expect(renderer.painted.peek()).toBe(0);

		decoder.frame.set(frame(2));
		await settle();
		refresh();
		expect(canvas.context.saved).toBe(0);
		expect(renderer.painted.peek()).toBe(1);

		renderer.close();
	});
});
