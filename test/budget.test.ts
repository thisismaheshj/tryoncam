import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

// Config is frozen at import time, so every knob must be set before the
// modules under test are pulled in.
process.env.VTON_SKIP_DOTENV = '1';
process.env.DECART_API_KEY = 'dct_test_key';
process.env.VIDU_API_KEY = 'vda_test_key';
process.env.DECART_BUDGET_SECONDS = '100';
process.env.VIDU_BUDGET_SECONDS = '200';
process.env.DECART_USD_PER_SECOND = '0.02';
process.env.VIDU_USD_PER_SECOND = '0.005';
process.env.MAX_SESSION_SECONDS = '60';
process.env.MAX_CONCURRENT = '2';
process.env.MAX_SESSION_EXTENSIONS = '3';
process.env.EXTENSION_SECONDS = '15';
process.env.CONNECT_WINDOW_SECONDS = '45';
process.env.KILL_SWITCH = 'false';

const { SessionGuard } = await import('../src/budget.js');
const { Ledger } = await import('../src/ledger.js');
const { runtime } = await import('../src/config.js');
const { FileStore } = await import('../src/store/file.js');
const { setStore } = await import('../src/store/index.js');

let tmpDir: string;
let clock: number;

/** A guard over a throwaway store, with a clock the test drives by hand. */
function makeGuard() {
  return new SessionGuard(new Ledger(), () => clock);
}

function reserve(guard: ReturnType<typeof makeGuard>, id: string, seconds: number, provider: 'decart' | 'vidu' = 'decart') {
  return guard.reserve({ sessionId: id, provider, model: 'test-model', seconds, garmentUrl: null });
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'vton-store-'));
  setStore(new FileStore(path.join(tmpDir, 'ledger.jsonl'), path.join(tmpDir, 'settings.json'), () => clock));
  clock = 1_700_000_000_000;
  runtime.killSwitch = false;
});

afterEach(() => {
  setStore(null);
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('budget boundary', () => {
  test('allows a session that exactly consumes the remaining budget', async () => {
    const guard = makeGuard();
    assert.equal(await guard.remainingSeconds('decart'), 100);
    assert.equal((await reserve(guard, 's1', 100)).ok, true);
  });

  test('refuses one second past the budget', async () => {
    const result = await reserve(makeGuard(), 's1', 101);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'budget_exhausted');
  });

  test('spent seconds reduce what is available, to the second', async () => {
    const guard = makeGuard();
    await reserve(guard, 's1', 15);
    await guard.markStarted('s1');
    await guard.release('s1', { billedSeconds: 15 });

    assert.equal(await guard.remainingSeconds('decart'), 85);
    assert.equal((await reserve(guard, 's2', 85)).ok, true);
    await guard.release('s2');
    assert.equal((await reserve(guard, 's3', 86)).ok, false);
  });

  test('budgets are tracked per provider and do not bleed across', async () => {
    const guard = makeGuard();
    await reserve(guard, 's1', 50);
    await guard.markStarted('s1');
    await guard.release('s1', { billedSeconds: 50 });

    assert.equal(await guard.remainingSeconds('decart'), 50);
    assert.equal(await guard.remainingSeconds('vidu'), 200, 'Vidu budget must be untouched');
  });

  test('an in-flight reservation is held against the budget immediately', async () => {
    const guard = makeGuard();
    // Without reservation accounting both 60s sessions would see a 100s
    // budget and both be admitted, overspending by 20s.
    assert.equal((await reserve(guard, 's1', 60)).ok, true);
    assert.equal(await guard.remainingSeconds('decart'), 40);

    const second = await reserve(guard, 's2', 60);
    assert.equal(second.ok, false);
    assert.equal(second.ok === false && second.reason, 'budget_exhausted');
  });

  test('releasing for less than reserved returns the difference', async () => {
    const guard = makeGuard();
    await reserve(guard, 's1', 15);
    await guard.markStarted('s1');
    assert.equal(await guard.remainingSeconds('decart'), 85);

    await guard.release('s1', { billedSeconds: 4 });
    assert.equal(await guard.remainingSeconds('decart'), 96);
  });
});

describe('kill switch', () => {
  test('refuses every provider while on', async () => {
    const guard = makeGuard();
    runtime.killSwitch = true;
    for (const provider of ['decart', 'vidu'] as const) {
      const result = await reserve(guard, 'x-' + provider, 1, provider);
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.reason, 'kill_switch');
    }
  });

  test('blocks extending a session that is already live', async () => {
    const guard = makeGuard();
    await reserve(guard, 's1', 15);
    await guard.markStarted('s1');
    runtime.killSwitch = true;

    const result = await guard.extend('s1', 15);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'kill_switch');
  });
});

describe('concurrency counting', () => {
  test('increments to the limit then refuses', async () => {
    const guard = makeGuard();
    await reserve(guard, 's1', 5);
    await reserve(guard, 's2', 5);
    assert.equal(await guard.activeCount(), 2);

    const third = await reserve(guard, 's3', 5);
    assert.equal(third.ok, false);
    assert.equal(third.ok === false && third.reason, 'concurrency_limit');
  });

  test('decrements on release, freeing the slot', async () => {
    const guard = makeGuard();
    await reserve(guard, 's1', 5);
    await reserve(guard, 's2', 5);
    await guard.release('s1', { billedSeconds: 5 });

    assert.equal(await guard.activeCount(), 1);
    assert.equal((await reserve(guard, 's3', 5)).ok, true);
  });

  test('counts across providers, because the limit is on our backend', async () => {
    const guard = makeGuard();
    await reserve(guard, 's1', 5, 'decart');
    await reserve(guard, 's2', 5, 'vidu');
    assert.equal(await guard.activeCount(), 2);
    assert.equal((await reserve(guard, 's3', 5, 'vidu')).ok, false);
  });

  test('a double release does not decrement twice', async () => {
    const guard = makeGuard();
    await reserve(guard, 's1', 5);
    await reserve(guard, 's2', 5);

    assert.ok(await guard.release('s1', { billedSeconds: 5 }));
    assert.equal(await guard.release('s1', { billedSeconds: 5 }), null, 'second release is a no-op');
    assert.equal(await guard.activeCount(), 1);
    assert.equal((await new Ledger().entries()).length, 1, 'one ledger line for one session');
  });
});

describe('abnormal termination', () => {
  test('a session that never connected is swept and billed nothing', async () => {
    const guard = makeGuard();
    await reserve(guard, 's1', 15);

    clock += (45 + 15 + 30 + 1) * 1000;
    const swept = await guard.sweep();

    assert.equal(swept.length, 1);
    assert.equal(swept[0]?.billedSeconds, 0);
    assert.equal(swept[0]?.status, 'aborted');
    assert.equal(await guard.activeCount(), 0, 'slot must be freed');
    assert.equal(await guard.remainingSeconds('decart'), 100, 'budget fully restored');
  });

  test('a live session whose client vanished is charged the full grant', async () => {
    const guard = makeGuard();
    await reserve(guard, 's1', 15);
    await guard.markStarted('s1');

    clock += (15 + 30 + 1) * 1000;
    const swept = await guard.sweep();

    assert.equal(swept.length, 1);
    assert.equal(swept[0]?.billedSeconds, 15, 'assume the worst case, never zero');
    assert.equal(swept[0]?.estimated, true);
    assert.equal(await guard.remainingSeconds('decart'), 85);
  });

  test('sweeping frees the concurrency slot for a new session', async () => {
    const guard = makeGuard();
    await reserve(guard, 's1', 5);
    await reserve(guard, 's2', 5);
    assert.equal((await reserve(guard, 's3', 5)).ok, false);

    clock += (45 + 5 + 30 + 1) * 1000;
    assert.equal((await reserve(guard, 's4', 5)).ok, true);
  });

  test('release without a provider figure falls back to the measured clock', async () => {
    const guard = makeGuard();
    await reserve(guard, 's1', 15);
    await guard.markStarted('s1');
    clock += 7_000;

    const entry = await guard.release('s1');
    assert.equal(entry?.billedSeconds, 7);
    assert.equal(entry?.estimated, true, 'a locally measured figure must be marked estimated');
  });

  test('a fallback figure can never exceed what was granted', async () => {
    const guard = makeGuard();
    await reserve(guard, 's1', 15);
    await guard.markStarted('s1');
    clock += 600_000; // the machine slept

    assert.equal((await guard.release('s1'))?.billedSeconds, 15);
  });
});

describe('extensions', () => {
  test('adds seconds and holds them against the budget', async () => {
    const guard = makeGuard();
    await reserve(guard, 's1', 15);
    await guard.markStarted('s1');

    const result = await guard.extend('s1', 15);
    assert.equal(result.ok, true);
    assert.equal(result.totalSeconds, 30);
    assert.equal(await guard.remainingSeconds('decart'), 70);
  });

  test('refuses beyond MAX_SESSION_EXTENSIONS', async () => {
    const guard = makeGuard();
    await reserve(guard, 's1', 15);
    await guard.markStarted('s1');
    for (let i = 0; i < 3; i += 1) assert.equal((await guard.extend('s1', 5)).ok, true);

    const fourth = await guard.extend('s1', 5);
    assert.equal(fourth.ok, false);
    assert.equal(fourth.ok === false && fourth.reason, 'extension_limit');
  });

  test('refuses an extension the budget cannot cover', async () => {
    const guard = makeGuard();
    await reserve(guard, 's1', 95);
    await guard.markStarted('s1');

    const result = await guard.extend('s1', 15);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'budget_exhausted');
  });

  test('an unknown session cannot be extended', async () => {
    const result = await makeGuard().extend('nope', 15);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'session_unknown');
  });
});

describe('ledger arithmetic', () => {
  test('dollars follow the provider rate', async () => {
    const guard = makeGuard();
    await reserve(guard, 's1', 15);
    await guard.markStarted('s1');
    await guard.release('s1', { billedSeconds: 10 });

    assert.equal(await new Ledger().spentUsd('decart'), 0.2); // 10 x $0.02
  });
});

describe('after-release hook', () => {
  test('fires for a clean release and for a timeout, with the start state', async () => {
    const seen: { id: string; started: boolean }[] = [];
    const guard = new SessionGuard(new Ledger(), () => clock, async (entry) => {
      seen.push({ id: entry.id, started: entry.startedAt !== null });
    });

    await reserve(guard, 'clean', 15);
    await guard.markStarted('clean');
    await guard.release('clean', { billedSeconds: 5 });

    await reserve(guard, 'vanished', 15);
    clock += (45 + 15 + 30 + 1) * 1000;
    await guard.sweep();

    assert.deepEqual(seen, [
      { id: 'clean', started: true },
      { id: 'vanished', started: false },
    ]);
  });

  test('a reservation sweeps first, so a timed-out session is never dropped silently', async () => {
    // On serverless nothing sweeps between requests. Without this, the store's
    // own expiry discarded the lease with no ledger line and no refund.
    const released: string[] = [];
    const guard = new SessionGuard(new Ledger(), () => clock, async (entry) => {
      released.push(entry.id);
    });
    await reserve(guard, 'old', 15);
    await guard.markStarted('old');
    clock += (15 + 30 + 1) * 1000;

    assert.equal((await reserve(guard, 'new', 5)).ok, true);
    assert.deepEqual(released, ['old']);
    assert.equal(await guard.remainingSeconds('decart'), 100 - 15 - 5, 'the vanished session is charged its grant');
  });

  test('a failing hook does not fail the release', async () => {
    const guard = new SessionGuard(new Ledger(), () => clock, async () => {
      throw new Error('database down');
    });
    await reserve(guard, 's1', 15);
    const entry = await guard.release('s1', { billedSeconds: 0 });
    assert.ok(entry, 'the ledger line is still written and returned');
  });
});
