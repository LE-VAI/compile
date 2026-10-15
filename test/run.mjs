// Self-test for the verify.js that Compile generates.
//
//   node test/run.mjs        (or: npm test)
//
// It compiles one principle that reaches all seven domains, then runs the
// generated verify.js on three pages:
//   test/fixtures/pass.html  every check must pass
//   test/fixtures/fail.html  every check must fail at least once
//   index.html               Compile itself, for the four checks that used to
//                            fire on every site or never fire at all
//
// Needs playwright-core and an installed Chrome. Compile ships no dependencies,
// so playwright-core is not in package.json: install it next to the repo
// (npm i --no-save playwright-core) or point PLAYWRIGHT_CORE at a copy.
// PW_CHANNEL picks the browser channel (default: chrome).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { env } = process;

let chromium;
try {
  ({ chromium } = require(env.PLAYWRIGHT_CORE || 'playwright-core'));
} catch {
  console.error('playwright-core was not found. Run `npm i --no-save playwright-core`, or set PLAYWRIGHT_CORE to its folder.');
  process.exit(2);
}

const PRINCIPLE = 'Buttons should feel physical; text rhythm, color contrast, spacing, radius, focus and sound';
const RULES = [
  'Press without transform', 'Duration > 300ms', 'No transition on interactive', 'Entrance from scale(0)',
  'Insufficient text contrast', 'Line-height too tight', 'Measure too wide', 'Fixed font size',
  'Inconsistent spacing', 'Inconsistent radii', 'Touch target too small', 'Focus not visible',
  'Sound without preference opt-out',
];

// A static file server for the repo, so the pages load over http like the live site.
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  let file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  fs.readFile(file, (err, body) => {
    if (err) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(body);
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
function expect(ok, label, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? `\n      ${detail}` : ''}`);
}
const count = (results, rule) => results.filter((r) => !r.pass && r.rule === rule).length;

const browser = await chromium.launch({ channel: env.PW_CHANNEL || 'chrome', headless: true });
try {
  // 1. Compile the principle on Compile's own page.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto(`${BASE}/index.html`);
  const compiled = await page.evaluate((p) => {
    const r = compile(p);
    return { domains: r.domains, verifyJs: r.verifyJs };
  }, PRINCIPLE);
  expect(compiled.domains.length === 7, `the principle compiles to all seven domains (${compiled.domains.join(', ')})`);

  // Runs the generated script in a page and returns its results, with its console output muted.
  const run = (target) => target.evaluate((code) => {
    const saved = [console.log, console.group, console.groupEnd];
    console.log = console.group = console.groupEnd = () => {};
    try { return (0, eval)(code); } finally { [console.log, console.group, console.groupEnd] = saved; }
  }, compiled.verifyJs);

  async function runOn(url, prepare) {
    const c = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p = await c.newPage();
    await p.goto(url);
    if (prepare) await p.evaluate(prepare);
    const results = await run(p);
    await c.close();
    return results;
  }

  // 2. The pass fixture: no check may fire.
  const passResults = await runOn(`${BASE}/test/fixtures/pass.html`);
  for (const rule of RULES) {
    const n = count(passResults, rule);
    expect(n === 0, `pass.html: "${rule}" passes`, n ? passResults.filter((r) => r.rule === rule).map((r) => r.detail).join(' | ') : '');
  }

  // 3. The fail fixture: every check must fire.
  const failResults = await runOn(`${BASE}/test/fixtures/fail.html`);
  for (const rule of RULES) {
    expect(count(failResults, rule) > 0, `fail.html: "${rule}" fails`);
  }
  expect(failResults.some((r) => r.rule === 'Fixed font size' && r.el === -1), 'fail.html: a px font-size on html is reported');

  // The sound check's opt-out: real audio passes once a mute control is on the page.
  const optOut = await runOn(`${BASE}/test/fixtures/pass.html`, () => {
    document.body.insertAdjacentHTML('beforeend', '<audio preload="none"></audio><button type="button" aria-label="Mute sound">M</button>');
  });
  expect(count(optOut, 'Sound without preference opt-out') === 0, 'pass.html + audio + a mute control: "Sound without preference opt-out" passes');

  // 4. Compile's own page, compiled: the four checks that were wrong by construction.
  await page.evaluate((p) => { document.getElementById('principleInput').value = p; document.getElementById('btnCompile').click(); }, PRINCIPLE);
  const ownResults = await run(page);
  const pressed = await page.evaluate(() => {
    const list = [...document.querySelectorAll('button, [role="button"], .btn, a[href]')];
    return ['#btnCompile', '#btnDownload', '#btnClear', '#previewSkeleton .sk-btn'].map((s) => list.indexOf(document.querySelector(s)));
  });
  const pressHits = ownResults.filter((r) => r.rule === 'Press without transform').map((r) => r.el);
  expect(pressed.every((i) => i >= 0 && !pressHits.includes(i)), 'index.html: buttons with an :active scale are not reported as "Press without transform"',
    `reported element indexes ${pressHits.join(',')}, buttons with a press scale at ${pressed.join(',')}`);
  expect(count(ownResults, 'Focus not visible') === 0, 'index.html: "Focus not visible" passes (:focus-visible draws a ring)');
  expect(count(ownResults, 'Fixed font size') === 0, 'index.html: "Fixed font size" passes (sizes are set in rem)',
    ownResults.filter((r) => r.rule === 'Fixed font size').slice(0, 5).map((r) => r.detail).join(' | '));
  expect(count(ownResults, 'Sound without preference opt-out') === 0, 'index.html: "Sound without preference opt-out" passes (the page plays no audio)');
  expect(pageErrors.length === 0, 'index.html: no page errors', pageErrors.join(' | '));

  await ctx.close();
} finally {
  await browser.close();
  server.close();
}

console.log(failures ? `\n${failures} assertion(s) failed.` : '\nAll assertions passed.');
process.exit(failures ? 1 : 0);
