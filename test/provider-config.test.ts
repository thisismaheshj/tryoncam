import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

// This file deliberately leaves both keys unset, so it must run in its own
// module graph — config freezes env at import time.
process.env.VTON_SKIP_DOTENV = '1';
delete process.env.DECART_API_KEY;
delete process.env.VIDU_API_KEY;
process.env.DECART_BUDGET_SECONDS = '100';

const { SessionGuard } = await import('../src/budget.js');
const { Ledger } = await import('../src/ledger.js');
const { FileStore } = await import('../src/store/file.js');
const { setStore } = await import('../src/store/index.js');
const { DecartProvider } = await import('../src/providers/decart.js');
const { ViduProvider } = await import('../src/providers/vidu.js');

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'vton-cfg-'));
after(() => rmSync(tmpDir, { recursive: true, force: true }));

describe('provider configuration gating', () => {
  test('the guard refuses a provider with no API key', () => {
    setStore(new FileStore(path.join(tmpDir, 'l.jsonl'), path.join(tmpDir, 's.json')));
    const guard = new SessionGuard(new Ledger());
    for (const provider of ['decart', 'vidu'] as const) {
      // precheck answers the cheap refusals without touching the store.
      const decision = guard.precheck(provider);
      assert.equal(decision.ok, false, `${provider} must be refused without a key`);
      assert.equal(decision.ok === false && decision.reason, 'provider_unconfigured');
    }
    setStore(null);
  });

  test('Decart reports itself unconfigured but implemented', () => {
    const status = new DecartProvider().status();
    assert.equal(status.configured, false);
    assert.equal(status.implemented, true);
  });

  test('Vidu reports itself unimplemented until the control socket is wired', () => {
    const status = new ViduProvider().status();
    assert.equal(status.implemented, false, 'must not accept sessions it cannot stop');
  });

  test('creating a Decart session without a key throws rather than calling out', async () => {
    await assert.rejects(
      () =>
        new DecartProvider().createSession({
          sessionId: 'x',
          garmentUrl: 'https://example.com/g.png',
          prompt: 'p',
          maxSessionSeconds: 15,
        }),
      /DECART_API_KEY/,
    );
  });
});
