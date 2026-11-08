import { test, expect } from '@playwright/test';
import { PairingConnectionError, PairingResponseError, retryInitialPairing, retryPairingRequest, ticketURL } from '../../src/security';

test('initial pairing retries transient failures within a fixed attempt limit', async () => {
  let calls = 0;
  await retryInitialPairing(async () => { if (++calls < 3) throw new PairingResponseError('Temporarily unavailable', 503); }, new AbortController().signal);
  expect(calls).toBe(3); calls = 0;
  await expect(retryInitialPairing(async () => { calls++; throw new PairingConnectionError('Generated failure'); }, new AbortController().signal)).rejects.toThrow('Generated failure');
  expect(calls).toBe(4);
});

test('authentication, expiry, rate limits and invalid responses never start initial pairing retries', async () => {
  for (const error of [...[400, 401, 403, 404, 409, 410, 429].map(status => new PairingResponseError('Terminal', status)), new Error('配对信息无效'), new SyntaxError('Invalid response')]) {
    let calls = 0;
    await expect(retryInitialPairing(async () => { calls++; throw error; }, new AbortController().signal)).rejects.toBe(error);
    expect(calls).toBe(1);
  }
});

test('cancel stops both the initial retry delay and an active attempt', async () => {
  const source = new AbortController(); let calls = 0;
  await expect(retryInitialPairing(async () => { calls++; throw new PairingConnectionError('Generated failure'); }, source.signal, () => source.abort())).rejects.toMatchObject({ name: 'AbortError' });
  expect(calls).toBe(1);
  const active = new AbortController();
  const result = retryInitialPairing(signal => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true }); active.abort();
  }), active.signal);
  await expect(result).rejects.toMatchObject({ name: 'AbortError' });
});

test('ticket authentication and expiry responses retain terminal status', async () => {
  const original = globalThis.fetch;
  try {
    for (const status of [401, 403, 409, 410, 429]) {
      let calls = 0;
      globalThis.fetch = async () => { calls++; return new Response('Generated denial', { status }); };
      await expect(retryInitialPairing(async signal => { await ticketURL('ws://signal.invalid/rooms/test?token=fixture-credential', undefined, signal); }, new AbortController().signal)).rejects.toMatchObject({ status });
      expect(calls).toBe(1);
    }
  } finally { globalThis.fetch = original; }
});

test('a transient pairing abort reuses credentials but gets a fresh deadline', async () => {
  const original = globalThis.fetch, calls: { value: string; options?: RequestInit }[] = [];
  globalThis.fetch = async (value, options) => {
    calls.push({ value: String(value), options });
    if (calls.length === 1) throw new DOMException('Transient', 'AbortError');
    return Response.json({ ready: true });
  };
  try {
    await retryPairingRequest('https://signal.invalid/rooms/test?token=fixture-credential', { method: 'POST', body: JSON.stringify({ type: 'join' }) });
    expect(calls).toHaveLength(2);
    expect(calls[0].value).toBe(calls[1].value); expect(new URL(calls[0].value).searchParams.has('token')).toBe(false);
    for (const call of calls) expect(new Headers(call.options?.headers).get('authorization')).toBe('Bearer fixture-credential');
    expect(calls[0].options?.body).toBe(calls[1].options?.body);
    expect(calls[0].options?.signal).not.toBe(calls[1].options?.signal);
  } finally { globalThis.fetch = original; }
});

test('persistent aborts stop after two attempts and HTTP authentication errors are not retried', async () => {
  const original = globalThis.fetch; let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; throw new DOMException('Persistent', 'AbortError'); };
    await expect(retryPairingRequest('https://signal.invalid/rooms/test')).rejects.toThrow('Persistent');
    expect(calls).toBe(2); calls = 0;
    globalThis.fetch = async () => { calls++; return new Response(null, { status: 401 }); };
    expect((await retryPairingRequest('https://signal.invalid/rooms/test')).status).toBe(401);
    expect(calls).toBe(1);
  } finally { globalThis.fetch = original; }
});

// Creation has a separate, bounded policy: never reuse the ordinary room retry
// helper without an independent creation capability and server ownership check.
test('creation retries one transient request with the same capability and preserves legacy success', async () => {
  const { createShare } = await import('../../src/share-creation');
  const original = globalThis.fetch, requests: string[] = []; let retries = 0;
  const creation = { v: 2 as const, room: '11'.repeat(32), receiverHash: '22'.repeat(32), multi: true as const, creationToken: '33'.repeat(32) };
  try {
    globalThis.fetch = async (_url, options) => {
      requests.push(String(options?.body));
      if (requests.length === 1) throw new TypeError('Transient network failure');
      return Response.json({ v: 2, room: creation.room, sender: creation.creationToken, creationRetry: 1 }, { status: 200 });
    };
    const session = await createShare('https://creation.invalid', creation, { signal: new AbortController().signal, retry: () => retries++, challenge: async () => { throw Error('Unexpected challenge'); } });
    expect(session.sender).toBe(creation.creationToken); expect(retries).toBe(1);
    expect(requests).toHaveLength(2); expect(requests[0]).toBe(requests[1]);
    globalThis.fetch = async () => Response.json({ v: 2, room: creation.room, sender: '44'.repeat(32) }, { status: 201 });
    expect((await createShare('https://creation.invalid', creation, { signal: new AbortController().signal, retry() {}, challenge: async () => '' })).sender).toBe('44'.repeat(32));
  } finally { globalThis.fetch = original; }
});

test('creation never retries denial, quota, invalid success, or cancellation during the retry delay', async () => {
  const { createShare } = await import('../../src/share-creation');
  const original = globalThis.fetch;
  const creation = { v: 2 as const, room: '11'.repeat(32), receiverHash: '22'.repeat(32), multi: true as const, creationToken: '33'.repeat(32) };
  try {
    for (const status of [400, 401, 403, 409, 410, 429, 501, 503]) {
      let calls = 0;
      globalThis.fetch = async () => { calls++; return Response.json({ error: 'New shares temporarily paused' }, { status }); };
      await expect(createShare('https://creation.invalid', creation, { signal: new AbortController().signal, retry() { throw Error('Should not retry'); }, challenge: async () => '' })).rejects.toThrow();
      expect(calls).toBe(1);
    }
    globalThis.fetch = async () => Response.json({ v: 2, room: creation.room, sender: '44'.repeat(32), creationRetry: 1 });
    await expect(createShare('https://creation.invalid', creation, { signal: new AbortController().signal, retry() {}, challenge: async () => '' })).rejects.toThrow('返回信息无效');
    let calls = 0; const cancel = new AbortController();
    globalThis.fetch = async () => { calls++; throw new TypeError('Transient'); };
    await expect(createShare('https://creation.invalid', creation, { signal: cancel.signal, retry: () => cancel.abort(), challenge: async () => '' })).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(1);
  } finally { globalThis.fetch = original; }
});
