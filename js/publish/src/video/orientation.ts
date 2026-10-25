import { Milli, Nano } from "@moq/clock";
import type { Effect, Signal } from "@moq/signals";
import type { StreamTrack } from "./types";

const SIZE = 16;
const PERIOD = Nano.fromMilli(Milli(1000));
const MARGIN = 0.5;
const FLOOR = 4;
const TURNS = [0, 90, 180, 270] as const;

/** Whether this engine reports how each frame is turned, through `VideoFrame.rotation`. */
export function reportsRotation(): boolean {
	return typeof VideoFrame === "undefined" || "rotation" in VideoFrame.prototype;
}

/**
 * Keeps `rotation` at the clockwise quarter-turn the engine paints `track` with, for an engine that turns
 * a camera's frames only when painting them and leaves `VideoFrame.rotation` out (WebKit). Compares a
 * frame taken off a `<video>` of the track with the same `<video>` painted, about once a second.
 */
export function watchRotation(effect: Effect, track: StreamTrack, rotation: Signal<number | undefined>): void {
	if (typeof document === "undefined") return;

	const canvas = document.createElement("canvas");
	canvas.width = SIZE;
	canvas.height = SIZE;
	const context = canvas.getContext("2d", { willReadFrequently: true });
	if (!context) return;

	const video = document.createElement("video");
	video.muted = true;
	video.playsInline = true;
	video.srcObject = new MediaStream([track]);
	video.play().catch(() => {});
	effect.cleanup(() => {
		video.srcObject = null;
	});

	const check = () => {
		const turn = measure(video, context);
		if (turn !== undefined) rotation.set(turn);
	};
	effect.event(video, "loadeddata", check);
	effect.interval(check, PERIOD);
}

function measure(video: HTMLVideoElement, context: CanvasRenderingContext2D): number | undefined {
	if (video.readyState < video.HAVE_CURRENT_DATA) return;

	let frame: VideoFrame;
	try {
		frame = new VideoFrame(video);
	} catch {
		return;
	}

	try {
		context.drawImage(frame, 0, 0, SIZE, SIZE);
		const raw = luma(context.getImageData(0, 0, SIZE, SIZE).data);
		context.drawImage(video, 0, 0, SIZE, SIZE);
		const shown = luma(context.getImageData(0, 0, SIZE, SIZE).data);

		const turn = bestTurn(raw, shown, SIZE);
		if (turn === undefined || frame.displayWidth === frame.displayHeight) return turn;
		const turned = frame.displayWidth > frame.displayHeight !== video.videoWidth > video.videoHeight;
		return turned === (turn % 180 !== 0) ? turn : undefined;
	} catch {
		return;
	} finally {
		frame.close();
	}
}

function luma(rgba: Uint8ClampedArray): Float32Array {
	const out = new Float32Array(rgba.length / 4);
	for (let i = 0; i < out.length; i++) {
		out[i] = 0.299 * rgba[4 * i] + 0.587 * rgba[4 * i + 1] + 0.114 * rgba[4 * i + 2];
	}
	return out;
}

/**
 * The clockwise quarter-turn that best maps `raw` onto `shown`, two `size` by `size` luma grids, with or
 * without a mirror after it, as a catalog `rotation` reads. Undefined when no turn clearly wins, as with a
 * picture too flat to tell.
 */
export function bestTurn(raw: ArrayLike<number>, shown: ArrayLike<number>, size: number): number | undefined {
	const costs = TURNS.map((turn) =>
		Math.min(distance(raw, shown, size, turn, false), distance(raw, shown, size, turn, true)),
	);
	const order = TURNS.map((_, index) => index).sort((a, b) => costs[a] - costs[b]);
	const best = costs[order[0]];
	const next = costs[order[1]];
	if (next < FLOOR * size * size || best > MARGIN * next) return undefined;
	return TURNS[order[0]];
}

function distance(raw: ArrayLike<number>, shown: ArrayLike<number>, size: number, turn: number, flip: boolean): number {
	const last = size - 1;
	let sum = 0;
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const u = flip ? last - x : x;
			let from: number;
			if (turn === 90) from = (last - u) * size + y;
			else if (turn === 180) from = (last - y) * size + (last - u);
			else if (turn === 270) from = u * size + (last - y);
			else from = y * size + u;
			sum += Math.abs(shown[y * size + x] - raw[from]);
		}
	}
	return sum;
}
