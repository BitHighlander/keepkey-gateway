import { observeCache, readCache, type PersistentCache, type StoredCacheEntry } from './cache';
export interface DemandCachePolicy {
 namespace: string; key: string; freshForMs: number; staleForMs: number; source: string;
}
/** Bounded L1 + PostgreSQL cache. Freshness always belongs to the observation,
 * never to the time a process copied the value into memory. */
export class DemandCache {
 private readonly memory = new Map<string, StoredCacheEntry<unknown>>();
 private readonly inFlight = new Map<string, Promise<StoredCacheEntry<unknown>>>();
 private readonly refreshInFlight = new Map<string, Promise<StoredCacheEntry<unknown>>>();
 constructor(private readonly persistent: PersistentCache, private readonly maxEntries = 2000) {}
 async get<T>(policy: DemandCachePolicy, loader: () => Promise<T>, options: {forceRefresh?: boolean} = {}): Promise<T> {
  const entry = await this.entry(policy, loader, options);
  return observeCache(entry.value, entry);
 }
 private async entry<T>(policy: DemandCachePolicy, loader: () => Promise<T>, options: {forceRefresh?: boolean}): Promise<StoredCacheEntry<T>> {
  const key = `${policy.namespace}:${policy.key}`;
  const refreshing = this.refreshInFlight.get(key) as Promise<StoredCacheEntry<T>> | undefined;
  if (refreshing) return refreshing;
  if (options.forceRefresh) {
   const requestedAt = Date.now();
   this.memory.delete(key);
   const prior = this.inFlight.get(key);
   const request = (async () => {
    // Read a baseline before waiting for a shared lock. Another instance may
    // complete this same refresh while we wait; reuse only that newer result.
    if (prior) await prior.catch(() => undefined);
    const baseline = this.persistent.getEntry ? await readCache<T>(this.persistent, policy.namespace, policy.key, 'stale') : null;
    return this.load(policy, key, loader, { requestedAt, baseline });
   })().finally(() => this.refreshInFlight.delete(key));
   this.refreshInFlight.set(key, request);
   return request;
  }
  const memory = this.memory.get(key) as StoredCacheEntry<T> | undefined;
  if (memory && memory.freshUntil > Date.now()) return memory;
  const running = this.inFlight.get(key) as Promise<StoredCacheEntry<T>> | undefined;
  if (running) return running;
  const request = this.load(policy, key, loader).finally(() => this.inFlight.delete(key));
  this.inFlight.set(key, request);
  return request;
 }
 private async load<T>(policy: DemandCachePolicy, key: string, loader: () => Promise<T>, forced?: {requestedAt: number; baseline: StoredCacheEntry<T> | null}): Promise<StoredCacheEntry<T>> {
  if (!forced) {
   const persisted = await readCache<T>(this.persistent, policy.namespace, policy.key, 'fresh');
   if (persisted) { this.remember(key, persisted); return persisted; }
  }
  try {
   return await this.persistent.runExclusive(`cache:${key}`, async () => {
    const after = await readCache<T>(this.persistent, policy.namespace, policy.key, 'fresh');
    const changed = after && (after.version !== undefined && forced?.baseline?.version !== undefined
      ? after.version !== forced.baseline.version : after.fetchedAt > (forced?.baseline?.fetchedAt ?? 0));
    if (after && (!forced || (after.freshUntil > Date.now() && (changed || (!forced.baseline && after.fetchedAt >= forced.requestedAt))))) {
     this.remember(key, after); return after;
    }
    const value = await loader();
    const fetchedAt = Date.now();
    await this.persistent.set(policy.namespace, policy.key, value, policy.freshForMs, policy.staleForMs, policy.source);
    const entry = {value, fetchedAt, freshUntil: fetchedAt + policy.freshForMs, staleUntil: fetchedAt + policy.staleForMs, source: policy.source};
    this.remember(key, entry); return entry;
   });
  } catch (error) {
   if (forced) throw error;
   const stale = await readCache<T>(this.persistent, policy.namespace, policy.key, 'stale');
   if (stale) return stale;
   throw error;
  }
 }
 private remember<T>(key: string, entry: StoredCacheEntry<T>): void {
  this.memory.delete(key);
  if (entry.freshUntil <= Date.now()) return;
  this.memory.set(key, entry);
  while (this.memory.size > this.maxEntries) {
   const oldest = this.memory.keys().next().value;
   if (typeof oldest !== 'string') break;
   this.memory.delete(oldest);
  }
 }
}
