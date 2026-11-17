export interface CacheObservation {
 fetchedAt: number;
 freshUntil: number;
 staleUntil: number;
 source: string;
 version?: string;
}
export interface StoredCacheEntry<T> extends CacheObservation { value: T }
const observations = new WeakMap<object, CacheObservation>();
/** Provenance stays out of provider payloads and survives in-process cache hits. */
export function observeCache<T>(value: T, observation: CacheObservation): T {
 if (value !== null && typeof value === 'object') observations.set(value, observation);
 return value;
}
export function cacheObservation(value: unknown): CacheObservation | undefined {
 return value !== null && typeof value === 'object' ? observations.get(value) : undefined;
}
export function inheritObservation<T>(value: T, source: unknown): T {
 const observation = cacheObservation(source);
 return observation ? observeCache(value, observation) : value;
}
export interface PersistentCache {
 getFresh<T>(namespace: string, key: string): Promise<T | null>;
 getStale<T>(namespace: string, key: string): Promise<T | null>;
 /** Optional for legacy adapters; unknown age is never promoted to fresh memory. */
 getEntry?<T>(namespace: string, key: string, mode: 'fresh' | 'stale'): Promise<StoredCacheEntry<T> | null>;
 set(namespace: string, key: string, value: unknown, freshForMs: number, staleForMs: number, source: string): Promise<void>;
 runExclusive<T>(key: string, task: () => Promise<T>): Promise<T>;
}
export async function readCache<T>(cache: PersistentCache, namespace: string, key: string, mode: 'fresh' | 'stale'): Promise<StoredCacheEntry<T> | null> {
 if (cache.getEntry) return cache.getEntry<T>(namespace, key, mode);
 const value = await (mode === 'fresh' ? cache.getFresh<T>(namespace, key) : cache.getStale<T>(namespace, key));
 return value === null ? null : { value, fetchedAt: 0, freshUntil: 0, staleUntil: 0, source: 'unknown' };
}
export async function readCacheValue<T>(cache: PersistentCache | undefined, namespace: string, key: string, mode: 'fresh' | 'stale'): Promise<T | null> {
 if (!cache) return null;
 const entry = await readCache<T>(cache, namespace, key, mode);
 return entry ? observeCache(entry.value, entry) : null;
}
