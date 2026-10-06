'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { createHarness, seedStandard, addStudents } = require('./helpers');

const open = (h, token) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`${h.base.replace('http', 'ws')}/ws?token=${encodeURIComponent(token ?? '')}`);
  const frames = [];
  ws.on('message', (d) => frames.push(JSON.parse(String(d))));
  ws.on('open', () => resolve({ ws, frames }));
  ws.on('unexpected-response', (_req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
  ws.on('error', reject);
});
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
  return true;
};

test('REALTIME: in-app notifications are pushed over the WebSocket to the right student only', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seedStandard(h);
  await addStudents(h, 2);
  const a = await open(h, await h.login('student_001'));
  const b = await open(h, await h.login('student_002'));
  t.after(() => { a.ws.close(); b.ws.close(); });
  assert.ok(await until(() => a.frames.length === 1 && b.frames.length === 1));
  assert.equal(a.frames[0].type, 'hello');

  await h.trigger('rt-1', 'grade-alerts', h.explicit('student_001'), { course: 'CS101', grade: '89' });
  await h.tick();
  assert.ok(await until(() => a.frames.length === 2), 'student_001 got a push');
  assert.equal(a.frames[1].type, 'notification');
  assert.match(a.frames[1].content, /CS101: 89/);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(b.frames.length, 1, 'student_002 got nothing');
  assert.equal(h.realtime.connections(), 2);
});

test('REALTIME: the WebSocket requires a valid subscriber token', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seedStandard(h);
  await addStudents(h, 1);
  await assert.rejects(open(h, ''), { status: 401 });
  await assert.rejects(open(h, 'garbage'), { status: 401 });
  await assert.rejects(open(h, 'test-key'), { status: 401 }, 'the API key is not a subscriber token');
  const token = await h.login('student_001');
  const conns = [];
  for (let i = 0; i < 5; i += 1) conns.push(await open(h, token));
  await assert.rejects(open(h, token), { status: 429 }, 'per-student connection cap');
  conns.forEach((c) => c.ws.close());
});
