import { expect, test } from "bun:test";
import { Group, Time, Track, Varint } from "@moq/net";
import { Consumer } from "./consumer.ts";
import { Format as LegacyFormat } from "./legacy.ts";

const SEAL = 0x53;

function legacyFrame(timestamp: Time.Micro, payload: Uint8Array): Uint8Array {
	const ts = Varint.encode(timestamp);
	const data = new Uint8Array(ts.byteLength + payload.byteLength);
	data.set(ts, 0);
	data.set(payload, ts.byteLength);
	return data;
}

function writeGroup(track: Track.Producer, sequence: number, frames: [Time.Micro, Uint8Array][]) {
	const group = new Group.Producer(sequence);
	for (const [ts, payload] of frames) {
		group.writeFrame({ payload: legacyFrame(ts, payload), timestamp: Time.Timestamp.fromMicros(ts) });
	}
	group.close();
	track.writeGroup(group);
}

async function drain(consumer: Consumer): Promise<Uint8Array[]> {
	const payloads: Uint8Array[] = [];
	for (;;) {
		const next = await Promise.race([
			consumer.next(),
			new Promise<null>((resolve) => setTimeout(() => resolve(null), 200)),
		]);
		if (!next) break;
		if (next.kind === "frame") payloads.push(next.frame.payload);
	}
	return payloads;
}

const sealed = new Uint8Array([SEAL, 0xde, 0xad]);

test("decrypt unseals each frame and is told its track, group and object", async () => {
	const track = new Track.Producer("cam");
	const seen: { track: string; group: number; object: number }[] = [];
	const consumer = new Consumer(track.subscribe({ maxDelay: Time.Milli(30_000) }), {
		format: new LegacyFormat("data"),
		maxDelay: Time.Milli(30_000),
		decrypt: async (payload, ctx) => {
			seen.push(ctx);
			expect(payload[0]).toBe(SEAL);
			return payload.subarray(1);
		},
	});

	writeGroup(track, 0, [
		[0 as Time.Micro, sealed],
		[33_000 as Time.Micro, sealed],
	]);
	writeGroup(track, 1, [[66_000 as Time.Micro, sealed]]);
	track.close();

	const payloads = await drain(consumer);
	consumer.close();

	expect(payloads.map((payload) => [...payload])).toEqual([
		[0xde, 0xad],
		[0xde, 0xad],
		[0xde, 0xad],
	]);
	seen.sort((a, b) => a.group - b.group || a.object - b.object);
	expect(seen).toEqual([
		{ track: "cam", group: 0, object: 0 },
		{ track: "cam", group: 0, object: 1 },
		{ track: "cam", group: 1, object: 0 },
	]);
});

test("an end marker is never handed to decrypt", async () => {
	const track = new Track.Producer("cam");
	let calls = 0;
	const consumer = new Consumer(track.subscribe({ maxDelay: Time.Milli(30_000) }), {
		format: new LegacyFormat("video"),
		maxDelay: Time.Milli(30_000),
		decrypt: async (payload) => {
			calls += 1;
			return payload.subarray(1);
		},
	});

	writeGroup(track, 0, [
		[0 as Time.Micro, sealed],
		[33_000 as Time.Micro, new Uint8Array()],
	]);
	track.close();

	await drain(consumer);
	consumer.close();

	expect(calls).toBe(1);
});
