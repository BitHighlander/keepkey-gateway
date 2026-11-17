import { afterAll, beforeAll, expect, test } from "bun:test";
import { createDatabase, type Database } from "./database";
import { cacheObservation } from "./cache";
import { DemandCache } from "./demand-cache";
import { loadConfig } from "./config";

// Use only a dedicated test database; never default to application credentials.
const url = process.env.CACHE_TEST_DATABASE_URL;
const integrationTest = url ? test : test.skip;
let database: Database;
const namespace = `pool-regression-${crypto.randomUUID()}`;

beforeAll(async () => {
	if (!url) return;
	database = createDatabase(loadConfig({ DATABASE_URL: url, DATABASE_MAX_CONNECTIONS: "1" }));
	await database.migrate();
});
afterAll(async () => { if (database) await database.close(); });

integrationTest("cold cache loads complete with a single database connection", async () => {
	const cache = new DemandCache(database);
	const values = await Promise.all(Array.from({ length: 8 }, (_, index) => cache.get({
		namespace, key: String(index), source: "test", freshForMs: 60_000, staleForMs: 60_000,
	}, async () => index)));
	expect(values).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
}, 3000);

integrationTest("nested cache locks reuse their connection and release after failure", async () => {
	await expect(database.runExclusive(`${namespace}:outer`, () => database.runExclusive(`${namespace}:inner`, async () => {
		await database.set(namespace, "nested", 42, 60_000, 60_000, "test");
		throw new Error("fixture failure");
	}))).rejects.toThrow("fixture failure");
	expect(await database.getFresh<number>(namespace, "nested")).toBe(42);
	await database.runExclusive(`${namespace}:outer`, async () => {
		expect(await database.getFresh<number>(namespace, "nested")).toBe(42);
	});
}, 3000);


integrationTest('persistent provenance survives another process and concurrent forced refreshes fetch once', async () => {
 const other = createDatabase(loadConfig({ DATABASE_URL: url!, DATABASE_MAX_CONNECTIONS: '1' }));
 try {
  const key = crypto.randomUUID();
  await database.set(namespace, key, {balance:'old'}, 60000, 120000, 'chain');
  const original = await database.getEntry!(namespace, key, 'fresh');
  const policy = {namespace,key,source:'chain',freshForMs:60000,staleForMs:120000};
  const read = await new DemandCache(other).get(policy, async () => { throw Error('warm cache must not load'); });
  expect(cacheObservation(read)?.fetchedAt).toBe(original!.fetchedAt);
  expect(cacheObservation(read)?.freshUntil).toBe(original!.freshUntil);
  let queued = 0, release!: () => void, calls = 0;
  const bothQueued = new Promise<void>(r => release = r);
  const wrap = (db: Database) => ({...db, runExclusive: async <T>(name: string, task: () => Promise<T>) => {
   if (++queued === 2) release();
   return db.runExclusive(name, task);
  }});
  const load = async () => { calls++; await bothQueued; return {balance:'new'}; };
  const values = await Promise.all([new DemandCache(wrap(database)).get(policy,load,{forceRefresh:true}),new DemandCache(wrap(other)).get(policy,load,{forceRefresh:true})]);
  expect(values.map(value => value.balance)).toEqual(['new','new']); expect(calls).toBe(1);
 } finally { await other.close(); }
}, 5000);
