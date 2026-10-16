import { test, expect } from '@playwright/test';
import { retryPairingRequest } from '../src/security';

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
