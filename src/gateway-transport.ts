import { ContainerStartError } from './pool';

// POST query endpoints are reads despite their HTTP method. Never replay a
// broadcast, signing request, account creation or other mutation after dispatch.
const READ_POST_PATHS = new Set(['/api/v1/portfolio', '/api/v1/portfolio/balances', '/api/v1/tx/history']);
export function isGatewayRead(request: Request): boolean {
    return request.headers.get('upgrade')?.toLowerCase() !== 'websocket'
        && (request.method === 'GET' || request.method === 'HEAD'
            || (request.method === 'POST' && READ_POST_PATHS.has(new URL(request.url).pathname)));
}

export async function forwardGatewayRead(request: Request, forward: (request: Request) => Promise<Response>): Promise<Response> {
    if (!isGatewayRead(request)) return forward(request);
    // Keep a separate body for a single transport retry; HTTP provider failures
    // remain visible and do not cause another upstream request here.
    const retry = request.clone();
    try {
        return await forward(request);
    } catch {
        if (request.signal.aborted) throw new Error('Gateway request cancelled');
        return forward(retry);
    }
}

export function gatewayFailureResponse(request: Request, error: unknown, requestId: string): Response {
    const deliveryUnknown = !isGatewayRead(request) && !(error instanceof ContainerStartError);
    return Response.json({ error: {
        code: deliveryUnknown ? 'delivery_unknown' : 'gateway_unavailable',
        message: deliveryUnknown
            ? 'Request delivery could not be confirmed. Check its status before retrying.'
            : 'The balance server is temporarily unavailable. Cached balances are retained; try again shortly.',
    }, requestId }, { status: 503, headers: {
        'Cache-Control': 'no-store', 'x-request-id': requestId,
        ...(!deliveryUnknown ? { 'Retry-After': '5' } : {}),
    } });
}

export function gatewayErrorReason(error: unknown): string {
    // Provider URLs can include credentials; emit bounded diagnostics only.
    const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : '';
    return ((error instanceof Error ? error.message : 'Unknown gateway failure') + cause)
        .replace(/https?:\/\/\S+/g, '[upstream]')
        .replace(/[A-Za-z0-9_-]{24,}/g, '[redacted]').slice(0, 200);
}
