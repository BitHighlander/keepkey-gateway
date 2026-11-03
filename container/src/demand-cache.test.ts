import { describe, expect, test } from "bun:test";
import { DemandCache, type DemandCachePolicy } from "./demand-cache";
import type { PersistentCache } from "./cache";
const policy: DemandCachePolicy = { namespace: "balance", key: "public-fixture", freshForMs: 60_000, staleForMs: 60_000, source: "test" };
class CacheFixture implements PersistentCache {
 fresh: unknown = null;
 stale: unknown = null;
 async getFresh<T>() { return this.fresh as T | null; }
 async getStale<T>() { return this.stale as T | null; }
 async set(_namespace: string, _key: string, value: unknown) { this.fresh = value; }
 async runExclusive<T>(_key: string, task: () => Promise<T>): Promise<T> { return task(); }
}
describe("explicit balance refresh", () => {
 test("bypasses fresh memory and persistent zeros and replaces both with the latest read", async () => {
  const persisted = new CacheFixture(); persisted.fresh = "0";
  const cache = new DemandCache(persisted); let calls = 0;
  const load = async () => { calls++; return "3039975"; };
  expect(await cache.get(policy, load)).toBe("0"); expect(calls).toBe(0);
  expect(await cache.get(policy, load, { forceRefresh: true })).toBe("3039975"); expect(calls).toBe(1);
  expect(await cache.get(policy, load)).toBe("3039975"); expect(persisted.fresh).toBe("3039975");
 });
 test("never returns an old stale balance after a forced upstream failure", async () => {
  const persisted = new CacheFixture(); persisted.stale = "0";
  const cache = new DemandCache(persisted), fail = async () => { throw new Error("upstream unavailable"); };
  expect(await cache.get<string>(policy, fail)).toBe("0");
  await expect(cache.get<string>(policy, fail, { forceRefresh: true })).rejects.toThrow("upstream unavailable");
 });
 test("coalesces concurrent refreshes and makes new ordinary reads await the refresh", async () => {
  const persisted = new CacheFixture(); persisted.fresh = "0";
  const cache = new DemandCache(persisted); let calls = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const load = async () => { calls++; await gate; return "50"; };
  const first = cache.get(policy, load, { forceRefresh: true });
  const second = cache.get(policy, load, { forceRefresh: true });
  const ordinary = cache.get(policy, load);
  release(); expect(await Promise.all([first, second, ordinary])).toEqual(["50", "50", "50"]); expect(calls).toBe(1);
 });
 test("waits for an older in-flight read before fetching so it cannot overwrite the refreshed balance", async () => {
  const persisted = new CacheFixture(), cache = new DemandCache(persisted); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const older = cache.get(policy, async () => { await gate; return "0"; });
  const refresh = cache.get(policy, async () => "50", { forceRefresh: true });
  release(); expect(await older).toBe("0"); expect(await refresh).toBe("50");
  expect(await cache.get(policy, async () => "unreachable")).toBe("50"); expect(persisted.fresh).toBe("50");
 });
});
