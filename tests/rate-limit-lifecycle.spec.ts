import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('a late rate-limit alarm preserves a renewed creation window and still cleans idle records', async () => {
  const clock = { now: 1000000 }, data = new Map<string, any>(), alarms: number[] = [];
  class Clock extends Date { static now() { return clock.now; } }
  let queue = Promise.resolve();
  const storage = {
    get: async (key: string) => structuredClone(data.get(key)),
    put: async (key: string, value: any) => { data.set(key, structuredClone(value)); },
    transaction: (fn: (storage: any) => Promise<any>) => { const task = queue.then(() => fn(storage)); queue = task.then(() => {}, () => {}); return task; },
    setAlarm: async (at: number) => { alarms.push(at); }, deleteAll: async () => { data.clear(); }
  };
  const scope: any = { Date: Clock, DurableObject: class { constructor(public ctx: any) {} } };
  const source = (await readFile('signal/worker.js', 'utf8')).replace("import { DurableObject } from 'cloudflare:workers';", '').replace('export default', 'const handler =').replaceAll('export class', 'class');
  vm.runInNewContext(source + '\nglobalThis.RateLimit = RateLimit;', scope);
  const limit = new scope.RateLimit({ storage });
  await limit.creation(); clock.now += 120000;
  expect(await limit.creation()).toEqual({ allowed: true, challenge: false });
  // The old alarm arrives after the new window has already recorded request 1.
  await limit.alarm();
  expect(data.get('bucket')?.count).toBe(1);
  expect(alarms.at(-1)).toBe(clock.now + 120000);
  for (let count = 2; count <= 10; count++) {
    expect(await limit.creation()).toEqual({ allowed: true, challenge: count > 3 });
  }
  expect((await limit.creation()).allowed).toBe(false);
  clock.now += 120000; await limit.alarm(); expect(data.has('bucket')).toBe(false);
  expect(await limit.creation()).toEqual({ allowed: true, challenge: false });
});
