import { expect, test } from "bun:test";
import { allowsWebTransport } from "./connect.ts";

const FIREFOX = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:156.0) Gecko/20100101 Firefox/156.0";
const CHROME =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

test("Firefox takes WebSocket unless the connection forces WebTransport", () => {
	expect(allowsWebTransport(FIREFOX)).toBeFalse();
	expect(allowsWebTransport(FIREFOX, {})).toBeFalse();
	expect(allowsWebTransport(FIREFOX, { force: true })).toBeTrue();
});

test("every other browser keeps WebTransport", () => {
	expect(allowsWebTransport(CHROME)).toBeTrue();
	expect(allowsWebTransport(CHROME, { force: false })).toBeTrue();
	expect(allowsWebTransport("")).toBeTrue();
});
