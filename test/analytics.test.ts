import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

process.env.VTON_SKIP_DOTENV = '1';
process.env.DECART_API_KEY = 'dct_test_key';
process.env.DECART_BUDGET_SECONDS = '300';
process.env.DECART_USD_PER_SECOND = '0.02';
process.env.SESSION_SECONDS = '15';

const { overview, windowStart } = await import('../src/analytics.js');
const { Ledger } = await import('../src/ledger.js');
const { runtime } = await import('../src/config.js');
const { FileStore } = await import('../src/store/file.js');
const { setStore } = await import('../src/store/index.js');
const { readDecartCredits, cleanCookie } = await import('../src/decart-account.js');

const dir = mkdtempSync(path.join(os.tmpdir(), 'tryoncam-analytics-'));
after(() => rmSync(dir, { recursive: true, force: true }));
setStore(new FileStore(path.join(dir, 'ledger.jsonl'), path.join(dir, 'settings.json')));
runtime.sessionSeconds = 15;

const day = 86_400_000;
const entry = (daysAgo: number, billedSeconds: number) => ({
  id: `s${daysAgo}-${billedSeconds}`, provider: 'decart' as const, model: 'lucy-vton-3.5', status: 'completed' as const,
  startedAt: null, endedAt: new Date(Date.now() - daysAgo * day).toISOString(), grantedSeconds: 15, billedSeconds,
  estimated: true, usd: billedSeconds * 0.02, garmentUrl: null, user: null, timeToFirstFrameMs: null, note: null,
});

describe('dashboard figures', () => {
  test('totals cover the chosen days, not the whole ledger', async () => {
    const ledger = new Ledger();
    await ledger.append(entry(0, 10)); // today
    await ledger.append(entry(40, 15)); // outside a 14-day window
    const o = await overview(ledger, 14);
    assert.equal(o.totals.sessions, 1);
    assert.equal(o.totals.billedSeconds, 10);
    assert.equal(o.totals.spentUsd, 0.2);
    assert.equal(o.totals.credits, 20, 'Decart credits: $0.20 at $0.01 each');
    // The charts and the tiles agree.
    assert.equal(o.series.reduce((sum, d) => sum + d.sessions, 0), o.totals.sessions);
    // The spending cap still counts every second ever billed.
    assert.equal(o.providers.find((p) => p.id === 'decart')!.billedSeconds, 25);
  });

  test('a session is priced at its full length in Decart credits', async () => {
    const o = await overview(new Ledger(), 14);
    assert.equal(o.account.rate.creditsPerSecond, 2);
    assert.equal(o.account.rate.creditsPerSession, 30);
    assert.equal(o.account.decart.status, 'not_connected');
    // 300s cap − 25s spent = 275s → 18 full 15s sessions.
    assert.equal(o.account.runway.capSessions, 18);
    assert.equal(o.account.runway.sessions, 18, 'with no balance, the cap is the runway');
  });

  test('the window starts at midnight, days − 1 days ago', () => {
    const start = windowStart(7, new Date('2026-09-26T15:30:00'));
    assert.equal(start.getDate(), 20);
    assert.equal(start.getHours(), 0);
  });
});

describe('reading the Decart balance', () => {
  const realFetch = globalThis.fetch;
  after(() => { globalThis.fetch = realFetch; });

  test('a pasted "Cookie:" header is cleaned', () => {
    assert.equal(cleanCookie('Cookie: a=1; b=2\n'), 'a=1; b=2');
  });

  test('reads currentCredits, sending the session and nothing else', async () => {
    let sent: RequestInit | undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      sent = init;
      return new Response(JSON.stringify({ currentCredits: 12345, transactions: [] }), { status: 200 });
    }) as typeof fetch;
    assert.equal(await readDecartCredits('session=abc'), 12345);
    assert.equal((sent?.headers as Record<string, string>).Cookie, 'session=abc');
    assert.equal(sent?.method ?? 'GET', 'GET');
  });

  test('an expired session says so', async () => {
    globalThis.fetch = (async () => new Response('{"error":"Authentication required"}', { status: 401 })) as typeof fetch;
    await assert.rejects(readDecartCredits('session=old'), /paste a fresh Cookie/);
  });

  test('something that is not a cookie is refused before any request', async () => {
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response('{}'); }) as typeof fetch;
    await assert.rejects(readDecartCredits('just-a-token'), /not a Cookie header/);
    assert.equal(called, false);
  });
});
