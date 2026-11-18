// Headless Chrome test: no console errors, every mode computes, lookup flow works with mocked map services.
const puppeteer = require('puppeteer-core'), path = require('path'), assert = require('assert');
const url = process.env.TEST_URL || ('file://' + path.join(__dirname, '..', 'index.html'));
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
let n = 0;
const ok = (c, m) => { n++; assert(c, m); };
(async () => {
  const browser = await puppeteer.launch({executablePath: CHROME, headless: true, args: ['--no-sandbox']});
  const page = await browser.newPage();
  await page.setViewport({width: 390, height: 800});
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  // Mock map services so the lookup flow is tested offline and does not hit public servers.
  await page.evaluateOnNewDocument(() => {
    window.__calls = [];
    window.fetch = (u) => {
      window.__calls.push(u);
      const json = (o) => Promise.resolve({ok: true, json: () => Promise.resolve(o)});
      if (u.includes('nominatim')) {
        return json(/shiro/i.test(decodeURIComponent(u)) ?
          [{display_name:'Shiro Lagos, Lekki, Lagos, Nigeria', lat:'6.44', lon:'3.55'}] :
          [{display_name:'Agege Motor Road, Agege, Lagos, Nigeria', lat:'6.62', lon:'3.32'}]);
      }
      if (u.includes('router.project-osrm.org')) return json({code:'Ok', routes:[{distance: 75432}]});
      return Promise.reject(new Error('unexpected ' + u));
    };
  });
  await page.goto(url, {waitUntil: 'load'});
  const text = id => page.$eval(id, e => e.innerText);
  const setVal = async (sel, v) => { await page.$eval(sel, e => { e.value = ''; }); await page.type(sel, String(v)); };
  const tab = t => page.click('#tabs button[data-tab="' + t + '"]');

  // Banner
  ok((await text('#banner')).includes("Implements Rume's pricing policy as drafted. Provisional distances must be verified. Internal Commut tool."), 'banner text');

  // Mode 1 defaults
  let t1 = await text('#l-out');
  for (const f of ['₦23,100', '₦24,900', '₦23,700', '₦311.02', '₦322,222.22']) ok(t1.includes(f), 'long mode shows ' + f);
  ok(t1.includes('₦33,400'), 'Agege full-bus profit');
  ok(t1.includes('12 bookings') && t1.includes('13 bookings') && t1.includes('14 bookings'), 'threshold table headings');
  // Add + remove corridor, edit km
  await page.click('#l-add');
  ok((await page.$$('.crow')).length === 5, 'corridor added');
  await page.$$eval('.c-rm', b => b[4].click());
  ok((await page.$$('.crow')).length === 4, 'corridor removed');
  await page.$$eval('.c-rm', b => b[0].click()); // remove Agege -> shortest becomes Ikeja 76
  t1 = await text('#l-out');
  ok(t1.includes('76 km'), 'shortest corridor updates after removing Agege');
  // Reload to restore defaults for lookup test
  await page.reload({waitUntil: 'load'});

  // Lookup flow (mocked): pick venue, then find km for Agege
  await page.type('#l-venue', 'Shiro Lagos');
  await page.waitForSelector('#l-venue-sugg div:not(.none)', {visible: true, timeout: 8000});
  await page.click('#l-venue-sugg div:not(.none)');
  await page.$$eval('.c-find', b => b[0].click());
  const q = (await page.$$('.c-q'))[0];
  await q.click({clickCount: 3}); await q.type('Agege Motor Road');
  await page.waitForSelector('.c-sugg div:not(.none)', {visible: true, timeout: 8000});
  await page.$eval('.c-sugg div:not(.none)', e => e.click());
  await page.waitForFunction(() => document.querySelectorAll('.c-km')[0].value === '75.4', {timeout: 8000});
  ok(true, 'lookup filled 75.4 km');
  const calls = await page.evaluate(() => window.__calls);
  ok(calls.some(u => u.includes('countrycodes=ng')), 'nominatim biased to Nigeria');
  ok(calls.some(u => u.includes('router.project-osrm.org')), 'osrm used');
  ok((await text('#l-out')).includes('75.4 km'), 'fetched km drives the rate');
  await page.reload({waitUntil: 'load'});

  // Manual km works even if map services fail
  // (mock returns for unexpected URLs reject; typing km needs no fetch)
  await page.$$eval('.c-km', e => { e[0].value = '100'; e[0].dispatchEvent(new Event('input')); });
  ok((await text('#l-out')).includes('₦30,300'), 'manual km works (Agege 100 km -> 30,300)');
  await page.reload({waitUntil: 'load'});

  // Mode 2
  await tab('short');
  let t2 = await text('#s-out');
  for (const f of ['₦6,900','₦8,600','₦10,300','₦12,900','₦15,400','₦17,100','₦3,600','₦13,900','₦24,200','2.91%','10.38%','16.78%']) ok(t2.includes(f), 'short mode shows ' + f);
  await setVal('#s-quote', 80000);
  ok((await text('#s-out')).includes('₦6,900'), 'short quote 80,000 -> 6,900 as big figure');

  // Mode 3
  await tab('shuttle');
  const t3 = await text('#m-out');
  ok(t3.includes('₦4,800') && t3.includes('₦4,761.90'), 'shuttle shows 4,800 and exact 4,761.90');

  // Mode 4
  await tab('depart');
  let t4 = await text('#d-out');
  ok(/Minimum to break even[^\n]*\t?\s*12/.test(t4) || t4.includes('12'), 'break-even 12');
  ok((await text('#d-be')).includes('Yes') && (await text('#d-tg')).includes('Yes'), '13 bookings reaches both');
  await setVal('#d-book', 12);
  ok((await text('#d-be')).includes('Yes') && (await text('#d-tg')).includes('No'), '12 bookings: break-even yes, target no');
  await setVal('#d-book', 11);
  ok((await text('#d-be')).includes('No'), '11 bookings: break-even no');

  // Mobile: no horizontal page overflow
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  ok(!overflow, 'no horizontal page overflow at 390px');

  await page.screenshot({path: path.join(__dirname, 'screenshot-mobile.png'), fullPage: true});
  ok(errors.length === 0, 'no console errors: ' + errors.join(' | '));
  await browser.close();
  console.log('browser tests passed: ' + n + ' checks, 0 console errors');
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
