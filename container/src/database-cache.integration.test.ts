import { afterAll, beforeAll, expect, test } from "bun:test";
import { createDatabase, type Database } from "./database";
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
