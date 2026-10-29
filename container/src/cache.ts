export interface PersistentCache {
	getFresh<T>(namespace: string, key: string): Promise<T | null>;
	getStale<T>(namespace: string, key: string): Promise<T | null>;
	set(namespace: string, key: string, value: unknown, freshForMs: number, staleForMs: number, source: string): Promise<void>;
	runExclusive<T>(key: string, task: () => Promise<T>): Promise<T>;
}
