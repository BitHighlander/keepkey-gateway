export default {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/api/v1/health") {
			return Response.json({ status: "ok", service: "keepkey-gateway", version: "0.0.1" });
		}

		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler;
