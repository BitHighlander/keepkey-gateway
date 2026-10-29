// Run the container and the live contract suite in one process. This avoids
// leaving a background listener behind and works in network-isolated CI/dev
// shells where separate commands cannot always reach each other's loopback.
export {};

await import("../server");

try {
	await import("./run");
	process.exit(0);
} catch (error) {
	console.error(error);
	process.exit(1);
}
