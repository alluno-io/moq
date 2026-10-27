/** The sample rate and channel count a render worklet is built for. */
export type GraphShape = { sampleRate: number; channels: number };

/** The port of a render worklet opened for one {@link GraphShape}. */
export type GraphPort = { port: MessagePort };

/**
 * What playback asks of the AudioContext.
 *
 * - `"idle"`: nothing is left to play, so suspend it.
 * - `"play"`: start it from a user gesture, as browsers that gate audio require.
 * - `"hold"`: leave it as it is, as while muted.
 */
export type Playback = "idle" | "play" | "hold";

/**
 * Where a {@link Decoder} sends decoded audio when it owns no AudioContext, as in a worker.
 *
 * The decoder talks to the render worklet over the port {@link Graph.open} resolves, and the side
 * that owns the AudioContext handles output, volume, and suspending while idle.
 */
export interface Graph {
	/** Open a render worklet for `shape`, resolving its port, or undefined if `signal` aborts first. */
	open(shape: GraphShape, signal: AbortSignal): Promise<GraphPort | undefined>;
	/** Report what playback asks of the AudioContext. */
	playback(playback: Playback): void;
}

/** What a {@link RemoteGraph} asks its {@link Host} for. */
export type GraphRequest =
	| { type: "open"; id: number; sampleRate: number; channels: number }
	| { type: "close"; id: number }
	| { type: "playback"; playback: Playback };

/** What a {@link Host} answers a {@link RemoteGraph} with. */
export type GraphReply = { type: "opened"; id: number; port: MessagePort } | { type: "failed"; id: number };

/** A {@link Graph} whose AudioContext a {@link Host} owns at the other end of `port`, such as the page that started a worker. */
export class RemoteGraph implements Graph {
	#port: MessagePort;
	#next = 0;
	#pending = new Map<number, (port: MessagePort | undefined) => void>();
	#listener: (event: MessageEvent<GraphReply>) => void;

	constructor(port: MessagePort) {
		this.#port = port;
		this.#listener = ({ data }) => {
			if (data?.type !== "opened" && data?.type !== "failed") return;
			const resolve = this.#pending.get(data.id);
			this.#pending.delete(data.id);
			if (resolve) resolve(data.type === "opened" ? data.port : undefined);
			else if (data.type === "opened") data.port.close();
		};
		port.addEventListener("message", this.#listener as EventListener);
		port.start();
	}

	/** Ask the host for a render worklet for `shape`, and tell it to close the worklet once `signal` aborts. */
	async open(shape: GraphShape, signal: AbortSignal): Promise<GraphPort | undefined> {
		if (signal.aborted) return undefined;
		const id = ++this.#next;
		const opened = new Promise<MessagePort | undefined>((resolve) => this.#pending.set(id, resolve));
		signal.addEventListener(
			"abort",
			() => {
				this.#pending.get(id)?.(undefined);
				this.#pending.delete(id);
				this.#send({ type: "close", id });
			},
			{ once: true },
		);
		this.#send({ type: "open", id, sampleRate: shape.sampleRate, channels: shape.channels });

		const port = await opened;
		if (!port) return undefined;
		if (signal.aborted) {
			port.close();
			return undefined;
		}
		return { port };
	}

	/** Tell the host what playback asks of its AudioContext. */
	playback(playback: Playback): void {
		this.#send({ type: "playback", playback });
	}

	/** Stop listening to the host and give up every open still waiting. */
	close(): void {
		this.#port.removeEventListener("message", this.#listener as EventListener);
		for (const resolve of this.#pending.values()) resolve(undefined);
		this.#pending.clear();
	}

	#send(request: GraphRequest): void {
		this.#port.postMessage(request);
	}
}
