import { createClient, type FetchLike } from "@sfly/client";
import { describe, expect, it } from "vitest";

const encoder = new TextEncoder();
const route = { method: "GET", path: "/events", kind: "stream" } as const;

const streamOf = (chunks: Uint8Array[]) =>
	new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});

const eventStream = (chunks: Uint8Array[]) =>
	new Response(streamOf(chunks), { headers: { "content-type": "text/event-stream" } });

async function received(chunks: Uint8Array[]): Promise<unknown[]> {
	const events: unknown[] = [];
	const fetchOnce: FetchLike = async () => eventStream(chunks);
	const client = createClient({ baseUrl: "http://sfly.test", fetch: fetchOnce });
	return new Promise((resolve, reject) => {
		const close = client.subscribe(
			route,
			undefined,
			{
				item: (data) => events.push(data),
				end: () => {
					close();
					resolve(events);
				},
			},
			{ onError: reject },
		);
	});
}

const END = "event: end\ndata: 0\n\n";

describe("事件流的行结束符和分块", () => {
	const stream = [
		": 注释\r\n",
		'event: item\r\ndata: {"a":\r\ndata: 1}\r\n\r\n',
		'event: item\rdata: {"b":2}\r\r',
		'event: item\ndata: {"c":3}\n\n',
		'event: item\r\ndata: {"d":4}\r\n\r\n',
		END,
	].join("");
	const bytes = encoder.encode(stream);
	const expected = [{ a: 1 }, { b: 2 }, { c: 3 }, { d: 4 }];

	it("在任何位置把响应体切成两块，收到的消息都和不切时一样（包括 \\r\\n 被切在 \\r 与 \\n 之间）", async () => {
		expect(await received([bytes])).toEqual(expected);
		for (let at = 1; at < bytes.length; at++) {
			const events = await received([bytes.slice(0, at), bytes.slice(at)]);
			const firstChunk = new TextDecoder().decode(bytes.slice(0, at));
			expect(events, `第一块是 ${JSON.stringify(firstChunk)}`).toEqual(expected);
		}
	});

	it("一个字节一块", async () => {
		const events = await received(Array.from(bytes, (byte) => Uint8Array.of(byte)));

		expect(events).toEqual(expected);
	});

	it("多字节字符被切开也不乱码", async () => {
		const text = `event: item\ndata: {"name":"飞行测试"}\n\n${END}`;
		const all = encoder.encode(text);
		const at = all.indexOf(encoder.encode("行")[0] as number) + 1;

		const events = await received([all.slice(0, at), all.slice(at)]);

		expect(events).toEqual([{ name: "飞行测试" }]);
	});

	it("流在最后一个 \\r 之后结束，这个 \\r 算空行，最后一条消息照常送出", async () => {
		const delivered: unknown[] = [];
		let reconnected: () => void = () => {};
		const reconnect = new Promise<void>((resolve) => {
			reconnected = resolve;
		});
		let calls = 0;
		const fetchTwice: FetchLike = async () => {
			if (++calls === 1)
				return eventStream([encoder.encode('event: item\rdata: {"last":true}\r\r')]);
			reconnected();
			return new Promise(() => {});
		};
		const client = createClient({ baseUrl: "http://sfly.test", fetch: fetchTwice });
		const close = client.subscribe(route, undefined, { item: (data) => delivered.push(data) });

		await reconnect;
		close();

		expect(delivered).toEqual([{ last: true }]);
	});
});
