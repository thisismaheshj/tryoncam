import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

process.env.VTON_SKIP_DOTENV = '1';
const { cleanEmail, DEFAULT_SUPPORT_EMAIL } = await import('../src/settings.js');

describe('support email', () => {
  test('keeps a plain address, trimmed and lower-cased', () => {
    assert.equal(cleanEmail('  Help@OneManHoldings.com '), 'help@onemanholdings.com');
  });

  test('empty goes back to the default', () => {
    assert.equal(cleanEmail(''), DEFAULT_SUPPORT_EMAIL);
    assert.equal(cleanEmail(undefined), DEFAULT_SUPPORT_EMAIL);
  });

  test('refuses anything that is not just an address', () => {
    for (const bad of ['not an email', 'a@b', 'x@y.com?bcc=z@w.com', '<script>@x.com', 'a b@c.com']) {
      assert.throws(() => cleanEmail(bad), /not an email address/);
    }
  });
});
