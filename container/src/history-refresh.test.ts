import { describe, expect, test } from "bun:test";
import type { PersistentCache } from "./cache";
import type { Database } from "./database";
import type { AppConfig } from "./config";
import { UtxoClient } from "./utxo";
import { HistoryClient } from "./history";
import { createApp } from "./http";
import { openApiDocument } from "./openapi";
const LTC = "bip122:12a765e31ffd4059bada1e25190f6e98/slip44:2";
const ETH = "eip155:1/slip44:60", address = "0x1111111111111111111111111111111111111111";
const txid = "a".repeat(64);
function fixture() {
 const values = new Map<string, unknown>();
 let staleReads = 0, calls = 0, confirmations = 0, offline = false;
 const cache: PersistentCache = {
  getFresh: async <T>(namespace: string, key: string) => (values.get(`${namespace}:${key}`) as T) ?? null,
  getStale: async <T>(namespace: string, key: string) => { staleReads++; return (values.get(`${namespace}:${key}`) as T) ?? null; },
  set: async (namespace, key, value) => { values.set(`${namespace}:${key}`, value); },
  runExclusive: async (_key, task) => task(),
 };
 const utxo = new UtxoClient({ apiKey: "mock", cache, fetch: (async input => {
  calls++; expect(String(input)).toContain("details=txs");
  return offline ? Response.json({ error: "upstream unavailable" }, { status: 503 }) : Response.json({ transactions: [{
   txid, confirmations, blockHeight: confirmations ? 3206873 : 0, blockTime: 1793730000,
   value: "3673094", fees: "1000", vin: [{ isOwn: true, addresses: ["source-fixture"], value: "3674094" }], vout: [{ addresses: ["recipient-fixture"], value: "3673094" }],
  }] });
 }) as typeof fetch });
 const history = new HistoryClient({ utxo, zerion: { getTransactions: async () => [] } });
 const database = { authenticate: async () => ({ id: "test-client", username: "fixture" }) } as unknown as Database;
 const app = createApp({ config: {} as AppConfig, database, history });
 return {
  calls: () => calls, staleReads: () => staleReads,
  confirm: () => { confirmations = 3; }, offline: () => { offline = true; },
  read: (query = "", mixed = false) => app.fetch(new Request(`http://gateway.test/api/v1/tx/history${query}`, {
   method: "POST", headers: { Authorization: "test", "Content-Type": "application/json" },
   body: JSON.stringify({ queries: [{ caip: LTC, pubkey: "Mtub-public-fixture" }, ...(mixed ? [{ caip: ETH, pubkey: address }] : [])] }),
  })),
 };
}
describe("forced UTXO history refresh", () => {
 test("observes a new confirmation through HTTP despite a warm pending history cache", async () => {
  const f = fixture();
  const pending: any = await (await f.read()).json();
  expect(pending.histories[0].transactions[0]).toMatchObject({ txid, status: "pending", confirmations: 0 });
  f.confirm();
  const cached: any = await (await f.read("?forceRefresh=false")).json();
  expect(cached.histories[0].transactions[0].status).toBe("pending"); expect(f.calls()).toBe(1);
  const refreshed: any = await (await f.read("?forceRefresh=true")).json();
  expect(refreshed.histories[0]).toMatchObject({ fresh: true, transactions: [{ txid, status: "confirmed", confirmations: 3, blockHeight: 3206873 }] });
  expect(f.calls()).toBe(2);
  const after: any = await (await f.read()).json();
  expect(after.histories[0].transactions[0].status).toBe("confirmed"); expect(f.calls()).toBe(2);
 });
 test("rejects malformed refresh flags without starting another provider read", async () => {
  const f = fixture();
  for (const raw of ["1", "TRUE", "garbage"]) expect((await f.read(`?forceRefresh=${raw}`)).status).toBe(400);
  expect(f.calls()).toBe(0);
 });
 test("forced failures omit cached history rather than labeling stale confirmations fresh", async () => {
  const f = fixture(); await f.read(); f.offline();
  const failed = await f.read("?forceRefresh=true"), body: any = await failed.json();
  expect(failed.status).toBe(502); expect(body.histories).toBeUndefined(); expect(body.error.code).toBe("utxo_error");
  const partial: any = await (await f.read("?forceRefresh=true", true)).json();
  expect(partial.histories[0]).toMatchObject({ fresh: false, error: { status: 502 } });
  expect(partial.histories[0].transactions).toBeUndefined();
  expect(partial.histories[1]).toMatchObject({ fresh: true, transactions: [] });
  expect(f.staleReads()).toBe(0); expect(f.calls()).toBe(3);
 });
 test("advertises a Boolean forceRefresh query for generated Pioneer clients", () => {
  const spec: any = openApiDocument("https://gateway.test/spec/swagger.json");
  expect(spec.paths["/tx/history"].post.parameters).toContainEqual(expect.objectContaining({ name: "forceRefresh", in: "query", schema: { type: "boolean" } }));
 });
});
