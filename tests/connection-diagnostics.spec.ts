import { test, expect } from './fixtures';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { sanitizedConnectionStats, sanitizedPeerDiagnostics, watchConnectionDiagnostics } from '../src/connection-diagnostics';

test('native counters use an allowlist and never retain addresses or identifiers', () => {
  const entries = [
    { id: 'private-transport', type: 'transport', selectedCandidatePairId: 'private-pair' },
    { id: 'private-pair', type: 'candidate-pair', localCandidateId: 'private-local', remoteCandidateId: 'private-remote', currentRoundTripTime: 0.125, bytesSent: 1234, bytesReceived: 5678, packetsSent: 12, packetsReceived: 34, packetsDiscardedOnSend: 2 },
    { id: 'private-local', type: 'local-candidate', protocol: 'udp', candidateType: 'host', address: '192.168.23.42', networkType: 'wifi', url: 'stun:private.example', usernameFragment: 'private-credential' },
    { id: 'private-remote', type: 'remote-candidate', candidateType: 'srflx', address: '2001:db8::1234' },
    { id: 'private-channel', type: 'data-channel', label: 'private-file-name', bytesSent: 100, bytesReceived: 200 }
  ];
  const report = sanitizedConnectionStats(new Map(entries.map(entry => [entry.id, entry])) as any);
  expect(report).toEqual({ protocol: 'udp', localCandidate: 'host', remoteCandidate: 'srflx', localAddressKind: 'ipv4-private', remoteAddressKind: 'ipv6-public', networkType: 'wifi', stunRoundTripMs: 125, pairBytesSent: 1234, pairBytesReceived: 5678, pairPacketsSent: 12, pairPacketsReceived: 34, localSendDiscardedPackets: 2, channelBytesSent: 100, channelBytesReceived: 200 });
  expect(JSON.stringify(report)).not.toMatch(/192\.168|2001:db8|private-/);
  expect(sanitizedConnectionStats(new Map() as any)).toEqual({});
});

test('peer counters reject invalid numbers and drop arbitrary properties', () => {
  const base = { v: 1, g: 0, s: 1024, r: 0 };
  expect(sanitizedPeerDiagnostics({ ...base, file: 'secret.txt', key: 'private-key', h: 1 })).toEqual({ ...base, h: 1 });
  for (const s of [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1, '123']) expect(sanitizedPeerDiagnostics({ ...base, s })).toBeUndefined();
  expect(sanitizedPeerDiagnostics({ ...base, h: 2 })).toBeUndefined();
  expect(sanitizedPeerDiagnostics({ ...base, h: 1.4 })).toBeUndefined();
  expect(sanitizedPeerDiagnostics({ ...base, v: 99 })).toBeUndefined();
  expect(sanitizedPeerDiagnostics([])).toBeUndefined();
});
test('TURN client TLS transport is distinct from the relay candidate UDP protocol', () => {
  const report = new Map([
    ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
    ['pair', { localCandidateId: 'local', remoteCandidateId: 'remote' }],
    ['local', { protocol: 'udp', candidateType: 'relay', relayProtocol: 'tls', address: 'private-address', url: 'private-url' }],
    ['remote', { candidateType: 'relay' }]
  ]);
  const clean = sanitizedConnectionStats(report as any);
  expect(clean).toMatchObject({ protocol: 'udp', relayProtocol: 'tls' }); expect(JSON.stringify(clean)).not.toContain('private-');
});

test('ordinary module imports do not read the transfer or start collecting', () => {
  expect(watchConnectionDiagnostics(() => { throw Error('ordinary transfers must not be sampled'); })).toBeUndefined();
});
test('a WebSocket handoff drops old native counters even if the trace closes before another sample', async ({ page }) => {
  await page.goto('./?connection-debug=1'); await page.clock.install();
  const result = await page.evaluate(async () => {
    const { watchConnectionDiagnostics, connectionDiagnosticReport } = await import('/src/connection-diagnostics.ts');
    const pc = { connectionState: 'connected', iceConnectionState: 'connected', getStats: async () => new Map([
      ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }], ['pair', { bytesSent: 100, bytesReceived: 200 }]
    ]) };
    const input: any = { pc, role: 'sender', generation: 0, started: performance.now(), sent: 100, acknowledged: 0, received: 0, buffered: 0, queued: 0, window: 524288, sourceBytes: 100, sourceMs: 1, sinkBytes: 0, sinkMs: 0, completed: false, stopped: false, recovering: false, hidden: false, peerHidden: false };
    (window as any).__streamDiag = { input, handle: watchConnectionDiagnostics(() => input), report: connectionDiagnosticReport }; return true;
  });
  expect(result).toBe(true); await page.clock.fastForward(2000);
  const final = await page.evaluate(() => {
    const { input, handle, report } = (window as any).__streamDiag; input.transport = 'websocket'; input.connectionOpen = true; input.generation++;
    const packet = handle.packet(); handle.close(); return { packet, row: report().traces[0].samples.at(-1) };
  });
  expect(final.row).toMatchObject({ transport: 'websocket', connection: 'connected', ice: 'not-applicable' });
  expect(final.row).not.toHaveProperty('pairBytesSent'); expect(final.packet).not.toHaveProperty('bs');
});

test('peer attachments are throttled and completed transfers stop sampling automatically', async ({ page }) => {
  await page.goto('./?connection-debug=1'); await page.clock.install();
  await page.evaluate(async () => {
    const diagnostics = await import('/src/connection-diagnostics.ts'), state = window as any;
    state.statsCalls = 0;
    const pc = { connectionState: 'connected', iceConnectionState: 'connected', getStats: async () => { state.statsCalls++; throw Error('stats unavailable'); } };
    state.input = { pc, role: 'sender', generation: 0, started: performance.now(), sent: 1000, acknowledged: 500, received: 0, buffered: 500, queued: 0, window: 524288, sourceBytes: 1000, sourceMs: 10, sinkBytes: 0, sinkMs: 0, completed: false, stopped: false, recovering: false, hidden: false, peerHidden: false };
    state.diagnosticHandle = diagnostics.watchConnectionDiagnostics(() => state.input); state.report = diagnostics.connectionDiagnosticReport;
  });
  expect(await page.evaluate(() => (window as any).diagnosticHandle.packet())).toMatchObject({ v: 1, s: 1000, a: 500 });
  expect(await page.evaluate(() => (window as any).diagnosticHandle.packet())).toBeUndefined();
  await page.clock.fastForward(9000);
  expect(await page.evaluate(() => (window as any).diagnosticHandle.packet())).toBeUndefined();
  await page.clock.fastForward(1000);
  expect(await page.evaluate(() => (window as any).diagnosticHandle.packet())).toBeDefined();
  await page.evaluate(() => { (window as any).input.completed = true; (window as any).input.acknowledged = 1000; });
  await page.clock.fastForward(1000);
  const final = await page.evaluate(() => ({ report: (window as any).report(), calls: (window as any).statsCalls }));
  expect(final.report.traces[0]).toMatchObject({ ended: true });
  expect(final.report.traces[0].samples.at(-1)).toMatchObject({ completed: 1, confirmed: 1000 });
  await page.clock.fastForward(10000);
  expect(await page.evaluate(() => ({ report: (window as any).report(), calls: (window as any).statsCalls }))).toEqual(final);
  expect(await page.evaluate(() => (window as any).diagnosticHandle.packet())).toBeUndefined();
});

test('history is bounded, stale connections cannot overwrite current stats, and closing stops sampling', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('./?connection-debug=1');
  await page.clock.install();
  await page.evaluate(async () => {
    const diagnostics = await import('/src/connection-diagnostics.ts');
    const state = window as any;
    const report = (protocol: string, rtt: number) => new Map([
      ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
      ['pair', { type: 'candidate-pair', localCandidateId: 'local', currentRoundTripTime: rtt }],
      ['local', { type: 'local-candidate', protocol }]
    ]);
    const old = { connectionState: 'connected', iceConnectionState: 'connected', getStats: () => new Promise(resolve => { state.resolveOld = () => resolve(report('tcp', 9)); }) };
    state.input = { pc: old, role: 'sender', generation: 0, started: performance.now(), sent: 1000, acknowledged: 500, received: 0, buffered: 500, queued: 0, window: 524288, sourceBytes: 1000, sourceMs: 10, sinkBytes: 0, sinkMs: 0, completed: false, stopped: false, recovering: false, hidden: false, peerHidden: false };
    state.diagnosticHandle = diagnostics.watchConnectionDiagnostics(() => state.input);
    state.nextPeer = { connectionState: 'connected', iceConnectionState: 'connected', getStats: async () => report('udp', 0.04) };
    state.report = diagnostics.connectionDiagnosticReport;
  });
  await page.clock.fastForward(1000);
  await expect.poll(() => page.evaluate(() => typeof (window as any).resolveOld)).toBe('function');
  await page.evaluate(() => { (window as any).input.pc = (window as any).nextPeer; (window as any).input.generation++; });
  await page.clock.fastForward(1000);
  await page.evaluate(() => (window as any).resolveOld());
  await page.clock.fastForward(1000);
  const latest = await page.evaluate(() => (window as any).report().traces[0].samples.at(-1));
  expect(latest).toMatchObject({ generation: 1, protocol: 'udp', stunRoundTripMs: 40 });
  for (let i = 0; i < 125; i++) await page.clock.fastForward(1000);
  expect(await page.evaluate(() => (window as any).report().traces[0].samples.length)).toBe(120);
  await page.evaluate(() => (window as any).diagnosticHandle.close());
  const closed = await page.evaluate(() => (window as any).report());
  await page.clock.fastForward(5000);
  expect(await page.evaluate(() => (window as any).report())).toEqual(closed);
  expect(errors).toEqual([]);
});

test('diagnostic history cannot grow with repeated recipients or sessions', async ({ page }) => {
  await page.goto('./?connection-debug=1');
  const result = await page.evaluate(async () => {
    const diagnostics = await import('/src/connection-diagnostics.ts');
    const pc = { connectionState: 'closed', iceConnectionState: 'closed' };
    const input = { pc, role: 'receiver', generation: 0, started: 0, sent: 0, acknowledged: 0, received: 0, buffered: 0, queued: 0, window: 524288, sourceBytes: 0, sourceMs: 0, sinkBytes: 0, sinkMs: 0, completed: false, stopped: false, recovering: false, hidden: false, peerHidden: false } as any;
    const handles = Array.from({ length: 12 }, () => diagnostics.watchConnectionDiagnostics(() => input)!);
    const refused = !diagnostics.watchConnectionDiagnostics(() => input);
    handles[0].close();
    const replacement = diagnostics.watchConnectionDiagnostics(() => input)!;
    const report = diagnostics.connectionDiagnosticReport();
    for (const handle of handles) handle.close(); replacement.close();
    return { refused, count: report.traces.length, first: report.traces[0].id, last: report.traces.at(-1)!.id };
  });
  expect(result).toEqual({ refused: true, count: 12, first: 2, last: 13 });
});

test.describe('English diagnostics', () => {
  test.use({ locale: 'en-US', viewport: { width: 320, height: 740 } });
  test('the local export is translated, fits narrow screens, and contains only the diagnostic report', async ({ page }) => {
    await page.goto('./?connection-debug=1');
    const panel = page.locator('#connection-diagnostics');
    await expect(panel.locator('summary')).toContainText('Connection diagnostics');
    await panel.locator('summary').click();
    await expect(panel.locator('p')).toContainText('not uploaded to a server');
    const pending = page.waitForEvent('download'); await panel.getByRole('button', { name: 'Export diagnostics' }).click();
    const download = await pending;
    expect(download.suggestedFilename()).toBe('pizzasend-connection-report.json');
    expect(JSON.parse(await readFile((await download.path())!, 'utf8'))).toEqual({ schema: 1, enabled: true, intervalMs: 1000, maxSamples: 120, traces: [] });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator('#language-toggle').click(); await expect(panel.locator('summary')).toContainText('连接诊断');
  });
});

for (const mode of ['both', 'sender-only', 'ordinary']) test(`real file integrity and heartbeat compatibility with diagnostics ${mode}`, async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'This WebKit runner has no real DataChannel; the pure and lifecycle checks above run in both engines.');
  await context.addInitScript(() => {
    localStorage.setItem('pizza-send-signal', 'http://127.0.0.1:8787'); localStorage.setItem('pizza-send-stun', '');
    Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined });
    const state = window as any, read = Blob.prototype.arrayBuffer, send = RTCDataChannel.prototype.send;
    state.diagnosticPackets = [];
    Blob.prototype.arrayBuffer = async function() { if (this.size <= 32768) await new Promise(resolve => setTimeout(resolve, 9)); return read.call(this); };
    RTCDataChannel.prototype.send = function(data: any) {
      if (typeof data === 'string') { const packet = JSON.parse(data); if (packet.type === 'ping' || packet.type === 'pong') state.diagnosticPackets.push(packet); }
      return send.call(this, data);
    } as any;
    void navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => stream.getTracks().forEach(track => track.stop()));
  });
  const errors: string[] = [], receiver = await context.newPage(), original = Buffer.alloc(16 * 1048576, 87);
  for (const target of [page, receiver]) target.on('pageerror', error => errors.push(error.message));
  await page.goto(mode === 'ordinary' ? './' : './?connection-debug=1');
  await page.locator('#file-input').setInputFiles({ name: 'do-not-retain-this-name.bin', mimeType: 'application/octet-stream', buffer: original });
  await page.locator('#start-send').click(); await expect(page.locator('#share-box')).toBeVisible();
  const share = new URL(await page.locator('#share-link').inputValue());
  expect(share.searchParams.has('connection-debug')).toBe(mode !== 'ordinary');
  if (mode === 'sender-only') share.search = '';
  await receiver.goto(share.href); await expect(receiver.locator('#accept-files')).toBeVisible(); await receiver.locator('#accept-files').click();
  await expect(receiver.locator('#status')).toHaveText('文件已收到，请保存到设备');
  await expect(page.locator('#status')).toHaveText('传输完成，原样送达。');
  const pending = receiver.waitForEvent('download'); await receiver.locator('.download-file').click();
  const download = await pending, actual = await readFile((await download.path())!);
  expect(download.suggestedFilename()).toBe('do-not-retain-this-name.bin');
  expect(createHash('sha256').update(actual).digest('hex')).toBe(createHash('sha256').update(original).digest('hex'));
  for (const [target, enabled] of [[page, mode !== 'ordinary'], [receiver, mode === 'both']] as const) {
    if (enabled) await expect.poll(() => target.evaluate(async () => (await import('/src/connection-diagnostics.ts')).connectionDiagnosticReport().traces[0]?.samples.at(-1)?.completed)).toBe(1);
    const report = await target.evaluate(async () => (await import('/src/connection-diagnostics.ts')).connectionDiagnosticReport());
    expect(report.enabled).toBe(enabled);
    expect(await target.locator('#connection-diagnostics').count()).toBe(enabled ? 1 : 0);
    expect(JSON.stringify(report)).not.toContain('do-not-retain-this-name');
    expect(JSON.stringify(report)).not.toContain(share.hash.slice(1));
    const packets = await target.evaluate(() => (window as any).diagnosticPackets);
    expect(packets.length).toBeGreaterThan(0);
    if (enabled) {
      expect(report.traces[0].samples.at(-1)?.confirmed).toBe(original.length);
      expect(packets.some((packet: any) => packet.metrics)).toBe(true);
      if (mode === 'both') expect(report.traces[0].peer).toBeDefined();
      else expect(report.traces[0].peer).toBeUndefined();
    } else { expect(report.traces).toEqual([]); expect(packets.every((packet: any) => !packet.metrics)).toBe(true); }
  }
  expect(errors).toEqual([]);
  await page.locator('#cancel').click();
});
