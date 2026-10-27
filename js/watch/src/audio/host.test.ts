import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { type GraphShape, RemoteGraph } from "./graph";

// Bun cannot load the blob-URL worklet import.
mock.module("./render-worklet.ts?worklet", () => ({ default: async () => "blob:fake-render" }));
const { Host } = await import("./host");

let contexts: FakeContext[] = [];
let nodes: FakeNode[] = [];
// What the next worklet module load does.
let load: () => Promise<void> = () => Promise.resolve();

class FakeContext extends EventTarget {
	state: AudioContextState = "running";
	readonly sampleRate: number;
	readonly audioWorklet = { addModule: () => load() };
	readonly calls = { suspend: 0, resume: 0, close: 0 };
	constructor(options: AudioContextOptions) {
		super();
		this.sampleRate = options.sampleRate ?? 48_000;
		contexts.push(this);
	}
	#transition(state: AudioContextState) {
		this.state = state;
		this.dispatchEvent(new Event("statechange"));
	}
	suspend = async () => {
		this.calls.suspend++;
		this.#transition("suspended");
	};
	resume = async () => {
		this.calls.resume++;
		this.#transition("running");
	};
	close = async () => {
		this.calls.close++;
		this.#transition("closed");
	};
}

// A worklet node whose port is real, with the processor's end of it left to the test.
class FakeNode {
	readonly context: FakeContext;
	readonly options: AudioWorkletNodeOptions;
	readonly port: MessagePort;
	readonly processor: MessagePort;
	disconnected = 0;
	constructor(context: FakeContext, _name: string, options: AudioWorkletNodeOptions) {
		this.context = context;
		this.options = options;
		const channel = new MessageChannel();
		this.port = channel.port1;
		this.processor = channel.port2;
		nodes.push(this);
	}
	disconnect() {
		this.disconnected++;
	}
}

const globals = ["AudioContext", "AudioWorkletNode", "document"] as const;
const originals = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
	contexts = [];
	nodes = [];
	load = () => Promise.resolve();
	for (const name of globals) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
	// Gesture.unlock listens on the document while a context is suspended.
	const values = { AudioContext: FakeContext, AudioWorkletNode: FakeNode, document: new EventTarget() };
	for (const name of globals) Object.defineProperty(globalThis, name, { configurable: true, value: values[name] });
});

afterEach(() => {
	for (const name of globals) {
		const original = originals.get(name);
		if (original) Object.defineProperty(globalThis, name, original);
		else Reflect.deleteProperty(globalThis, name);
	}
});

// Let messages cross the ports and the effects they wake settle.
async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const SHAPE: GraphShape = { sampleRate: 44_100, channels: 1 };

function connect() {
	const channel = new MessageChannel();
	const host = new Host(channel.port1);
	const remote = new RemoteGraph(channel.port2);
	return {
		host,
		remote,
		close: () => {
			remote.close();
			host.close();
			channel.port1.close();
			channel.port2.close();
		},
	};
}

describe("Host", () => {
	it("builds the worklet a remote opens and hands it the worklet's port", async () => {
		const { host, remote, close } = connect();
		try {
			const abort = new AbortController();
			const opened = await remote.open(SHAPE, abort.signal);
			if (!opened) throw new Error("not opened");

			const [context] = contexts;
			const [node] = nodes;
			expect(context.sampleRate).toBe(44_100);
			expect(node.options).toEqual({ channelCount: 1, channelCountMode: "explicit", outputChannelCount: [1] });
			expect(host.out.context.peek()).toBe(context as unknown as AudioContext);
			expect(host.out.root.peek()).toBe(node as unknown as AudioNode);

			// The remote now talks to the processor directly, without passing through the host.
			const received = new Promise((resolve) => {
				node.processor.onmessage = ({ data }) => resolve(data);
			});
			opened.port.postMessage({ type: "reset", epoch: 1 });
			expect(await received).toEqual({ type: "reset", epoch: 1 });

			abort.abort();
			await settle();
			expect(context.calls.close).toBe(1);
			expect(node.disconnected).toBe(1);
			expect(host.out.context.peek()).toBeUndefined();
			expect(host.out.root.peek()).toBeUndefined();
		} finally {
			close();
		}
	});

	it("suspends an idle context and starts a playing one from a gesture", async () => {
		const { remote, close } = connect();
		try {
			// A report from before the graph opens applies to the context built for it.
			remote.playback("idle");
			await remote.open(SHAPE, new AbortController().signal);
			await settle();
			const [context] = contexts;
			expect(context.calls.suspend).toBe(1);
			expect(context.state).toBe("suspended");

			remote.playback("hold");
			await settle();
			expect(context.calls).toEqual({ suspend: 1, resume: 0, close: 0 });

			remote.playback("play");
			await settle();
			expect(context.calls.resume).toBe(1);
			expect(context.state).toBe("running");
		} finally {
			close();
		}
	});

	it("closes a graph abandoned before the host answers and builds no worklet for it", async () => {
		let loaded = () => {};
		load = () =>
			new Promise((resolve) => {
				loaded = resolve;
			});
		const { host, remote, close } = connect();
		try {
			const abort = new AbortController();
			const pending = remote.open(SHAPE, abort.signal);
			await settle();
			const [context] = contexts;
			expect(host.out.context.peek()).toBe(context as unknown as AudioContext);

			abort.abort();
			expect(await pending).toBeUndefined();
			await settle();
			expect(context.calls.close).toBe(1);
			expect(host.out.context.peek()).toBeUndefined();

			loaded();
			await settle();
			expect(nodes).toHaveLength(0);
		} finally {
			close();
		}
	});

	it("answers a worklet that fails to load, so the remote stops waiting", async () => {
		load = () => Promise.reject(new Error("refused"));
		const { remote, close } = connect();
		try {
			expect(await remote.open(SHAPE, new AbortController().signal)).toBeUndefined();
			expect(nodes).toHaveLength(0);
		} finally {
			close();
		}
	});

	it("keeps the newest graph's outputs when an older one closes after it opened", async () => {
		const { host, remote, close } = connect();
		try {
			const older = new AbortController();
			await remote.open(SHAPE, older.signal);
			await remote.open({ sampleRate: 48_000, channels: 2 }, new AbortController().signal);
			const [, newer] = contexts;

			older.abort();
			await settle();
			expect(contexts[0].calls.close).toBe(1);
			expect(host.out.context.peek()).toBe(newer as unknown as AudioContext);
			expect(host.out.root.peek()).toBe(nodes[1] as unknown as AudioNode);
		} finally {
			close();
		}
	});

	it("closes every graph when it closes", async () => {
		const { host, remote, close } = connect();
		try {
			await remote.open(SHAPE, new AbortController().signal);
			host.close();
			expect(contexts[0].calls.close).toBe(1);
			expect(host.out.context.peek()).toBeUndefined();
		} finally {
			close();
		}
	});
});
