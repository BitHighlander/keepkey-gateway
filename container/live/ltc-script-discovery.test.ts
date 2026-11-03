import { describe, expect, test } from "bun:test";
import { base58check, bech32 } from "@scure/base";
import { createHash } from "node:crypto";
import { assertLtcScriptDiscovery, checkLtcScriptDiscovery, LTC_SCRIPT_FIXTURES } from "./ltc-script-discovery";
const H = 0x80000000;
const codec = base58check(value => new Uint8Array(createHash("sha256").update(value).digest()));
function responseFor(fixture: typeof LTC_SCRIPT_FIXTURES[number]): any {
 const address = fixture.addressClass === "ltc1q" ? bech32.encode("ltc", [0, ...bech32.toWords(new Uint8Array(20).fill(7))])
  : codec.encode(new Uint8Array([fixture.addressClass === "M" ? 50 : 48, ...new Uint8Array(20).fill(7)]));
 return { balance: "0", unconfirmedBalance: "0", tokens: [0, 1].map(branch => ({ type: "XPUBAddress", name: address, path: `m/${fixture.purpose}'/2'/0'/${branch}/0` })) };
}
describe("Litecoin discovery deployment gate", () => {
 test("checks script class and receive/change paths for all three public account formats", () => {
  expect(LTC_SCRIPT_FIXTURES.map(f => f.publicKey.slice(0, 4))).toEqual(["Ltub", "Mtub", "zpub"]);
  for (const fixture of LTC_SCRIPT_FIXTURES) {
   expect(assertLtcScriptDiscovery(fixture, responseFor(fixture))).toMatchObject({ purpose: fixture.purpose, addressClass: fixture.addressClass, derivedTokens: 2 });
   const body = responseFor(fixture); body.tokens.forEach((token: any, branch: number) => { token.path = [H + fixture.purpose, H + 2, H, branch, 0]; });
   expect(assertLtcScriptDiscovery(fixture, { data: body }).derivedTokens).toBe(2);
   const alternate = responseFor(fixture); alternate.tokens.forEach((token: any) => { token.path = token.path.replaceAll("'", "h"); });
   expect(assertLtcScriptDiscovery(fixture, alternate).derivedTokens).toBe(2);
  }
 });
 test("rejects a successful zero response using the wrong wrapped SegWit derivation", () => {
  const wrapped = LTC_SCRIPT_FIXTURES[1];
  expect(() => assertLtcScriptDiscovery(wrapped, responseFor(LTC_SCRIPT_FIXTURES[0]))).toThrow("address class");
  const b = responseFor(wrapped); b.tokens[0].path = "m/44'/2'/0'/0/0";
  expect(() => assertLtcScriptDiscovery(wrapped, b)).toThrow("path");
 });
 test("rejects missing tokens, wrong coin/account, invalid checksums and omitted branches", () => {
  const fixture = LTC_SCRIPT_FIXTURES[2];
  for (const mutate of [
   (b:any)=>{delete b.tokens},(b:any)=>{b.tokens=[]},
   (b:any)=>{b.tokens[0].path="m/84'/0'/0'/0/0"},(b:any)=>{b.tokens[0].path="m/84'/2'/1'/0/0"},
   (b:any)=>{b.tokens[0].path="m/84'/2'/0'/0/0'"},(b:any)=>{b.tokens[0].path="m/84'/2'/0'/2/0"},
   (b:any)=>{b.tokens[1].path="m/84'/2'/0'/0/1"},(b:any)=>{b.tokens[0].name += "q"},
  ]) { const b=responseFor(fixture);mutate(b);expect(()=>assertLtcScriptDiscovery(fixture,b)).toThrow(); }
 });
 test("authenticates each read, evaluates every fixture and redacts registration and provider responses", async () => {
  let auth = "", reads = 0;
  const report = await checkLtcScriptDiscovery("https://fixture.invalid", (async (input, init) => {
   const url = String(input);
   if (url.endsWith("/user/register")) {
    auth = new Headers(init?.headers).get("Authorization") || "";
    expect(JSON.parse(String(init?.body)).queryKey).toBe(auth);
    return Response.json({ success: true, apiKey: "registration-secret" });
   }
   expect(new Headers(init?.headers).get("Authorization")).toBe(auth);
   const fixture = LTC_SCRIPT_FIXTURES[reads++]; expect(url.endsWith(fixture.publicKey)).toBe(true);
   return fixture.purpose === 49 ? Response.json({ error: "upstream-secret-raw-body" }, { status: 502 }) : Response.json(responseFor(fixture));
  }) as typeof fetch);
  expect(reads).toBe(3); expect(report.success).toBe(false);
  expect((report.observations as any[]).map(row => row.success)).toEqual([true, false, true]);
  expect(JSON.stringify(report)).not.toContain(auth);
  expect(JSON.stringify(report)).not.toContain("registration-secret");
  expect(JSON.stringify(report)).not.toContain("upstream-secret-raw-body");
  expect(JSON.stringify(report)).not.toContain(LTC_SCRIPT_FIXTURES[0].publicKey);
 });
 test("passes only when each live discovery response proves its script and path", async () => {
  let reads=0;
  const report = await checkLtcScriptDiscovery("https://fixture.invalid", (async input => String(input).endsWith("/user/register")
   ? Response.json({success:true}) : Response.json(responseFor(LTC_SCRIPT_FIXTURES[reads++]))) as typeof fetch);
  expect(report.success).toBe(true); expect(reads).toBe(3);
 });
});
