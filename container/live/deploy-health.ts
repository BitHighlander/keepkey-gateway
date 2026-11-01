/** A healthy old container must not satisfy deployment verification. */
export {};

const [origin, revision] = process.argv.slice(2);
if (!origin || !/^[a-f0-9]{40}$/.test(revision || "")) throw new Error("Provide the API origin and full commit SHA");
const deadline = Date.now() + 180_000;
while (Date.now() < deadline) {
	try {
		const response = await fetch(`${origin}/api/v1/health`, {
			headers: { "Cache-Control": "no-cache" },
			signal: AbortSignal.timeout(10_000),
		});
		const body = await response.json() as { status?: string; database?: string; revision?: string };
		if (response.ok && body.status === "ok" && body.database === "ok" && body.revision === revision) {
			console.log(`Verified healthy gateway revision ${revision}`);
			process.exit(0);
		}
		console.log(`Waiting for gateway revision ${revision}; current revision: ${body.revision || "unstamped"}, HTTP ${response.status}`);
	} catch {
		console.log("Waiting for gateway health during container rollout");
	}
	await Bun.sleep(3_000);
}
throw new Error(`Gateway revision ${revision} did not become healthy within three minutes`);
