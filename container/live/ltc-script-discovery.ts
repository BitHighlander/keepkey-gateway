/** Deployment gate for Litecoin account discovery. Only fixed public account
 * xpubs are included; no private keys, recovery phrases or signing are used.
 * Usage: bun container/live/ltc-script-discovery.ts https://oracles.cc
 */
import { base58check, bech32 } from "@scure/base";
import { createHash } from "node:crypto";

const codec = base58check(value => new Uint8Array(createHash("sha256").update(value).digest()));
const H = 0x80000000;
const NETWORK = "bip122:12a765e31ffd4059bada1e25190f6e98";
const publicAccounts = {
  44: "xpub6DVXxJHFX5cA9KhKfnpRnDVHEbnq735Ewee42KTqvGZZEFHqbAU7zbWe6JMwZwQrfUeqZkQy2H9JYAndbDR5b6ma4CTzcUc3eGWcVvm41wn",
  49: "xpub6CqqDGxsYHh9WxzG73PdYH7fwJQge9efikLvWX4F9uXYbQgveYK9kiJbWX2Ktqez97a13fN5HoHkcrbAUqdx349iZaaMFwLYgUBMdSWXx28",
  84: "xpub6Ct1t8hutRATXavSbigcSUJdmU3vQsAV88axNtfEYXUfZkPm2pCh7bhAGiDLQLzJeAwNVKACwVkRxw8gwe7E2YEKpXnkKTj2g22BdXU6jRP",
};
function remapPublicKey(xpub: string, version: number): string {
  const payload = codec.decode(xpub);
  if (payload.length !== 78 || payload[45] !== 2 && payload[45] !== 3) throw new Error("Fixture must be a compressed extended public key");
  new DataView(payload.buffer, payload.byteOffset, payload.length).setUint32(0, version);
  return codec.encode(payload);
}
export const LTC_SCRIPT_FIXTURES = [
  { name: "Litecoin legacy", purpose: 44, addressClass: "L", publicKey: remapPublicKey(publicAccounts[44], 0x019da462) },
  { name: "Litecoin wrapped SegWit", purpose: 49, addressClass: "M", publicKey: remapPublicKey(publicAccounts[49], 0x01b26ef6) },
  { name: "Litecoin native SegWit", purpose: 84, addressClass: "ltc1q", publicKey: remapPublicKey(publicAccounts[84], 0x04b24746) },
] as const;
type Fixture = typeof LTC_SCRIPT_FIXTURES[number];

function parsePath(raw: unknown): number[] | null {
  if (Array.isArray(raw)) return raw.every(part => Number.isInteger(part) && part >= 0 && part <= 0xffffffff) ? raw : null;
  if (typeof raw !== "string") return null;
  const parts = raw.replace(/^m\//, "").split("/");
  if (!parts.length) return null;
  const path: number[] = [];
  for (const part of parts) {
    const match = /^(0|[1-9][0-9]*)(['hH]?)$/.exec(part);
    if (!match || Number(match[1]) >= H) return null;
    path.push(Number(match[1]) + (match[2] ? H : 0));
  }
  return path;
}
function addressMatches(address: unknown, fixture: Fixture): boolean {
  if (typeof address !== "string" || !address.startsWith(fixture.addressClass)) return false;
  try {
    if (fixture.addressClass === "ltc1q") {
      const decoded = bech32.decode(address as `${string}1${string}`);
      return decoded.prefix === "ltc" && decoded.words[0] === 0 && bech32.fromWords(decoded.words.slice(1)).length === 20;
    }
    const bytes = codec.decode(address);
    return bytes.length === 21 && bytes[0] === (fixture.addressClass === "M" ? 50 : 48);
  } catch { return false; }
}

/** A successful HTTP response with a zero balance must not hide the wrong
 * derivation scheme. Validate every derived token, including both branches. */
export function assertLtcScriptDiscovery(fixture: Fixture, payload: any): { addressClass: string; purpose: number; derivedTokens: number } {
  const body = payload?.data?.data || payload?.data || payload;
  if (!body || !Array.isArray(body.tokens) || body.tokens.length < 2) throw new Error("Missing derived Litecoin address tokens");
  const branches = new Set<number>();
  for (const token of body.tokens) {
    if (!addressMatches(token?.name, fixture)) throw new Error("Derived Litecoin address class does not match the requested account");
    const path = parsePath(token?.path);
    if (!path || path.length !== 5 || path[0] !== H + fixture.purpose || path[1] !== H + 2 || path[2] !== H
      || path[3] > 1 || path[4] >= H) throw new Error("Derived Litecoin path does not match the requested account");
    branches.add(path[3]);
  }
  if (!branches.has(0) || !branches.has(1)) throw new Error("Litecoin discovery omitted a receive or change branch");
  return { addressClass: fixture.addressClass, purpose: fixture.purpose, derivedTokens: body.tokens.length };
}

export async function checkLtcScriptDiscovery(origin: string, fetcher: typeof fetch = fetch): Promise<Record<string, unknown>> {
  const queryKey = `vault:ltc-discovery:${crypto.randomUUID()}:${crypto.randomUUID()}`;
  const base = origin.replace(/\/$/, "");
  const registration = await fetcher(`${base}/api/v1/user/register`, {
    method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: queryKey },
    body: JSON.stringify({ username: `ltc-discovery-${crypto.randomUUID()}`, queryKey }), signal: AbortSignal.timeout(30_000),
  });
  // Registration can return API credentials. Never log or retain its body.
  await registration.body?.cancel();
  if (registration.status !== 200) throw new Error(`Fixture registration failed (HTTP ${registration.status})`);
  const observations: Array<Record<string, unknown>> = [];
  for (const fixture of LTC_SCRIPT_FIXTURES) {
    const started = Date.now();
    try {
      const result = await fetcher(`${base}/api/v1/utxo/pubkey-info/${NETWORK}/${encodeURIComponent(fixture.publicKey)}`, {
        headers: { Accept: "application/json", Authorization: queryKey }, signal: AbortSignal.timeout(30_000),
      });
      if (result.status !== 200) {
        await result.body?.cancel();
        throw new Error(`Litecoin discovery failed (HTTP ${result.status})`);
      }
      const verified = assertLtcScriptDiscovery(fixture, await result.json());
      observations.push({ case: fixture.name, success: true, ...verified, elapsedMs: Date.now() - started });
    } catch {
      // Upstream errors can contain URLs, keys or raw response bodies. Reports
      // retain the failed case without echoing provider-controlled details.
      observations.push({ case: fixture.name, success: false, error: "Litecoin script discovery did not pass validation", elapsedMs: Date.now() - started });
    }
  }
  return { origin, checkedAt: new Date().toISOString(), publicFixturesOnly: true, signed: false, broadcast: false,
    success: observations.every(row => row.success), observations };
}

if (import.meta.main) {
  const origin = process.argv[2];
  if (!origin || !/^https?:\/\//.test(origin)) throw new Error("Provide the gateway HTTP(S) origin");
  const report = await checkLtcScriptDiscovery(origin);
  console.log(JSON.stringify(report, null, 2));
  if (!report.success) process.exitCode = 1;
}
