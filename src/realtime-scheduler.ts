const REVISION_KEY = "watch-registration-revision";
export const BACKGROUND_POLL_MS = 15_000;

type SchedulerStorage = Pick<DurableObjectStorage, "get" | "setAlarm" | "transaction">;
export interface BackgroundTickResult { watches: number; queued: number; failures: number }

// A registration must durably arm the monitor before the client receives success.
export async function armPaymentMonitor(storage: SchedulerStorage, now = Date.now()): Promise<void> {
	await storage.transaction(async (txn) => {
		await txn.put(REVISION_KEY, (await txn.get<number>(REVISION_KEY) ?? 0) + 1);
		const alarm = await txn.getAlarm();
		if (alarm === null || alarm > now + 1_000) await txn.setAlarm(now + 1_000);
	});
}

export async function runPaymentMonitor(
	storage: SchedulerStorage,
	tick: () => Promise<BackgroundTickResult>,
	now = Date.now(),
): Promise<BackgroundTickResult> {
	const revision = await storage.get<number>(REVISION_KEY) ?? 0;
	// Schedule before network I/O, so even a process interruption leaves a wake-up.
	await storage.setAlarm(now + BACKGROUND_POLL_MS);
	const result = await tick();
	if (!Number.isSafeInteger(result.watches) || result.watches < 0) throw new Error("Invalid monitor result");
	if (result.watches === 0) {
		await storage.transaction(async (txn) => {
			// An empty tick must not cancel a concurrently registered wallet's wake-up.
			if ((await txn.get<number>(REVISION_KEY) ?? 0) === revision) await txn.deleteAlarm();
		});
	}
	return result;
}

export function isInternalRealtimePath(pathname: string): boolean {
	return pathname === "/api/v1/internal" || pathname.startsWith("/api/v1/internal/");
}

export function changesDurablePaymentWatches(request: Request): boolean {
	return request.method === "POST" && new URL(request.url).pathname.replace(/\/$/, "") === "/api/v1/events/watches";
}
