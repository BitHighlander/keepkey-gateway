// Start the service and exercise Vault's installed generated Pioneer client in
// the same process, then exit without leaving a background listener behind.
await import("../server.ts");

try {
	await import("./vault-client.mjs");
	process.exit(0);
} catch (error) {
	console.error(error);
	process.exit(1);
}
