const PORT = Number(process.env.PORT ?? 8080);

Bun.serve({
	port: PORT,
	fetch(req, server) {
		const url = new URL(req.url);

		if (url.pathname === "/ws") {
			if (server.upgrade(req)) return;
			return new Response("Upgrade failed", { status: 400 });
		}

		if (url.pathname === "/api/v1/health") {
			return Response.json({ status: "ok", service: "keepkey-gateway-container" });
		}

		return new Response("Not found", { status: 404 });
	},
	websocket: {
		// Proves WebSocket forwarding through the Worker -> Container path
		// works end-to-end. Echoes back whatever it receives.
		message(ws, message) {
			ws.send(message);
		},
	},
});

console.log(`keepkey-gateway container listening on :${PORT}`);
