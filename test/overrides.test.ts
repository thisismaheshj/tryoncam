import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';

process.env.VTON_SKIP_DOTENV = '1';
process.env.CONFIG_ENCRYPTION_KEY = 'k'.repeat(64);
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_fromvercel0000';
process.env.MAX_CONCURRENT = '2';
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.KV_REST_API_URL;

const { config } = await import('../src/config.js');
const overrides = await import('../src/overrides.js');
const { FileStore } = await import('../src/store/file.js');
const { setStore, getStore } = await import('../src/store/index.js');

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'vton-env-'));
after(() => rmSync(tmpDir, { recursive: true, force: true }));

beforeEach(async () => {
  const dir = mkdtempSync(path.join(tmpDir, 'case-'));
  setStore(new FileStore(path.join(dir, 'ledger.jsonl'), path.join(dir, 'settings.json')));
  process.env.CONFIG_ENCRYPTION_KEY = 'k'.repeat(64);
  await overrides.refreshOverrides();
});

describe('overriding a value', () => {
  test('a saved number takes effect, and clearing it returns to Vercel', async () => {
    assert.equal(config.session.maxConcurrent, 2);
    await overrides.setOverride('MAX_CONCURRENT', 5, 'owner@example.com');
    assert.equal(config.session.maxConcurrent, 5);

    await overrides.clearOverride('MAX_CONCURRENT', 'owner@example.com');
    assert.equal(config.session.maxConcurrent, 2);

    const audit = overrides.describeEnvironment().audit;
    assert.deepEqual(audit.map((a) => a.action), ['cleared', 'set'], 'both changes logged, newest first');
    assert.equal(audit[1]!.by, 'owner@example.com');
  });

  test('out-of-range numbers are refused', async () => {
    await assert.rejects(overrides.setOverride('MAX_CONCURRENT', 0, 'a@x.com'), /between/);
    await assert.rejects(overrides.setOverride('MAX_CONCURRENT', 2.5, 'a@x.com'), /whole number/);
  });

  test('a key that fails its check is not saved', async () => {
    await assert.rejects(overrides.setOverride('STRIPE_WEBHOOK_SECRET', 'not-a-secret', 'a@x.com'), /whsec_/);
    assert.equal(config.stripe.webhookSecret, 'whsec_fromvercel0000', 'the live value is untouched');
  });

  test('only listed variables can be changed', async () => {
    await assert.rejects(overrides.setOverride('SESSION_SECRET', 'x', 'a@x.com'), /cannot be changed here/);
  });
});

describe('secrets', () => {
  test('are stored encrypted, applied live, and shown only as a hint', async () => {
    const secret = 'whsec_brandnewsecret9876';
    await overrides.setOverride('STRIPE_WEBHOOK_SECRET', secret, 'owner@example.com');
    assert.equal(config.stripe.webhookSecret, secret);

    const onDisk = JSON.stringify(await getStore().overrides());
    assert.ok(!onDisk.includes('brandnewsecret'), 'plaintext never reaches the store');

    const row = overrides.describeEnvironment().values.find((v) => v.name === 'STRIPE_WEBHOOK_SECRET')!;
    assert.equal(row.hint, 'whsec_…9876');
    assert.equal(row.value, null, 'a secret has no value field');
    assert.equal(row.source, 'dashboard');
  });

  test('a server without the right encryption key falls back to its own value', async () => {
    await overrides.setOverride('STRIPE_WEBHOOK_SECRET', 'whsec_savedelsewhere1111', 'owner@example.com');
    process.env.CONFIG_ENCRYPTION_KEY = 'z'.repeat(64);
    await overrides.refreshOverrides();

    assert.equal(config.stripe.webhookSecret, 'whsec_fromvercel0000');
    const row = overrides.describeEnvironment().values.find((v) => v.name === 'STRIPE_WEBHOOK_SECRET')!;
    assert.equal(row.unreadable, true);
  });

  test('a sealed value cannot be moved to another variable', async () => {
    await overrides.setOverride('STRIPE_WEBHOOK_SECRET', 'whsec_boundtoitsname2222', 'owner@example.com');
    const stored = (await getStore().overrides()) as { values: Record<string, unknown> };
    // Copy the ciphertext under a different name, as someone with store access might.
    stored.values.DECART_API_KEY = stored.values.STRIPE_WEBHOOK_SECRET;
    await getStore().saveOverrides(stored);
    await overrides.refreshOverrides();

    assert.notEqual(config.decart.apiKey, 'whsec_boundtoitsname2222');
    assert.equal(overrides.describeEnvironment().values.find((v) => v.name === 'DECART_API_KEY')!.unreadable, true);
  });

  test('nothing can be saved without an encryption key', async () => {
    delete process.env.CONFIG_ENCRYPTION_KEY;
    await assert.rejects(overrides.setOverride('MAX_CONCURRENT', 3, 'a@x.com'), /CONFIG_ENCRYPTION_KEY/);
  });

  test('the file store keeps overrides readable only by its owner', async () => {
    const dir = mkdtempSync(path.join(tmpDir, 'perm-'));
    const store = new FileStore(path.join(dir, 'l.jsonl'), path.join(dir, 's.json'));
    await store.saveOverrides({ values: {}, audit: [] });
    assert.equal(statSync(path.join(dir, 'overrides.json')).mode & 0o777, 0o600);
  });
});

describe('masking', () => {
  test('keeps the prefix and last four only', () => {
    assert.equal(overrides.maskSecret('rk_live_51Habcdefghijklmnop1234'), 'rk_live_…1234');
    assert.equal(overrides.maskSecret('sb_secret_abcdefghijklmn5678'), 'sb_secret_…5678');
    assert.equal(overrides.maskSecret('dct_abcdefghijklmnopqrstuvwxyz9999'), 'dct_…9999');
    assert.equal(overrides.maskSecret('sk_test_short'), 'sk_test_…', 'too short to show any of it');
  });
});

describe('settings migration', () => {
  test('a category list saved before headwear existed gains it once', async () => {
    const { refreshSettings, writeSettings } = await import('../src/settings.js');
    await getStore().saveSettings({ discovery: { mode: 'garments', wearableCategories: ['top', 'dress'] } } as never);
    const first = await refreshSettings();
    assert.deepEqual(first.discovery.wearableCategories, ['top', 'dress', 'headwear']);

    // Unticking it afterwards sticks.
    await writeSettings({ discovery: { wearableCategories: ['top', 'dress'] } });
    const second = await refreshSettings();
    assert.deepEqual(second.discovery.wearableCategories, ['top', 'dress']);
  });
});
