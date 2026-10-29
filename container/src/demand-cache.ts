import type { PersistentCache } from "./cache";

interface MemoryEntry<T> {
	value: T;
	expiresAt: number;
}

export interface DemandCachePolicy {
	namespace: string;
	key: string;
	freshForMs: number;
	staleForMs: number;
	source: string;
}

/** Bounded L1 + PostgreSQL read-through caching with per-process singleflight.
 * Nothing is refreshed until a caller asks for the value. */
export class DemandCache {
	private readonly memory = new Map<string, MemoryEntry<unknown>>();
	private readonly inFlight = new Map<string, Promise<unknown>>();

	constructor(private readonly persistent: PersistentCache, private readonly maxEntries = 2_000) {}

	async get<T>(policy: DemandCachePolicy, loader: () => Promise<T>): Promise<T> {
		const compoundKey = `${policy.namespace}:${policy.key}`;
		const memory = this.memory.get(compoundKey) as MemoryEntry<T> | undefined;
		if (memory && memory.expiresAt > Date.now()) return memory.value;

		const running = this.inFlight.get(compoundKey) as Promise<T> | undefined;
		if (running) return running;

		const request = this.load(policy, compoundKey, loader).finally(() => this.inFlight.delete(compoundKey));
		this.inFlight.set(compoundKey, request);
		return request;
	}

	private async load<T>(policy: DemandCachePolicy, compoundKey: string, loader: () => Promise<T>): Promise<T> {
		const persisted = await this.persistent.getFresh<T>(policy.namespace, policy.key);
		if (persisted !== null) {
			this.remember(compoundKey, persisted, policy.freshForMs);
			return persisted;
		}

		try {
			return await this.persistent.runExclusive(`cache:${compoundKey}`, async () => {
				const afterLock = await this.persistent.getFresh<T>(policy.namespace, policy.key);
				if (afterLock !== null) {
					this.remember(compoundKey, afterLock, policy.freshForMs);
					return afterLock;
				}
				const value = await loader();
				await this.persistent.set(policy.namespace, policy.key, value, policy.freshForMs, policy.staleForMs, policy.source);
				this.remember(compoundKey, value, policy.freshForMs);
				return value;
			});
		} catch (error) {
			const stale = await this.persistent.getStale<T>(policy.namespace, policy.key);
			if (stale !== null) return stale;
			throw error;
		}
	}

	private remember<T>(key: string, value: T, ttlMs: number): void {
		this.memory.delete(key);
		this.memory.set(key, { value, expiresAt: Date.now() + ttlMs });
		while (this.memory.size > this.maxEntries) {
			const oldest = this.memory.keys().next().value;
			if (typeof oldest !== "string") break;
			this.memory.delete(oldest);
		}
	}
}
