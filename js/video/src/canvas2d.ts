import { canvasPresentationTransform, type Presentation, type Rect } from "./presentation";

/** Draws frames into a Canvas2D context. */
export class Canvas2D {
	#ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

	constructor(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) {
		this.#ctx = ctx;
	}

	/**
	 * Draw `frame`, or clear to black without one, filling `view` of the canvas when given. Draws nothing
	 * and returns false while the context is lost.
	 */
	draw(frame: VideoFrame | undefined, presentation: Presentation | undefined, view?: Rect): boolean {
		const ctx = this.#ctx;
		if (ctx.isContextLost?.()) return false;
		const { width, height } = ctx.canvas;

		ctx.save();
		ctx.fillStyle = "#000";
		ctx.fillRect(0, 0, width, height);

		if (frame) {
			const area = view ?? { x: 0, y: 0, width, height };
			const transform = canvasPresentationTransform({ width: area.width, height: area.height }, presentation);
			const [a, b, c, d, e, f] = transform.matrix;
			if (view) ctx.imageSmoothingQuality = "high";
			ctx.setTransform(a, b, c, d, e + area.x, f + area.y);
			ctx.drawImage(frame, 0, 0, transform.source.width, transform.source.height);
		}

		ctx.restore();
		return true;
	}

	close() {}
}
