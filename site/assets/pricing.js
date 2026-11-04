/* tryoncam · live pricing
   The plans and their wording come from the dashboard (app.tryoncam.com), so
   what this page shows is always what checkout charges. The HTML already on
   the page is the fallback: if the request fails, nothing here runs and the
   last published prices stay. */
(function () {
  'use strict';
  const API = 'https://app.tryoncam.com/api/public/pricing';
  const plans = document.getElementById('plans');
  if (!plans) return;

  // The cards written into the page are a fallback. Hide them until the live
  // prices land, so nobody reads a price that is about to change under them —
  // and show them anyway after a few seconds if the request never answers.
  plans.classList.add('plans--loading');
  const reveal = () => plans.classList.remove('plans--loading');
  const fallback = setTimeout(reveal, 3500);

  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const money = (cents, currency) => {
    try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100); }
    catch (e) { return (cents / 100).toFixed(2) + ' ' + currency.toUpperCase(); }
  };
  const check = '<svg><use href="#check"/></svg>';
  // site.js has already pointed every install link at the store; reuse its target.
  const installHref = () => (document.querySelector('[data-install]') || {}).href || '#';

  function freeCard(copy, credits) {
    return '<article class="plan">' +
      '<h3>' + esc(copy.freeName) + '</h3>' +
      '<div class="plan__price"><b>$0</b></div>' +
      '<div class="plan__credits"><i>' + credits + '</i>' + credits + ' credits on sign-in</div>' +
      '<div class="plan__per">' + esc(copy.freeNote) + '</div>' +
      '<ul>' + copy.freeFeatures.map((f) => '<li>' + check + esc(f) + '</li>').join('') + '</ul>' +
      '<a class="btn btn--ghost" data-install href="' + esc(installHref()) + '" target="_blank" rel="noopener">' +
      '<svg class="chrome-ico"><use href="#chrome"/></svg>' + esc(copy.freeCta) + '</a>' +
      '</article>';
  }

  function paidCard(plan, hot) {
    const recurring = plan.mode === 'recurring';
    const cta = recurring ? 'Subscribe' : 'Get ' + plan.credits + ' credits';
    return '<article class="plan' + (hot ? ' plan--hot' : '') + '">' +
      (plan.badge ? '<span class="plan__tag">' + esc(plan.badge) + '</span>' : '') +
      '<h3>' + esc(plan.name) + '</h3>' +
      '<div class="plan__price"><b>' + money(plan.amountCents, plan.currency) + '</b><span>' +
        (recurring ? '/' + esc(plan.interval) : 'once') + '</span></div>' +
      '<div class="plan__credits"><i>' + plan.credits + '</i>' + plan.credits + ' credits' + (recurring ? ' every ' + esc(plan.interval) : '') + '</div>' +
      // The description leads the list, as it did on the hand-written page.
      '<ul>' + [plan.description].concat(plan.features || []).filter(Boolean)
        .map((f) => '<li>' + check + esc(f) + '</li>').join('') + '</ul>' +
      '<a class="btn ' + (hot ? 'btn--primary' : 'btn--dark') + '" data-install href="' + esc(installHref()) + '" target="_blank" rel="noopener">' + esc(cta) + '</a>' +
      '</article>';
  }

  function setText(key, value) {
    const el = document.querySelector('[data-pricing="' + key + '"]');
    if (el && value) el.textContent = value;
  }

  fetch(API, { credentials: 'omit', cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((data) => {
      const copy = data.copy || {};
      setText('eyebrow', copy.eyebrow);
      setText('heading', copy.heading);
      setText('lede', copy.lede);
      setText('note', copy.note);

      const paid = (data.plans || []).filter((p) => p.credits > 0);
      // No plans published yet (or the database is down): keep the page's own cards.
      if (!paid.length) return reveal();
      const hotIndex = paid.findIndex((p) => p.badge);
      const cards = (copy.showFree !== false ? [freeCard(copy, data.freeCredits)] : [])
        .concat(paid.map((p, i) => paidCard(p, i === hotIndex)));
      plans.innerHTML = cards.join('');
      plans.style.setProperty('--plan-count', String(cards.length));

      clearTimeout(fallback);
      reveal();

      const foot = document.querySelectorAll('.pricing-foot > div > span');
      (copy.foot || []).forEach((f, i) => {
        if (!foot[i]) return;
        // Keep a link the page had there (the refund policy), after the new words.
        const link = foot[i].querySelector('a');
        foot[i].innerHTML = '<b>' + esc(f.title) + '</b>' + esc(f.text);
        if (link) foot[i].append(' ', link);
      });
    })
    .catch(() => {
      clearTimeout(fallback);
      reveal(); // the page's own cards stay
    });
})();
