import { test, expect } from '@playwright/test';
import { TransferFlow } from '../src/transfer-flow';

const KiB = 1024, MiB = 1048576;

test('stable delayed receipts retain flight headroom while fast receipts keep the flight small', () => {
  const simulate = (latency: number) => {
    const flow = new TransferFlow(); flow.reset(0, 0);
    let sent = 0, confirmed = 0;
    const receipts: { at: number; bytes: number }[] = [];
    const windows: number[] = [];
    for (let now = 0; now < 2000 && confirmed < 8 * MiB; now++) {
      while (receipts[0]?.at <= now) {
        const receipt = receipts.shift()!; confirmed = receipt.bytes; flow.confirm(confirmed, now);
        windows.push(flow.windowBytes);
      }
      if (sent < 8 * MiB && flow.allows(sent - confirmed, 32 * KiB, now)) {
        flow.sent(sent += 32 * KiB, now);
        if (sent % (256 * KiB) === 0) receipts.push({ at: now + latency, bytes: sent });
      }
      expect(sent - confirmed).toBeLessThanOrEqual(4 * MiB);
    }
    expect(confirmed).toBe(8 * MiB);
    return windows;
  };
  const fast = simulate(2), delayed = simulate(150);
  expect(Math.max(...fast.slice(4))).toBeLessThan(MiB);
  expect(Math.min(...delayed)).toBeGreaterThanOrEqual(3 * MiB);
});

test('resume discards old feedback timing while retaining the committed byte count', () => {
  const flow = new TransferFlow(); flow.reset(0, 0);
  flow.sent(256 * KiB, 0); flow.confirm(256 * KiB, 10);
  flow.sent(512 * KiB, 20); flow.confirm(512 * KiB, 500);
  expect(flow.windowBytes).toBeLessThan(4 * MiB);
  flow.reset(512 * KiB, 60000);
  expect(flow.windowBytes).toBe(4 * MiB);
  flow.confirm(512 * KiB, 60001); // duplicate pre-resume receipt
  expect(flow.windowBytes).toBe(4 * MiB);
  flow.sent(768 * KiB, 60002); flow.confirm(768 * KiB, 60152);
  expect(flow.windowBytes).toBe(4 * MiB);
  expect(flow.allows(4 * MiB, 32 * KiB, 60153)).toBe(false);
});

test('confirmed receiver slowdown shrinks flight and useful progress can grow it again', () => {
  const flow = new TransferFlow(); flow.reset(0, 0);
  flow.sent(256 * KiB, 0); flow.confirm(256 * KiB, 10);
  const healthy = flow.windowBytes;
  flow.sent(512 * KiB, 20); flow.confirm(512 * KiB, 300);
  flow.sent(768 * KiB, 310); flow.confirm(768 * KiB, 600);
  const slow = flow.windowBytes;
  expect(slow).toBeLessThan(healthy); expect(slow).toBeGreaterThanOrEqual(512 * KiB);
  let end = 768 * KiB;
  for (let at = 610; at < 1010; at += 10) {
    flow.allows(flow.windowBytes, 32 * KiB, at);
    flow.sent(end += 256 * KiB, at); flow.confirm(end, at + 10);
  }
  expect(flow.windowBytes).toBeGreaterThan(slow);
});
