import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

process.env.VTON_SKIP_DOTENV = '1';
const { cleanSite, mergeSite, renderSiteContent, SITE_DEFAULTS, DEFAULT_CHROME_STORE } = await import('../src/site-content.js');
const { cleanHostList } = await import('../src/settings.js');

describe('landing page content', () => {
  test('a fresh store gives the words already on the page', () => {
    const site = mergeSite(undefined);
    assert.equal(site.hero.title, 'See it on you before you buy it.');
    assert.equal(site.roadmap.items.length, 3);
    assert.deepEqual(site.roadmap.items.filter((i) => i.inNav).map((i) => i.navLabel), ['Shopify', 'iOS app']);
    assert.ok(Object.values(site.sections).every(Boolean));
  });

  test('a saved section keeps fields it did not send', () => {
    const site = mergeSite({ hero: { title: 'Try before you buy.' } });
    assert.equal(site.hero.title, 'Try before you buy.');
    assert.equal(site.hero.cta, SITE_DEFAULTS.hero.cta);
  });

  test('tokens are filled from live settings', () => {
    const out = renderSiteContent(SITE_DEFAULTS, { credits: 5, seconds: 20, email: 'help@example.com' });
    assert.equal(out.hero.note, '**5 free try-ons** when you sign in. No card needed.');
    assert.match(out.faq.items[1]!.a, /up to 20 seconds/);
    assert.equal(out.faq.lede, 'Anything else, email [help@example.com](mailto:help@example.com).');
  });

  test('the pinned demo always has three steps and the bento six tiles', () => {
    const site = cleanSite({ how: { steps: [{ title: 'Only one' }] }, features: { tiles: [] } });
    assert.equal(site.how.steps.length, 3);
    assert.equal(site.how.steps[0]!.title, 'Only one');
    assert.equal(site.how.steps[1]!.title, SITE_DEFAULTS.how.steps[1]!.title);
    assert.equal(site.features.tiles.length, 6);
  });

  test('roadmap items are validated, and empty ones dropped', () => {
    const site = cleanSite({
      roadmap: {
        items: [
          { icon: 'nope', title: 'Android app', status: 'someday', inNav: true },
          { title: '   ' },
        ],
      },
    });
    assert.deepEqual(site.roadmap.items, [
      { icon: 'spark', title: 'Android app', text: '', status: 'planned', inNav: true, navLabel: 'Android app' },
    ]);
  });

  test('links must be https; the demo video must be YouTube or an mp4', () => {
    assert.throws(() => cleanSite({ links: { chromeStore: 'http://example.com' } }), /https link/);
    assert.throws(() => cleanSite({ links: { demoVideo: 'https://example.com/page' } }), /YouTube/);
    assert.equal(cleanSite({ links: { chromeStore: '' } }).links.chromeStore, DEFAULT_CHROME_STORE);
    assert.equal(cleanSite({ links: { demoVideo: 'https://youtu.be/ikWsa3Cd8UE' } }).links.demoVideo, 'ikWsa3Cd8UE');
  });

  test('a section switched off stays off', () => {
    assert.equal(cleanSite({ sections: { gallery: false } }).sections.gallery, false);
    assert.equal(cleanSite({ sections: { gallery: false } }).sections.faq, true);
  });
});

describe('extension blocked sites', () => {
  test('pasted links become bare hostnames', () => {
    assert.deepEqual(
      cleanHostList('https://www.zara.com/in/en/\n shop.example.co.uk, not a host, WWW.Zara.com'),
      ['zara.com', 'shop.example.co.uk'],
    );
  });
});
