import { expect, test } from 'bun:test';
import { forwardGatewayRead, gatewayErrorReason, gatewayFailureResponse } from './gateway-transport';
import { ContainerStartError } from './pool';

test('a portfolio transport failure retries once with its complete query body', async () => {
    const bodies: string[] = [];
    const request = new Request('https://api-blue.keepkey.info/api/v1/portfolio/balances?forceRefresh=true', {
        method: 'POST', body: JSON.stringify({ pubkeys: ['fixture'], providerRefreshPolicy: 'cache-only' }),
    });
    const response = await forwardGatewayRead(request, async copy => {
        bodies.push(await copy.text());
        if (bodies.length === 1) throw new Error('container connection reset');
        return Response.json({ balances: [] });
    });
    expect(response.status).toBe(200);
    expect(bodies).toEqual([bodies[0], bodies[0]]);
});

test('GET retries are bounded and HTTP provider errors are never retried', async () => {
    const request = () => new Request('https://api-blue.keepkey.info/api/v1/utxo/unspent/ZEC/fixture');
    let calls = 0;
    await expect(forwardGatewayRead(request(), async () => { calls++; throw Error('offline'); })).rejects.toThrow('offline');
    expect(calls).toBe(2);
    calls = 0;
    expect((await forwardGatewayRead(request(), async () => { calls++; return new Response(null, { status: 502 }); })).status).toBe(502);
    expect(calls).toBe(1);
});

test('ambiguous mutations and websocket upgrades never replay or advertise safe retries', async () => {
    for (const request of [
        new Request('https://fixture/api/v1/broadcast', { method: 'POST', body: '{}' }),
        new Request('https://fixture/api/v1/hive/create-account', { method: 'POST', body: '{}' }),
        new Request('https://fixture/socket.io', { headers: { upgrade: 'websocket' } }),
    ]) {
        let calls = 0;
        await expect(forwardGatewayRead(request, async () => { calls++; throw Error('transport'); })).rejects.toThrow('transport');
        expect(calls).toBe(1);
        const response = gatewayFailureResponse(request, Error('transport'), 'fixture-id');
        expect((await response.json() as any).error.code).toBe('delivery_unknown');
        expect(response.headers.has('Retry-After')).toBe(false);
    }
});

test('startup and read failures return a correlated JSON 503 without exposing internal details', async () => {
    const request = new Request('https://fixture/api/v1/portfolio/balances', { method: 'POST', body: '{}' });
    const response = gatewayFailureResponse(request, Error('private internal details'), 'fixture-id');
    expect(response.status).toBe(503);
    expect(response.headers.get('x-request-id')).toBe('fixture-id');
    expect(response.headers.get('Retry-After')).toBe('5');
    expect(await response.text()).not.toContain('private internal details');
    const mutation = new Request('https://fixture/api/v1/broadcast', { method: 'POST', body: '{}' });
    expect((await gatewayFailureResponse(mutation, new ContainerStartError('not dispatched'), 'fixture-id').json() as any).error.code).toBe('gateway_unavailable');
    expect(gatewayErrorReason(Error('failure https://provider/key/secret?value=credential 0x' + 'a'.repeat(40)))).toBe('failure [upstream] [redacted]');
});
