import { canvasPresentationTransform, type Presentation } from "./presentation";

/** Draws frames into a Canvas2D context. */
export class Canvas2D {
	#ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

	constructor(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) {
		this.#ctx = ctx;
	}

	/** Draw `frame`, or clear to black without one. Draws nothing and returns false while the context is lost. */
	draw(frame: VideoFrame | undefined, presentation: Presentation | undefined): boolean {
		const ctx = this.#ctx;
		if (ctx.isContextLost?.()) return false;
		const { width, height } = ctx.canvas;

		ctx.save();
		ctx.fillStyle = "#000";
		ctx.fillRect(0, 0, width, height);

		if (frame) {
			const transform = canvasPresentationTransform({ width, height }, presentation);
			ctx.setTransform(...transform.matrix);
			ctx.drawImage(frame, 0, 0, transform.source.width, transform.source.height);
		}

		ctx.restore();
		return true;
	}

	close() {}
}
