import { expect, test } from "bun:test";
import { type Micro, Milli } from "@moq/clock";
import { Track, Varint } from "@moq/net";
import { Consumer } from "./consumer.ts";
import { type FrameEncrypt, Format as LegacyFormat, Producer as LegacyProducer } from "./legacy.ts";

const SEAL = 0x53;

type Position = { track: string; group: number; object: number };

function sealer(seen: Position[], decline?: (payload: Uint8Array) => boolean): FrameEncrypt {
	return (payload, ctx) => {
		if (decline?.(payload)) return undefined;
		seen.push(ctx);
		const out = new Uint8Array(payload.byteLength + 1);
		out[0] = SEAL;
		out.set(payload, 1);
		return out;
	};
}

async function readGroup(subscriber: Track.Subscriber): Promise<{ sequence: number; frames: [number, number[]][] }> {
	const group = await subscriber.recvGroup();
	if (!group) throw new Error("expected a group");
	const frames: [number, number[]][] = [];
	for (;;) {
		const frame = await group.readFrame();
		if (!frame) break;
		const [timestamp, payload] = Varint.decode(frame.payload);
		frames.push([timestamp, [...payload]]);
	}
	return { sequence: group.sequence, frames };
}

async function drain(consumer: Consumer): Promise<number[][]> {
	const payloads: number[][] = [];
	for (;;) {
		const next = await Promise.race([
			consumer.next(),
			new Promise<null>((resolve) => setTimeout(() => resolve(null), 200)),
		]);
		if (!next) break;
		if (next.kind === "frame") payloads.push([...next.frame.payload]);
	}
	return payloads;
}

function byPosition(a: Position, b: Position): number {
	return a.group - b.group || a.object - b.object;
}

test("encrypt seals each media payload after its timestamp and is told its track, group and object", async () => {
	const track = new Track.Producer("cam");
	const subscriber = track.subscribe({ maxDelay: Milli(30_000) });
	const seen: Position[] = [];
	const producer = new LegacyProducer(track, new LegacyFormat("video"), sealer(seen));
	producer.encode(new Uint8Array([0xde, 0xad]), 0 as Micro, true);
	producer.encode(new Uint8Array([0xbe, 0xef]), 10_000 as Micro, false);
	producer.encode(new Uint8Array([0xca, 0xfe]), 20_000 as Micro, true);
	producer.close();

	const first = await readGroup(subscriber);
	const second = await readGroup(subscriber);
	expect(first.frames).toEqual([
		[0, [SEAL, 0xde, 0xad]],
		[10_000, [SEAL, 0xbe, 0xef]],
		[20_000, []],
	]);
	expect(second.frames[0]).toEqual([20_000, [SEAL, 0xca, 0xfe]]);
	expect(second.frames.slice(1).every(([, payload]) => payload.length === 0)).toBe(true);
	expect(seen).toEqual([
		{ track: "cam", group: first.sequence, object: 0 },
		{ track: "cam", group: first.sequence, object: 1 },
		{ track: "cam", group: second.sequence, object: 0 },
	]);
});

test("what encrypt seals, the consumer's decrypt opens at the same track, group and object", async () => {
	const track = new Track.Producer("cam");
	const sealedAt: Position[] = [];
	const openedAt: Position[] = [];
	const consumer = new Consumer(track.subscribe({ maxDelay: Milli(30_000) }), {
		format: new LegacyFormat("video"),
		maxDelay: Milli(30_000),
		decrypt: async (payload, ctx) => {
			openedAt.push(ctx);
			expect(payload[0]).toBe(SEAL);
			return payload.subarray(1);
		},
	});
	const producer = new LegacyProducer(track, new LegacyFormat("video"), sealer(sealedAt));
	producer.encode(new Uint8Array([0xde, 0xad]), 0 as Micro, true);
	producer.encode(new Uint8Array([0xbe, 0xef]), 10_000 as Micro, false);
	producer.encode(new Uint8Array([0xca, 0xfe]), 20_000 as Micro, true);
	producer.close();

	const payloads = await drain(consumer);
	consumer.close();

	expect(payloads).toEqual([
		[0xde, 0xad],
		[0xbe, 0xef],
		[0xca, 0xfe],
	]);
	expect(openedAt.sort(byPosition)).toEqual(sealedAt.sort(byPosition));
});

test("a frame encrypt declines is dropped rather than written in the clear, and the next keeps the consumer's index", async () => {
	const track = new Track.Producer("cam");
	const subscriber = track.subscribe({ maxDelay: Milli(30_000) });
	const seen: Position[] = [];
	const producer = new LegacyProducer(
		track,
		new LegacyFormat("video"),
		sealer(seen, (payload) => payload[0] === 0xbe),
	);
	producer.encode(new Uint8Array([0xde, 0xad]), 0 as Micro, true);
	producer.encode(new Uint8Array([0xbe, 0xef]), 10_000 as Micro, false);
	producer.encode(new Uint8Array([0xca, 0xfe]), 20_000 as Micro, false);
	producer.close();

	const group = await readGroup(subscriber);
	const media = group.frames.filter(([, payload]) => payload.length > 0);
	expect(media).toEqual([
		[0, [SEAL, 0xde, 0xad]],
		[20_000, [SEAL, 0xca, 0xfe]],
	]);
	expect(group.frames.some(([, payload]) => payload[0] === 0xbe)).toBe(false);
	expect(seen).toEqual([
		{ track: "cam", group: group.sequence, object: 0 },
		{ track: "cam", group: group.sequence, object: 1 },
	]);
});

test("a discontinuity marker is never handed to encrypt", async () => {
	const track = new Track.Producer("cam");
	const subscriber = track.subscribe({ maxDelay: Milli(30_000) });
	const seen: Position[] = [];
	const producer = new LegacyProducer(track, new LegacyFormat("video"), sealer(seen));
	producer.encode(new Uint8Array([0xde, 0xad]), 0 as Micro, true);
	producer.discontinuity(40_000 as Micro);
	producer.close();

	await readGroup(subscriber);
	const marker = await readGroup(subscriber);
	expect(marker.frames).toEqual([[40_000, []]]);
	expect(seen).toHaveLength(1);
});

test("without encrypt, frames pass through in the clear as before", async () => {
	const track = new Track.Producer("cam");
	const subscriber = track.subscribe({ maxDelay: Milli(30_000) });
	const producer = new LegacyProducer(track, new LegacyFormat("video"));
	producer.encode(new Uint8Array([0xde, 0xad]), 0 as Micro, true);
	producer.close();

	const group = await readGroup(subscriber);
	expect(group.frames[0]).toEqual([0, [0xde, 0xad]]);
});
