/** Deterministic membership/delivery integration tests with fake history and
 * upstream signals. Passing these is not proof of a live funded payment. */
import { describe, expect, test } from 'bun:test';
import { RealtimeHub } from './realtime';
import type { WatchAddress } from './realtime-watch';
const ETH = 'eip155:1', SOL = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const A = { address: '0x1111111111111111111111111111111111111111', networkId: ETH };
const B = { address: '0x2222222222222222222222222222222222222222', networkId: ETH };
type Delivery = { event: string; data: Record<string, any> };
const tick = () => Bun.sleep(0);
function setup(history = async (body: any) => ({ histories: body.queries.map(() => ({ transactions: [] })) })) {
 const hub = new RealtimeHub({ getTransactionHistory: history } as any, 60_000);
 const changes: WatchAddress[][] = [], deliveries = new Map<string, Delivery[]>(), owners = new Map<string, string>();
 let closes = 0;
 hub.setUpstream({ replace: watches => changes.push(watches), covers: () => true, close: () => { closes++; } });
 const add = (client: string, id: string, watches: WatchAddress[], since?: number) => {
  const messages: Delivery[] = []; deliveries.set(id, messages); owners.set(id, client);
  hub.addSocket(client, id, (event, data) => messages.push({ event, data }));
  hub.subscribeSocket(client, id, watches, undefined, { since });
  return messages;
 };
 const clear = () => { for (const messages of deliveries.values()) messages.length = 0; };
 const close = () => { for (const [id, client] of owners) hub.removeSocket(client, id); };
 return { hub, add, clear, close, changes, get closes() { return closes; } };
}

describe('realtime lease membership', () => {
 test('routes upstream hints only to the watching client and never invents payment units', async () => {
  const h = setup();
  try {
   const one = h.add('one', 'one-socket', [A]), two = h.add('two', 'two-socket', [B]);
   await tick(); h.clear(); h.hub.upstreamChange(A, 'public-fixture-tx', true);
   expect(two).toHaveLength(0);
   expect(one.filter(message => message.event === 'tx:incoming')).toHaveLength(1);
   expect(one.filter(message => message.event === 'tx:confirmed')).toHaveLength(1);
   for (const message of one.filter(message => message.event.startsWith('tx:'))) {
    expect(message.data.address).toBe(A.address); expect(message.data.refreshHint).toBe(true);
    expect(message.data.eventId).toMatch(/^[0-9a-f]{64}$/);
    expect(message.data.value).toBeUndefined(); expect(message.data.caip).toBeUndefined();
    expect(message.data.amount).toBeUndefined(); expect(message.data.confirmations).toBeUndefined();
   }
  } finally { h.close(); }
 });

 test('rejects another client modifying a socket and ignores another client removing it', () => {
  const h = setup();
  try {
   h.add('owner', 'socket', [A]);
   expect(() => h.hub.subscribeSocket('intruder', 'socket', [B], undefined)).toThrow();
   expect(() => h.hub.unsubscribeSocket('intruder', 'socket')).toThrow();
   expect(() => h.hub.addSocket('intruder', 'socket', () => {})).toThrow();
   h.hub.removeSocket('intruder', 'socket'); expect(h.hub.activeAddressCount()).toBe(1);
  } finally { h.close(); }
 });

 test('replacement drops the old watch and an old in-flight history response cannot leak', async () => {
  const A={address:'LtcWatchA',networkId:'bip122:12a765e31ffd4059bada1e25190f6e98'},B={...A,address:'LtcWatchB'};
  let finishOld!: (value: any) => void, calls = 0;
  const h = setup(async body => {
   calls++;
   if (calls === 1) return new Promise(resolve => { finishOld = resolve; });
   return { histories: body.queries.map(() => ({ transactions: [] })) };
  });
  try {
   const messages = h.add('one', 'socket', [A]);
   h.hub.subscribeSocket('one', 'socket', [B], undefined); h.clear();
   h.hub.upstreamChange(A, 'stale-upstream');
   finishOld({ histories: [{ transactions: [{ txid: 'stale-history', status: 'confirmed', timestamp: Date.now() }] }] });
   await tick();
   expect(messages.filter(message => message.event.startsWith('tx:'))).toHaveLength(0);
   h.hub.upstreamChange(B, 'current-upstream');
   expect(messages.filter(message => message.event === 'tx:incoming').map(message => message.data.txid)).toEqual(['current-upstream']);
   expect(h.hub.activeAddressCount()).toBe(1);
   expect(h.changes.at(-1)).toEqual([B]);
  } finally { h.close(); }
  expect(h.hub.activeAddressCount()).toBe(0); expect(h.closes).toBeGreaterThan(0);
 });

 test('explicit SSE scope supersedes legacy inventory; closing it removes implicit socket watches', async () => {
  const h = setup(); let response: Response | undefined;
  try {
   h.hub.rememberPortfolio('one', [{ caip: `${ETH}/slip44:60`, pubkey: A.address }]);
   const messages: Delivery[] = [];
   h.hub.addSocket('one', 'legacy', (event, data) => messages.push({ event, data }));
   response = h.hub.createSse('one', [B], undefined);
   const reader = response.body!.getReader();
   expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: connected');
   expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: sync:required');
   h.hub.rememberPortfolio('one', [{ caip: `${ETH}/slip44:60`, pubkey: A.address }]);
   expect(h.hub.activeAddressCount()).toBe(1); messages.length = 0;
   h.hub.upstreamChange(A, 'old-wallet'); expect(messages).toHaveLength(0);
   h.hub.upstreamChange(B, 'active-wallet');
   expect(messages.some(message => message.event === 'tx:incoming')).toBe(true);
   await reader.cancel(); response = undefined; messages.length = 0;
   expect(h.hub.activeAddressCount()).toBe(0);
   h.hub.upstreamChange(B, 'after-close'); expect(messages).toHaveLength(0);
   h.hub.addSocket('one', 'after-close', () => {}); expect(h.hub.activeAddressCount()).toBe(0);
  } finally { await response?.body?.cancel().catch(() => {}); h.hub.removeSocket('one', 'legacy'); h.hub.removeSocket('one', 'after-close'); h.close(); }
 });

 test('reconnect history catch-up is limited to its own subscription and since cursor', async () => {
  const A={address:'LtcWatchA',networkId:'bip122:12a765e31ffd4059bada1e25190f6e98'};
  const now = Date.now();
  const h = setup(async body => ({ histories: body.queries.map(() => ({ transactions: [
   { txid: 'recent', status: 'confirmed', timestamp: now - 1_000 },
   { txid: 'too-old', status: 'confirmed', timestamp: now - 60_000 },
  ] })) }));
  try {
   const existing = h.add('existing-user', 'existing', [A]); await tick(); h.clear();
   const reconnected = h.add('new-user', 'reconnected', [A], now - 5_000); await tick();
   expect(existing.filter(message => message.event.startsWith('tx:'))).toHaveLength(0);
   expect(reconnected.filter(message => message.event === 'tx:incoming').map(message => message.data.txid)).toEqual(['recent']);
   expect(reconnected.filter(message => message.event === 'tx:confirmed').map(message => message.data.txid)).toEqual(['recent']);
   expect(() => h.hub.subscribeSocket('new-user', 'reconnected', [A], undefined, { since: now + 120_000 })).toThrow();
  } finally { h.close(); }
 });

 test('base58 watches retain case while equivalent EVM watches share work', async () => {
  const h = setup();
  try {
   const one = h.add('one', 'one', [{ address: 'Base58Case', networkId: SOL }, A]);
   const two = h.add('two', 'two', [{ address: 'base58case', networkId: SOL }, { ...A, address: A.address.toUpperCase() }]);
   await tick(); h.clear(); expect(h.hub.activeAddressCount()).toBe(3);
   h.hub.upstreamChange({ address: 'Base58Case', networkId: SOL }, 'case-sensitive');
   expect(one.some(message => message.data.txid === 'case-sensitive')).toBe(true);
   expect(two.some(message => message.data.txid === 'case-sensitive')).toBe(false);
  } finally { h.close(); }
 });
});
