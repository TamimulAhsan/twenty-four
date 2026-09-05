(() => {
  'use strict';

  const state = {
    page: 'home',
    annual: true,
    demo: 0,
    faq: -1,
    plan: 2,
    sent: false,
  };

  const PRICES = { starter: 89, growth: 189, max: 349 };   // placeholders — final prices TBD
  const ANNUAL_DISCOUNT = 20;
  const DEMO_PATHS = ['orders', 'bookings', 'marketing', 'customers'];
  const COUNTER_TARGETS = { biz: 4200, hours: 24, uptime: 99.98, niche: 40 };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const fmt = (n) => n.toLocaleString('de-DE');

  // ---------- Page navigation ----------
  function nav(page) {
    state.page = page;
    $$('.page').forEach((el) => el.classList.toggle('active', el.id === `page-${page}`));
    window.scrollTo({ top: 0, behavior: 'auto' });
    revealObserve();
  }

  // ---------- Animated counters ----------
  function runCounters() {
    const start = performance.now();
    const dur = 1600;
    const els = {
      biz: $('#cBiz'),
      hours: $('#cHours'),
      uptime: $('#cUptime'),
      niche: $('#cNiche'),
    };
    function tick(now) {
      const k = Math.min(1, (now - start) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      if (els.biz) els.biz.textContent = fmt(Math.round(COUNTER_TARGETS.biz * e));
      if (els.hours) els.hours.textContent = Math.round(COUNTER_TARGETS.hours * e);
      if (els.uptime) els.uptime.textContent = (COUNTER_TARGETS.uptime * e).toFixed(2);
      if (els.niche) els.niche.textContent = Math.round(COUNTER_TARGETS.niche * e);
      if (k < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  // ---------- Scroll reveal ----------
  let revealObserver = null;
  function revealObserve() {
    if (typeof IntersectionObserver === 'undefined') return;
    if (!revealObserver) {
      revealObserver = new IntersectionObserver(
        (entries) => {
          entries.forEach((en) => {
            if (en.isIntersecting) {
              en.target.classList.add('revealed');
              revealObserver.unobserve(en.target);
            }
          });
        },
        { threshold: 0.08, rootMargin: '0px 0px -6% 0px' }
      );
    }
    $$('[data-reveal]:not(.revealed)').forEach((el) => {
      if (el.dataset.observed) return;
      el.dataset.observed = '1';
      revealObserver.observe(el);
    });
  }

  // ---------- Product demo tabs ----------
  function setDemo(i) {
    state.demo = i;
    $$('.demo-tab').forEach((el, idx) => el.classList.toggle('active', idx === i));
    $$('.demo-panel').forEach((el, idx) => el.classList.toggle('active', idx === i));
    const path = $('#demoPath');
    if (path) path.textContent = DEMO_PATHS[i];
  }

  function startDemoAutoplay() {
    setInterval(() => setDemo((state.demo + 1) % 4), 6000);
  }

  // ---------- FAQ accordion ----------
  function toggleFaq(i) {
    state.faq = state.faq === i ? -1 : i;
    $$('.faq-item').forEach((el, idx) => {
      const open = idx === state.faq;
      el.classList.toggle('open', open);
      el.querySelector('.faq-sym').textContent = open ? '−' : '+';
    });
  }

  // ---------- Pricing ----------
  function setBilling(annual) {
    state.annual = annual;
    $$('.toggle-btn').forEach((el) => el.classList.toggle('active', el.dataset.action === (annual ? 'setAnnual' : 'setMonthly')));
    const f = (v) => (state.annual ? Math.round((v * (100 - ANNUAL_DISCOUNT)) / 100) : v);
    const pStarter = $('#pStarter'), pGrowth = $('#pGrowth'), pMax = $('#pMax');
    if (pStarter) pStarter.textContent = f(PRICES.starter);
    if (pGrowth) pGrowth.textContent = f(PRICES.growth);
    if (pMax) pMax.textContent = f(PRICES.max);
    const note = state.annual ? 'BILLED ANNUALLY' : 'BILLED MONTHLY';
    $$('.js-bill-note').forEach((el) => (el.textContent = note));
  }

  // ---------- Plan of interest (contact form) ----------
  function setPlan(i) {
    state.plan = i;
    $$('.pill[data-plan]').forEach((el) => el.classList.toggle('active', Number(el.dataset.plan) === i));
  }

  // ---------- Contact form ----------
  function submitContact(e) {
    if (e) e.preventDefault();
    state.sent = true;
    const formView = $('#contact-form-view');
    const sentView = $('#contact-sent-view');
    if (formView) formView.style.display = 'none';
    if (sentView) sentView.style.display = 'block';
  }

  // ---------- Event delegation ----------
  const ACTIONS = {
    goHome: () => nav('home'),
    goPricing: () => nav('pricing'),
    goAbout: () => nav('about'),
    goContact: () => nav('contact'),
    t0: () => setDemo(0),
    t1: () => setDemo(1),
    t2: () => setDemo(2),
    t3: () => setDemo(3),
    f0: () => toggleFaq(0),
    f1: () => toggleFaq(1),
    f2: () => toggleFaq(2),
    f3: () => toggleFaq(3),
    f4: () => toggleFaq(4),
    setMonthly: () => setBilling(false),
    setAnnual: () => setBilling(true),
    pick0: () => setPlan(0),
    pick1: () => setPlan(1),
    pick2: () => setPlan(2),
    pick3: () => setPlan(3),
  };

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = ACTIONS[el.dataset.action];
    if (action) action(e);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const el = e.target.closest('[role="button"][data-action]');
    if (!el) return;
    e.preventDefault();
    const action = ACTIONS[el.dataset.action];
    if (action) action(e);
  });

  // ---------- Init ----------
  document.addEventListener('DOMContentLoaded', () => {
    runCounters();
    revealObserve();
    startDemoAutoplay();
    setPlan(state.plan);
    setBilling(state.annual);
    const form = $('#contact-form');
    if (form) form.addEventListener('submit', submitContact);
  });
})();
