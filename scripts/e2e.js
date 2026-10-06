'use strict';
/* global document */

/**
 * Browser end-to-end check. Boots the real server (DEMO_MODE, temp SQLite file), opens the built UI in
 * a headless system browser (Edge/Chrome via playwright-core), and:
 *   1. runs every Demo Lab card and requires PASS,
 *   2. walks the Student Portal (inbox, preferences, focus),
 *   3. visits every console page and fails on any console error or uncaught exception.
 * Usage: npm run test:e2e   (needs `npm run build:web` first and Edge or Chrome installed)
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright-core');

const PORT = 3990 + Math.floor(Math.random() * 9);
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = 'e2e-api-key-123456789012';
const ONLY = process.argv.slice(2);

const browserPath = [
  process.env.BROWSER_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => p && fs.existsSync(p));

async function main() {
  if (!browserPath) throw new Error('No Chrome/Edge found; set BROWSER_PATH');
  const dbPath = path.join(os.tmpdir(), `cne-e2e-${Date.now()}.db`);
  const env = { ...process.env, PORT: String(PORT), DB_PATH: dbPath, DEMO_MODE: 'true', API_KEY: KEY, LOG_LEVEL: 'warn', WORKER_TICK_MS: '200' };
  const root = path.join(__dirname, '..');
  await new Promise((res, rej) => spawn(process.execPath, ['src/seed.js'], { cwd: root, env, stdio: 'ignore' }).on('exit', (c) => (c ? rej(new Error('seed failed')) : res())));
  const server = spawn(process.execPath, ['src/index.js'], { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let serverErr = '';
  server.stderr.on('data', (d) => { serverErr += d; });
  for (let i = 0; i < 50; i += 1) {
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 200));
  }

  const browser = await chromium.launch({ executablePath: browserPath, headless: true });
  const page = await browser.newPage();
  const problems = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 40[49]/.test(m.text())) problems.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  const results = [];
  try {
    // ---- operator console ----
    await page.goto(`${BASE}/console`);
    await page.fill('#k', KEY);
    await page.click('button[type=submit]');
    await page.waitForSelector('text=Last 24 hours');
    for (const p of ['compose', 'send', 'events', 'activity', 'dead-letters', 'providers', 'workflows', 'subscribers', 'webhooks']) {
      await page.goto(`${BASE}/console/${p}`);
      await page.waitForSelector('main h1');
      results.push({ check: `console page /console/${p} renders`, ok: true });
    }
    const productText = await page.locator('nav').innerText();
    results.push({ check: 'Console navigation has no internal/test wording', ok: !/demo|killer|verify/i.test(productText) });

    // ---- internal verification page (developer tool, unlinked) ----
    await page.goto(`${BASE}/internal/verify`);
    await page.waitForSelector('text=Delivery verification (internal)');
    const cards = page.locator('main section');
    const n = await cards.count();
    for (let i = 0; i < n; i += 1) {
      const card = cards.nth(i);
      const title = (await card.locator('h3').innerText()).trim();
      const label = (await card.innerText()).slice(0, 200).toLowerCase();
      if (ONLY.length && !ONLY.some((o) => label.includes(o.toLowerCase()))) continue;
      const t0 = Date.now();
      await card.getByRole('button', { name: /^Run/ }).click();
      await card.locator('text=/^(PASS|FAIL|ERROR)$/').first().waitFor({ timeout: 120000 });
      const verdict = (await card.locator('text=/^(PASS|FAIL|ERROR)$/').first().innerText()).trim();
      const failed = verdict === 'PASS' ? [] : await card.locator('li:has-text("✘")').allInnerTexts();
      const err = verdict === 'ERROR' ? await card.locator('[role=alert]').allInnerTexts() : [];
      results.push({ check: `Verify: ${title}`, ok: verdict === 'PASS', detail: `${((Date.now() - t0) / 1000).toFixed(1)}s ${[...failed, ...err].join(' | ')}` });
    }

    // ---- admin composes an event for a course; it must reach an enrolled student ----
    await page.goto(`${BASE}/console/compose`);
    await page.getByRole('button', { name: /^Class cancellation/ }).click();
    await page.fill('#ct', 'CS302 tutorial moved online');
    await page.fill('#cs', 'Thursday 3 PM tutorial runs on the course video link instead of AB1-204.');
    await page.fill('#v-course', 'CS302');
    await page.getByRole('button', { name: 'Course', exact: true }).click();
    await page.getByRole('button', { name: /^CS302 · Operating Systems/ }).click();
    await page.waitForFunction(() => /Publish to \d/.test(document.body.innerText));
    const audienceText = await page.getByRole('button', { name: /^Publish to/ }).innerText();
    await page.getByRole('button', { name: /^Publish to/ }).click();
    await page.waitForSelector('text=Queued for');
    results.push({ check: `Compose publishes to a course audience (${audienceText.trim()})`, ok: true });
    await page.getByRole('link', { name: 'Track delivery' }).click();
    await page.waitForSelector('text=Students');
    await page.locator('aside[role=dialog] ul li button').first().click({ timeout: 15000 });
    await page.waitForSelector('text=/^Lifecycle · /');
    await page.waitForSelector('text=Campus event received');
    results.push({ check: 'Delivery lifecycle inspector opens for a student', ok: true });
    await page.goto(`${BASE}/console`);
    await page.waitForSelector('text=/Attention management/');
    await page.waitForSelector('text=/Engagement/');
    results.push({ check: 'Dashboard shows attention management and engagement', ok: true });
    await page.goto(`${BASE}/console/workflows`);
    await page.waitForSelector('text=Exam schedule change');
    await page.waitForSelector('text=Combine related updates for 5 min');
    results.push({ check: 'Workflows show the event to channel flow', ok: true });

    // ---- student portal ----
    await page.goto(`${BASE}/app`);
    await page.fill('#sid', 'student_001');
    await page.click('button[type=submit]');
    await page.getByText('Live', { exact: true }).waitFor({ timeout: 10000 });
    results.push({ check: 'Student portal WebSocket connects (Live)', ok: true });
    await page.waitForSelector('text=CS302 tutorial moved online', { timeout: 10000 });
    results.push({ check: 'Admin-composed event reached the enrolled student', ok: true });
    await fetch(`${BASE}/events/trigger`, {
      method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ transactionId: `e2e-${Date.now()}`, workflowIdentifier: 'class-cancellation', to: { type: 'explicit', subscriberIds: ['student_001'] }, payload: { course: 'CS301', title: 'CS301 lab shifted to Lab 4', summary: 'Same time, different lab.' } }),
    });
    // Fallback poll is 15 s, so arriving within 5 s proves the WebSocket push path.
    await page.waitForSelector('text=CS301 lab shifted to Lab 4', { timeout: 5000 });
    results.push({ check: 'New notification appears via WebSocket push (< 5 s)', ok: true });

    await page.goto(`${BASE}/app/inbox`);
    await page.getByText('4 related updates', { exact: false }).first().click();
    await page.waitForSelector('text=What changed');
    const table = await page.locator('table').first().innerText();
    results.push({ check: 'Exam digest detail shows Previous -> Updated', ok: /AB2-301/.test(table) && /AB3-204/.test(table) && /2:00 PM/.test(table) });
    await page.waitForSelector('text=Why you received this');
    await page.getByRole('button', { name: 'View updated timetable' }).click();
    await page.waitForSelector('text=Opened');
    results.push({ check: 'Notification action records the click', ok: true });
    await page.fill('input[aria-label="Search notifications"]', 'Techfest');
    await page.waitForFunction(() => /Techfest/.test(document.querySelector('main section ul')?.textContent || ''));
    results.push({ check: 'Inbox search filters', ok: (await page.locator('main section ul > li').count()) >= 1 });
    await page.fill('input[aria-label="Search notifications"]', '');
    await page.getByRole('button', { name: /Mark all read/ }).click();
    await page.waitForSelector('text=/Marked \\d+ as read|Nothing unread/');
    results.push({ check: 'Mark all read', ok: true });

    await page.goto(`${BASE}/app/preferences`);
    await page.getByRole('switch', { name: 'Academic email' }).click();
    await page.waitForSelector('text=Saved. Applies');
    const token = await page.evaluate(() => globalThis.sessionStorage.getItem('cne.studentToken'));
    const prefs = await (await fetch(`${BASE}/inbox/preferences`, { headers: { authorization: `Bearer ${token}` } })).json();
    results.push({ check: 'Category preference persists (academic email off)', ok: !!prefs.categories.academic && prefs.categories.academic.email === false });

    await page.goto(`${BASE}/app/topics`);
    await page.getByRole('button', { name: 'Follow', exact: true }).first().click();
    await page.waitForSelector('text=/^Following /');
    results.push({ check: 'Follow a topic', ok: true });

    await page.goto(`${BASE}/app/focus`);
    await page.getByRole('button', { name: '30 min' }).click();
    await page.waitForSelector('text=End now and catch up');
    await page.getByRole('button', { name: 'End now and catch up' }).click();
    await page.waitForSelector('text=Focus for');
    results.push({ check: 'Focus Mode start and end', ok: true });
    await page.goto(`${BASE}/app/profile`);
    await page.waitForSelector('text=Aditi Rao');
    results.push({ check: 'Profile shows registrar data', ok: true });
    await page.goto(`${BASE}/`);
    await page.waitForSelector('text=Student portal');
    results.push({ check: 'Landing page renders', ok: true });
  } catch (e) {
    results.push({ check: 'flow', ok: false, detail: e.message.split('\n')[0] });
  } finally {
    await browser.close();
    await new Promise((r) => { server.once('exit', r); server.kill(); });
    for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      try { fs.rmSync(f, { force: true }); } catch { /* Windows may still hold the file briefly */ }
    }
  }
  results.push({ check: 'No browser console errors or uncaught exceptions', ok: problems.length === 0, detail: problems.slice(0, 5).join(' | ') });
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.check}${r.detail ? `  (${r.detail})` : ''}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  if (failed && serverErr) console.log(`server stderr:\n${serverErr.slice(-2000)}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
