import * as Util from "@moq/hang/util";
import { Effect, readonlys, Signal } from "@moq/signals";
import { hostedAssets } from "../assets";
import type { GraphReply, GraphRequest, Playback } from "./graph";
// A blob: URL, or a hosted file when assets() is set; see vite-plugin-worklet.
import RenderWorklet from "./render-worklet.ts?worklet";

type HostOutput = {
	/** The AudioContext of the newest open graph. */
	context: Signal<AudioContext | undefined>;
	/** The render worklet of the newest open graph, which an {@link Emitter} plays. */
	root: Signal<AudioNode | undefined>;
};

/**
 * Builds the render worklets a {@link RemoteGraph} asks for at the other end of `port`, on a thread
 * that can own an AudioContext, such as the page that started a worker.
 *
 * Each worklet's port is transferred back, so decoded audio flows from the decoder straight to the
 * audio thread. This side keeps the output: pass it to an {@link Emitter} as the source.
 */
export class Host {
	readonly #out: HostOutput = {
		context: new Signal<AudioContext | undefined>(undefined),
		root: new Signal<AudioNode | undefined>(undefined),
	};
	/** The derived outputs, read-only. */
	readonly out = readonlys(this.#out);

	#port: MessagePort;
	#playback = new Signal<Playback>("hold");
	#graphs = new Map<number, Effect>();
	#signals = new Effect();

	constructor(port: MessagePort) {
		this.#port = port;
		this.#signals.event(port, "message", (event: Event) => {
			this.#request((event as MessageEvent<GraphRequest>).data);
		});
		port.start();

		this.#signals.cleanup(() => {
			for (const graph of this.#graphs.values()) graph.close();
			this.#graphs.clear();
		});
		this.#signals.run(this.#runPlayback.bind(this));
	}

	#request(request: GraphRequest): void {
		if (request?.type === "open") {
			this.#open(request.id, request.sampleRate, request.channels);
		} else if (request?.type === "close") {
			this.#graphs.get(request.id)?.close();
			this.#graphs.delete(request.id);
		} else if (request?.type === "playback") {
			this.#playback.set(request.playback);
		}
	}

	#open(id: number, sampleRate: number, channelCount: number): void {
		const graph = new Effect();
		this.#graphs.set(id, graph);

		let context: AudioContext;
		try {
			context = new AudioContext({ latencyHint: "interactive", sampleRate });
		} catch (error) {
			console.error("audio: cannot build an AudioContext", error);
			this.#reply({ type: "failed", id });
			return;
		}
		graph.cleanup(() => context.close());
		this.#hold(graph, this.#out.context, context);

		graph.spawn(async () => {
			let worklet: AudioWorkletNode;
			try {
				// Race teardown as the decoder does: a load that close() abandoned must not build the node.
				const loaded = await graph.race(
					RenderWorklet(hostedAssets()).then(async (url) => {
						await context.audioWorklet.addModule(url);
						return true;
					}),
				);
				if (!loaded) return;

				worklet = new AudioWorkletNode(context, "render", {
					channelCount,
					channelCountMode: "explicit",
					outputChannelCount: [channelCount],
				});
			} catch (error) {
				this.#reply({ type: "failed", id });
				throw error;
			}
			graph.cleanup(() => worklet.disconnect());

			this.#reply({ type: "opened", id, port: worklet.port }, [worklet.port]);
			this.#hold(graph, this.#out.root, worklet);
		});
	}

	// Point `signal` at `value` until `graph` closes, unless a newer graph has taken it over by then.
	#hold<T>(graph: Effect, signal: Signal<T | undefined>, value: T): void {
		signal.set(value);
		graph.cleanup(() => {
			if (signal.peek() === value) signal.set(undefined);
		});
	}

	#reply(reply: GraphReply, transfer: Transferable[] = []): void {
		this.#port.postMessage(reply, transfer);
	}

	#runPlayback(effect: Effect): void {
		const context = effect.get(this.#out.context);
		if (!context) return;

		const playback = effect.get(this.#playback);
		if (playback === "idle") {
			context.suspend().catch(() => {});
		} else if (playback === "play") {
			// The context is built before any user gesture, so it must be started from a real interaction.
			Util.Gesture.unlock(effect, context);
		}
	}

	/** Close every graph and stop answering. */
	close(): void {
		this.#signals.close();
	}
}
