import { expect, mock, test } from 'bun:test';

let startupFails = false, attempts = 0, failures = 0;
const received: string[] = [];
mock.module('@cloudflare/containers', () => ({ Container: class {}, getContainer: () => ({
    startAndWaitForPorts: async () => { if (startupFails) throw Error('container startup unavailable'); },
    fetch: async (request: Request) => {
        attempts++; received.push(await request.text());
        if (attempts <= failures) throw Error('container connection reset');
        return Response.json({ balances: [] });
    },
}) }));
mock.module('cloudflare:workers', () => ({ DurableObject: class {} }));
const { default: worker } = await import('./index');
const env = {} as any;
function request(path: string) {
    attempts = 0; received.length = 0;
    return new Request('https://api-blue.keepkey.info/api/v1/' + path, {
        method: 'POST', headers: { 'x-request-id': 'fixture-request' }, body: '{"fixture":true}',
    });
}

test('the deployed Worker retries a read transport failure and preserves its POST body', async () => {
    startupFails = false; failures = 1;
    const response = await worker.fetch(request('portfolio/balances'), env);
    expect(response.status).toBe(200); expect(attempts).toBe(2);
    expect(received).toEqual(['{"fixture":true}', '{"fixture":true}']);
});

test('the deployed Worker converts exhausted read failures into JSON instead of throwing 1101', async () => {
    startupFails = false; failures = 10;
    const response = await worker.fetch(request('tx/history'), env);
    expect(response.status).toBe(503); expect(attempts).toBe(2);
    expect(await response.json()).toMatchObject({ error: { code: 'gateway_unavailable' }, requestId: 'fixture-request' });
});

test('the deployed Worker leaves ambiguous broadcasts unreplayed and distinguishes startup failure', async () => {
    startupFails = false; failures = 10;
    const ambiguous = await worker.fetch(request('broadcast'), env);
    expect(attempts).toBe(1);
    expect(await ambiguous.json()).toMatchObject({ error: { code: 'delivery_unknown' } });
    startupFails = true;
    const unavailable = await worker.fetch(request('broadcast'), env);
    expect(attempts).toBe(0);
    expect(await unavailable.json()).toMatchObject({ error: { code: 'gateway_unavailable' } });
    startupFails = false;
});
