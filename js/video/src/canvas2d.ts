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
			const { width: w, height: h } = transform.source;
			ctx.drawImage(frame, 0, 0, w, h);

			if (presentation?.interlaced) {
				// The [1 2 1] line blend the WebGPU shader applies, built by compositing: a third of the
				// line above gives (2c + a) / 3, then a quarter of the line below gives (a + 2c + b) / 4.
				const line = h / (frame.visibleRect?.height ?? frame.codedHeight);
				ctx.globalAlpha = 1 / 3;
				ctx.drawImage(frame, 0, line, w, h);
				ctx.globalAlpha = 1 / 4;
				ctx.drawImage(frame, 0, -line, w, h);
			}
		}

		ctx.restore();
		return true;
	}

	close() {}
}
