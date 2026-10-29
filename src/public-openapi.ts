/** Container forwarding may use HTTP internally; SDK URLs must use the public origin. */
export async function publicOpenApiResponse(request: Request, response: Response): Promise<Response> {
	if (request.method !== "GET" || new URL(request.url).pathname !== "/spec/swagger.json" || !response.ok) return response;
	const document = await response.json() as Record<string, unknown>;
	document.servers = [{ url: `${new URL(request.url).origin}/api/v1` }];
	const headers = new Headers(response.headers);
	headers.delete("Content-Length");
	headers.delete("ETag");
	headers.set("Content-Type", "application/json;charset=utf-8");
	headers.set("Cache-Control", "no-store");
	return new Response(JSON.stringify(document), { status: response.status, headers });
}
