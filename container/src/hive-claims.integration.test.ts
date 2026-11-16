import { afterAll, beforeAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { createDatabase, type Database } from "./database";
import { loadConfig } from "./config";

const url = process.env.HIVE_TEST_DATABASE_URL;
const integration = url ? test : test.skip;
let database: Database, other: Database, sql: SQL;
const clients: string[] = [];
const address = () => `0x${crypto.randomUUID().replaceAll("-", "").padEnd(40, "0")}`;
beforeAll(async () => {
	if (!url) return;
	if (!new URL(url).pathname.endsWith("_test")) throw new Error("A dedicated test database is required");
	const config = loadConfig({ DATABASE_URL: url, DATABASE_MAX_CONNECTIONS: "1" });
	database = createDatabase(config); other = createDatabase(config); sql = new SQL(url, { max: 1 });
	await database.migrate();
});
afterAll(async () => {
	if (!url) return;
	for (const id of clients) { await sql`DELETE FROM hive_onboarding_claims WHERE client_id = ${id}`; await sql`DELETE FROM api_clients WHERE id = ${id}`; }
	await database.close(); await other.close(); await sql.close();
});
async function client() {
	const row = await database.registerClient({ username: "hive-integration", queryKey: crypto.randomUUID() });
	clients.push(row.id); return row.id;
}

integration("claim intent and finalization reuse the sponsor lock's single database connection", async () => {
	const id = await client(), eth = address(), name = `hive-${crypto.randomUUID().slice(0, 8)}`, txid = "ab".repeat(20);
	await database.runExclusive("hive:sponsor-account-create", async () => {
		expect(await database.reserveHiveClaim(id, eth, name)).toBe(true);
		expect(await database.getHiveClaim(eth)).toEqual({ username: name, txid: null, status: "reserving" });
		await database.markHiveClaimSubmitted(eth, txid);
		await database.releaseHiveClaim(eth);
		expect(await database.getHiveClaim(eth)).toEqual({ username: name, txid, status: "reserving" });
		await database.completeHiveClaim(eth, txid);
		expect(await database.getHiveClaim(eth)).toEqual({ username: name, txid, status: "created" });
	});
}, 5000);

integration("pre-broadcast failures release reservations and allow retries", async () => {
	const id = await client(), eth = address(), name = `hive-${crypto.randomUUID().slice(0, 8)}`;
	expect(await database.reserveHiveClaim(id, eth, name)).toBe(true);
	await database.releaseHiveClaim(eth);
	expect(await database.getHiveClaim(eth)).toBeNull();
	expect(await database.reserveHiveClaim(id, eth, name)).toBe(true);
});

integration("concurrent sponsor locks enforce one claim per client across instances", async () => {
	const id = await client();
	const results = await Promise.all([database, other].map(instance => instance.runExclusive("hive:sponsor-account-create", () => instance.reserveHiveClaim(id, address(), `hive-${crypto.randomUUID().slice(0, 8)}`))));
	expect(results.filter(Boolean)).toHaveLength(1);
}, 5000);

integration("an intent cannot be replaced with another transaction id", async () => {
	const id = await client(), eth = address();
	await database.reserveHiveClaim(id, eth, `hive-${crypto.randomUUID().slice(0, 8)}`);
	await database.markHiveClaimSubmitted(eth, "cd".repeat(20));
	await expect(database.markHiveClaimSubmitted(eth, "ef".repeat(20))).rejects.toThrow("reservation is unavailable");
	expect((await database.getHiveClaim(eth))?.txid).toBe("cd".repeat(20));
});
