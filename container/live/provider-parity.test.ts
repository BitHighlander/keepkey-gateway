import { describe, expect, test } from "bun:test";
import { assertProviderQuotes, checkProviderParity, providerFixtures } from "./provider-parity";

const fixture = providerFixtures[0];
const good = () => [{ integration: "nearIntents", quote: { amountOut: "0.2", amountOutMin: "0.19", txs: [{
	type: "EVM", chain: "eip155:1", txParams: { to: "0x1111111111111111111111111111111111111111", data: "0x", value: "12345678912345678" },
}] } }];

describe("provider deployment gate", () => {
	test("requires executable quotes and the intended direct provider", () => {
		expect(assertProviderQuotes(fixture, good())).toEqual(["nearIntents"]);
		for (const corrupt of [
			() => [],
			() => { const q = good(); q[0].integration = "shapeshift"; return q; },
			() => { const q = good(); q[0].quote.txs = []; return q; },
			() => { const q = good(); q[0].quote.txs[0].chain = "eip155:10"; return q; },
			() => { const q = good(); q[0].quote.txs[0].txParams.value = "0"; return q; },
		]) expect(() => assertProviderQuotes(fixture, corrupt())).toThrow();
	});
	test("fails on a memo even when another returned route is memoless", () => {
		const q = good();
		(q[0].quote.txs[0].txParams as any).memo = "=:LTC.LTC:recipient";
		expect(() => assertProviderQuotes({ ...fixture, memoless: true }, [...good(), ...q])).toThrow("memo");
	});
	test("records provider failures and continues the complete matrix", async () => {
		let quotes = 0;
		const report = await checkProviderParity("https://fixture.invalid", (async url => {
			if (String(url).endsWith("/user/register")) return Response.json({});
			quotes++;
			return Response.json({ error: { message: "provider unavailable" } }, { status: 503 });
		}) as typeof fetch);
		expect(quotes).toBe(providerFixtures.length);
		expect(report.success).toBe(false);
		expect((report.observations as any[]).every(row => row.error.includes("HTTP 503"))).toBe(true);
	});
});
