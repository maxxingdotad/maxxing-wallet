import test from "node:test";
import assert from "node:assert/strict";
import { createStream } from "../src/stream";

const A = "eip155:8453:0x1111111111111111111111111111111111111111";
const B = "eip155:8453:0x2222222222222222222222222222222222222222";

function fakes() {
  const sockets: any[] = [];
  const open = (url: string) => {
    const socket: any = { url, readyState: 0, sent: [] as unknown[], closed: false, onopen: null, onclose: null, onmessage: null, onerror: null,
      send(data: string) { this.sent.push(JSON.parse(data)); }, close() { this.closed = true; } };
    sockets.push(socket);
    return socket;
  };
  const pending: { fn: () => void; ms: number }[] = [];
  const timers = { set: ((fn: () => void, ms: number) => { pending.push({ fn, ms }); return pending.length as never; }) as never, clear: (() => {}) as never };
  const up = (socket: any) => { socket.readyState = 1; socket.onopen?.({}); };
  const say = (socket: any, message: unknown) => socket.onmessage?.({ data: JSON.stringify(message) });
  return { sockets, open, timers, pending, up, say };
}

test("one connection for every listener; each gets only its tokens", () => {
  const f = fakes();
  const stream = createStream("wss://api.test/v1/public/stream?app=app_1", f.open, f.timers);
  const seenA: string[] = [], seenB: string[] = [], trades: string[] = [];
  const stopA = stream.subscribe([A], { onPrice: p => seenA.push(p.priceUsd!), onTrades: id => trades.push(id) });
  stream.subscribe([A, B], { onPrice: p => seenB.push(`${p.id === A ? "A" : "B"}:${p.priceUsd}`) });
  assert.equal(f.sockets.length, 1);
  f.up(f.sockets[0]);
  assert.deepEqual(f.sockets[0].sent.at(-1), { op: "subscribe", tokens: [A, B] });
  f.say(f.sockets[0], { type: "price", id: A, priceUsd: "1.5" });
  f.say(f.sockets[0], { type: "price", id: B, priceUsd: "2" });
  f.say(f.sockets[0], { type: "trades", id: A });
  f.say(f.sockets[0], { type: "hello" });
  assert.deepEqual(seenA, ["1.5"]);
  assert.deepEqual(seenB, ["A:1.5", "B:2"]);
  assert.deepEqual(trades, [A]);
  stopA();
  assert.equal(f.sockets[0].sent.length, 1, "A is still wanted by the second listener");
});

test("reconnects with growing waits and subscribes again; closes when nobody listens", () => {
  const f = fakes();
  const stream = createStream("wss://x", f.open, f.timers);
  const status: string[] = [];
  const stop = stream.subscribe([A], { onStatus: s => status.push(s) });
  f.up(f.sockets[0]);
  f.sockets[0].readyState = 3; f.sockets[0].onclose?.({});
  assert.deepEqual(status, ["live", "offline"]);
  assert.equal(f.pending[0]!.ms, 1000);
  f.pending.shift()!.fn();
  f.sockets[1].readyState = 3; f.sockets[1].onclose?.({});
  assert.equal(f.pending[0]!.ms, 2000, "the second wait is longer");
  f.pending.shift()!.fn();
  f.up(f.sockets[2]);
  assert.deepEqual(f.sockets[2].sent, [{ op: "subscribe", tokens: [A] }]);
  assert.equal(status.at(-1), "live");
  stop();
  assert.equal(f.sockets[2].closed, true);
  assert.equal(f.sockets[2].sent.at(-1).op, "unsubscribe");
});
