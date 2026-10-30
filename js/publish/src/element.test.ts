import { expect, mock, spyOn, test } from "bun:test";

mock.module("./audio/capture-worklet.ts?worklet", () => ({ default: async () => "blob:capture" }));

mock.module("./video/capture-worker.ts?worklet", () => ({ default: async () => "blob:worker" }));

test("an invalid URL attribute warns and clears the publish URL", async () => {
	const originalElement = globalThis.HTMLElement;
	const originalRegistry = globalThis.customElements;
	const registry = new Map<string, CustomElementConstructor>();
	globalThis.HTMLElement = class {} as unknown as typeof HTMLElement;
	globalThis.customElements = {
		define: (name: string, ctor: CustomElementConstructor) => {
			registry.set(name, ctor);
		},
		get: (name: string) => registry.get(name),
	} as unknown as CustomElementRegistry;

	const set = mock(() => {});
	const warn = spyOn(console, "warn").mockImplementation(() => {});
	try {
		const { default: Element } = await import("./element");
		expect(() =>
			Element.prototype.attributeChangedCallback.call({ connection: { url: { set } } }, "url", null, "http://["),
		).not.toThrow();
		expect(set).toHaveBeenCalledWith(undefined);
		expect(warn).toHaveBeenCalledTimes(1);
	} finally {
		warn.mockRestore();
		globalThis.HTMLElement = originalElement;
		globalThis.customElements = originalRegistry;
	}
});

test("the encrypt property reaches the audio and video encoders", async () => {
	const originalElement = globalThis.HTMLElement;
	const originalRegistry = globalThis.customElements;
	const originalObserver = globalThis.MutationObserver;
	const originalVideo = globalThis.HTMLVideoElement;
	const registry = new Map<string, CustomElementConstructor>();
	globalThis.HTMLElement = class {
		querySelector() {
			return null;
		}
	} as unknown as typeof HTMLElement;
	globalThis.MutationObserver = class {
		observe() {}
		disconnect() {}
	} as unknown as typeof MutationObserver;
	globalThis.HTMLVideoElement = class {} as unknown as typeof HTMLVideoElement;
	globalThis.customElements = {
		define: (name: string, ctor: CustomElementConstructor) => {
			registry.set(name, ctor);
		},
		get: (name: string) => registry.get(name),
	} as unknown as CustomElementRegistry;

	try {
		const { default: Element } = await import("./element");
		const base = Object.getPrototypeOf(Element.prototype) as { querySelector?: () => null };
		base.querySelector ??= () => null;
		const element = new Element();
		const encrypt = (payload: Uint8Array) => payload;
		element.encrypt = encrypt;
		expect(element.encrypt).toBe(encrypt);
		expect(element.video.in.encrypt.peek()).toBe(encrypt);
		expect(element.audio.in.encrypt.peek()).toBe(encrypt);
		element.encrypt = undefined;
		expect(element.video.in.encrypt.peek()).toBeUndefined();
		expect(element.audio.in.encrypt.peek()).toBeUndefined();
		element.signals.close();
	} finally {
		globalThis.HTMLElement = originalElement;
		globalThis.customElements = originalRegistry;
		globalThis.MutationObserver = originalObserver;
		globalThis.HTMLVideoElement = originalVideo;
	}
});
