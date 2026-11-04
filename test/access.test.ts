import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

// Config freezes env at import, so every knob is set first. No database and no
// Stripe: these tests are about who may call what, not what the calls do.
process.env.VTON_SKIP_DOTENV = '1';
process.env.DASHBOARD_PASSWORD = 'test-password';
process.env.SESSION_SECRET = 'test-secret';
process.env.GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
process.env.ADMIN_EMAILS = 'owner@example.com';
process.env.CONFIG_ENCRYPTION_KEY = 'e'.repeat(64);
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SECRET_KEY;
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.KV_REST_API_URL;

const { app } = await import('../src/server.js');
const { issueGateToken, issueSessionToken } = await import('../src/auth.js');
const { FileStore } = await import('../src/store/file.js');
const { setStore } = await import('../src/store/index.js');

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'vton-access-'));
setStore(new FileStore(path.join(tmpDir, 'ledger.jsonl'), path.join(tmpDir, 'settings.json')));

const person = (email: string) => ({ sub: `sub-${email}`, email, emailVerified: true, name: email, picture: '' });
const admin = issueSessionToken(person('owner@example.com'));
const customer = issueSessionToken(person('shopper@example.com'));

let base = '';
let server: ReturnType<typeof app.listen>;
before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function call(pathname: string, init: { method?: string; bearer?: string; cookie?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (init.bearer) headers.Authorization = `Bearer ${init.bearer}`;
  if (init.cookie) headers.Cookie = init.cookie;
  const response = await fetch(base + pathname, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const body = (await response.json().catch(() => ({}))) as { reason?: string };
  return { status: response.status, reason: body.reason };
}

describe('operator paths', () => {
  test('refuse a caller with no credentials, offering the password', async () => {
    const result = await call('/api/analytics');
    assert.equal(result.status, 401);
    assert.equal(result.reason, 'gate');
  });

  test('refuse a signed-in customer outright', async () => {
    // The bug this guards against: any Google sign-in used to pass the gate.
    for (const pathname of ['/api/analytics', '/api/admin/settings', '/api/admin/users', '/api/state']) {
      const result = await call(pathname, { bearer: customer });
      assert.equal(result.status, 403, pathname);
      assert.equal(result.reason, 'not_admin', pathname);
    }
  });

  test('admit an admin Google account', async () => {
    assert.equal((await call('/api/analytics', { bearer: admin })).status, 200);
  });

  test('admit the password cookie', async () => {
    const cookie = `vton_gate=${issueGateToken('test-password')}`;
    assert.equal((await call('/api/analytics', { cookie })).status, 200);
  });

  test('refuse a cookie minted under a different password', async () => {
    const cookie = `vton_gate=${issueGateToken('an-old-password')}`;
    assert.equal((await call('/api/analytics', { cookie })).status, 401);
  });
});

describe('customer paths', () => {
  test('ask a signed-out caller to sign in, not for a password', async () => {
    const result = await call('/api/session', { method: 'POST', body: { garmentUrl: 'https://x.test/a.jpg' } });
    assert.equal(result.status, 401);
    assert.equal(result.reason, 'unauthenticated');
  });

  test('admit a signed-in customer', async () => {
    assert.equal((await call('/api/billing/me', { bearer: customer })).status, 200);
  });

  test('a password-gate token is not a sign-in', async () => {
    // Both token kinds share a signing key; only the type field tells them apart.
    const result = await call('/api/billing/me', { bearer: issueGateToken('test-password') });
    assert.equal(result.status, 401);
  });

  test('a customer cannot extend a session for free seconds', async () => {
    const result = await call('/api/session/anything/extend', { method: 'POST', bearer: customer });
    assert.equal(result.status, 403);
  });
});

describe('public paths', () => {
  test('stay open', async () => {
    for (const pathname of ['/api/health', '/api/settings', '/api/auth/me', '/api/billing/plans']) {
      assert.equal((await call(pathname)).status, 200, pathname);
    }
  });

  test('the Stripe webhook refuses an unsigned body rather than trusting it', async () => {
    const response = await fetch(`${base}/api/stripe/webhook`, { method: 'POST', body: '{"type":"invoice.paid"}' });
    assert.notEqual(response.status, 200);
  });
});

describe('environment controls', () => {
  test('the shared password can view keys but not change them', async () => {
    const cookie = `vton_gate=${issueGateToken('test-password')}`;
    assert.equal((await call('/api/admin/env', { cookie })).status, 200);
    const change = await call('/api/admin/env/MAX_CONCURRENT', { method: 'PUT', cookie, body: { value: 3 } });
    assert.equal(change.status, 403);
    assert.equal(change.reason, 'google_required');
  });

  test('an admin Google account can change them', async () => {
    const change = await call('/api/admin/env/MAX_CONCURRENT', { method: 'PUT', bearer: admin, body: { value: 3 } });
    assert.equal(change.status, 200);
    assert.equal((await call('/api/admin/env/MAX_CONCURRENT', { method: 'DELETE', bearer: admin })).status, 200);
  });

  test('a customer cannot even view them', async () => {
    assert.equal((await call('/api/admin/env', { bearer: customer })).status, 403);
  });

  test('no response ever carries a secret value', async () => {
    const response = await fetch(`${base}/api/admin/env`, { headers: { Authorization: `Bearer ${admin}` } });
    const body = (await response.json()) as { values: { kind: string; value: unknown }[] };
    for (const item of body.values.filter((v) => v.kind === 'secret')) assert.equal(item.value, null);
  });
});

describe('account page and public pricing', () => {
  test('a signed-in customer reaches their account; nobody else does', async () => {
    assert.equal((await call('/api/account', { bearer: customer })).status, 200);
    assert.equal((await call('/api/account')).status, 401);
    // The dashboard password has no account behind it: a clean refusal, not a crash.
    const cookie = `vton_gate=${issueGateToken('test-password')}`;
    const viaPassword = await call('/api/account', { cookie });
    assert.equal(viaPassword.status, 401);
    assert.equal(viaPassword.reason, 'unauthenticated');
  });

  test('the extension hands its session to the account page, and only a valid one', async () => {
    const good = await fetch(`${base}/api/auth/handoff`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: customer }),
    });
    assert.equal(good.status, 200);
    assert.match(good.headers.get('set-cookie') ?? '', /vton_session=.*HttpOnly/);
    const forged = await call('/api/auth/handoff', { method: 'POST', body: { token: issueGateToken('test-password') } });
    assert.equal(forged.status, 401, 'a gate token is not a sign-in, here either');
  });

  test('pricing is public, and readable by tryoncam.com only', async () => {
    const fromSite = await fetch(`${base}/api/public/pricing`, { headers: { Origin: 'https://tryoncam.com' } });
    assert.equal(fromSite.status, 200);
    assert.equal(fromSite.headers.get('access-control-allow-origin'), 'https://tryoncam.com');
    const body = (await fromSite.json()) as { copy: { heading: string }; freeCredits: number };
    assert.ok(body.copy.heading.length > 0);
    assert.equal(typeof body.freeCredits, 'number');

    const elsewhere = await fetch(`${base}/api/public/pricing`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(elsewhere.headers.get('access-control-allow-origin'), null);
  });

  test('user list is operators only', async () => {
    assert.equal((await call('/api/admin/users', { bearer: customer })).status, 403);
    assert.equal((await call('/api/admin/users', { bearer: admin })).status, 200);
  });
});
