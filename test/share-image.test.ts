import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

process.env.VTON_SKIP_DOTENV = '1';
const { cleanShareImage, shareImageUrl, SHARE_IMAGES } = await import('../src/settings.js');

describe('link preview image', () => {
  test('offers six designs, each at a tryoncam.com address', () => {
    assert.equal(SHARE_IMAGES.length, 6);
    for (const image of SHARE_IMAGES) assert.match(image.url, /^https:\/\/tryoncam\.com\/assets\/og\/og-[a-f]\.jpg$/);
  });

  test('a design id, or an https image link, is kept', () => {
    assert.equal(cleanShareImage('og-c'), 'og-c');
    assert.equal(cleanShareImage(' https://cdn.example.com/card.png '), 'https://cdn.example.com/card.png');
    assert.equal(cleanShareImage(''), 'og-a');
  });

  test('anything else is refused', () => {
    assert.throws(() => cleanShareImage('http://example.com/a.png'), /https link/);
    assert.throws(() => cleanShareImage('og-z'), /https link/);
    assert.throws(() => cleanShareImage('javascript:alert(1)'), /https link/);
  });

  test('resolves the choice to the address crawlers fetch', () => {
    assert.equal(shareImageUrl('og-e'), 'https://tryoncam.com/assets/og/og-e.jpg');
    assert.equal(shareImageUrl('https://cdn.example.com/card.png'), 'https://cdn.example.com/card.png');
    assert.equal(shareImageUrl('nonsense'), 'https://tryoncam.com/assets/og/og-a.jpg');
  });
});
