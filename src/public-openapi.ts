/** Container forwarding may use HTTP internally; SDK URLs must use the public origin. */
export async function publicOpenApiResponse(request: Request, response: Response): Promise<Response> {
	if (request.method !== "GET" || new URL(request.url).pathname !== "/spec/swagger.json" || !response.ok) return response;
	const document = await response.json() as Record<string, unknown>;
    // The .info host preserves the legacy superset, but these operations are
    // served by the gateway for registered clients. Advertise their actual
    // refresh contract so SDK clients do not strip the intent or refuse it.
    const spec = document as any;
    for (const item of Object.values(spec.paths ?? {}) as any[]) {
        const operation = item?.post;
        if (!['GetPortfolioBalances', 'GetTransactionHistory'].includes(operation?.operationId)) continue;
        let schema = operation.requestBody?.content?.['application/json']?.schema
            ?? operation.parameters?.find((row: any) => row.in === 'body')?.schema;
        if (schema?.$ref?.startsWith('#/')) {
            schema = schema.$ref.slice(2).split('/').reduce((value: any, key: string) => value?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], spec);
        }
        if (!schema) continue;
        schema.properties = { ...schema.properties,
            providerRefreshPolicy: { type: 'string', enum: ['cache-only', 'on-demand'] },
            refreshReason: { type: 'string', enum: ['wallet-open', 'manual', 'automatic', 'focus', 'swap-reconcile', 'degraded-retry'] },
        };
    }
	document.servers = [{ url: `${new URL(request.url).origin}/api/v1` }];
	const headers = new Headers(response.headers);
	headers.delete("Content-Length");
	headers.delete("ETag");
	headers.set("Content-Type", "application/json;charset=utf-8");
	headers.set("Cache-Control", "no-store");
	return new Response(JSON.stringify(document), { status: response.status, headers });
}
