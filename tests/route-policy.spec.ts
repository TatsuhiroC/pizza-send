import { test, expect } from '@playwright/test';
import { RouteFallbackPolicy } from '../src/route-policy';

for (const scenario of [
  { name: 'slow with short ETA stays direct', speed: 64 * 1024, seconds: 60, expected: false },
  { name: '800 KB per second stays direct even for a large file', speed: 800 * 1024, seconds: 1800, expected: false },
  { name: 'fast with long ETA stays direct', speed: 8 * 1048576, seconds: 1800, expected: false },
  { name: 'slow and long ETA becomes eligible after sustained observation', speed: 30 * 1024, seconds: 1800, expected: true },
  { name: 'zero progress remains eligible even when control messages arrive', speed: 0, seconds: 1800, expected: true }
]) test(scenario.name, () => {
  const policy = new RouteFallbackPolicy(), total = Math.max(1048576, scenario.speed * scenario.seconds);
  for (let ms = 0; ms <= 16000; ms += 2000) expect(policy.update(ms, scenario.speed * ms / 1000, total, true)).toBe(false);
  expect(policy.update(18000, scenario.speed * 18, total, true)).toBe(scenario.expected);
});
test('one slow sample, backgrounding, rollback and suspension cannot trigger a switch', () => {
  const policy = new RouteFallbackPolicy();
  for (let i = 0; i <= 5; i++) expect(policy.update(i * 2000, i * 65536, 1e9, true)).toBe(false);
  expect(policy.update(12000, 12 * 1048576, 1e9, true)).toBe(false);
  expect(policy.update(14000, 12 * 1048576, 1e9, false)).toBe(false);
  expect(policy.update(16000, 12 * 1048576, 1e9, true)).toBe(false);
  expect(policy.update(80000, 12 * 1048576, 1e9, true)).toBe(false);
  expect(policy.update(82000, 0, 1e9, true)).toBe(false);
});
