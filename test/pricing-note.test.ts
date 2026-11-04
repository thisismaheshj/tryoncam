import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

process.env.VTON_SKIP_DOTENV = '1';
const { renderPricingCopy } = await import('../src/settings.js');

const copy = {
  eyebrow: '', heading: '', lede: 'Sessions last {seconds}s.', showFree: true, freeName: '', freeNote: '',
  freeFeatures: [], freeCta: '', foot: [],
  note: '1 credit = 1 live session, up to {seconds} seconds, with unlimited garment swaps',
};

describe('pricing note', () => {
  test('shows the session length from the run controls', () => {
    const out = renderPricingCopy(copy, 20);
    assert.equal(out.note, '1 credit = 1 live session, up to 20 seconds, with unlimited garment swaps');
    assert.equal(out.lede, 'Sessions last 20s.');
  });

  test('leaves copy without the token alone, and does not change the stored record', () => {
    assert.equal(renderPricingCopy({ ...copy, note: 'Fixed words' }, 20).note, 'Fixed words');
    renderPricingCopy(copy, 30);
    assert.match(copy.note, /\{seconds\}/);
  });
});
