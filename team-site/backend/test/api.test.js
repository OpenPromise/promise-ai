import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/app.js';

let server;
let baseUrl;

before(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function get(path) {
  const res = await fetch(baseUrl + path);
  const body = await res.json();
  return { status: res.status, body };
}

test('GET /health 返回 ok', async () => {
  const { status, body } = await get('/health');
  assert.equal(status, 200);
  assert.equal(body.status, 'ok');
});

test('GET /api/roles 返回 3 位成员且字段齐全', async () => {
  const { status, body } = await get('/api/roles');
  assert.equal(status, 200);
  assert.equal(body.length, 3);
  for (const r of body) {
    assert.ok(r.id && r.name && r.title && r.bio && r.avatarUrl && r.dream);
  }
});

test('GET /api/news 默认返回全部并按日期倒序', async () => {
  const { status, body } = await get('/api/news');
  assert.equal(status, 200);
  const dates = body.map((n) => n.date);
  const sorted = [...dates].sort().reverse();
  assert.deepEqual(dates, sorted);
  assert.ok(body.length >= 3);
});

test('GET /api/news?type=work 只返回「做了什么」', async () => {
  const { status, body } = await get('/api/news?type=work');
  assert.equal(status, 200);
  assert.ok(body.length > 0);
  assert.ok(body.every((n) => n.type === 'work'));
});

test('GET /api/news?type=做了什么（中文别名）与 work 等价', async () => {
  const a = await get('/api/news?type=work');
  const b = await get(`/api/news?type=${encodeURIComponent('做了什么')}`);
  assert.deepEqual(b.body, a.body);
});

test('GET /api/news?type=牢骚（中文别名）只返回牢骚', async () => {
  const { status, body } = await get(`/api/news?type=${encodeURIComponent('牢骚')}`);
  assert.equal(status, 200);
  assert.ok(body.length > 0);
  assert.ok(body.every((n) => n.type === 'complaint'));
});

test('GET /api/news?type=未知 返回 400', async () => {
  const { status, body } = await get('/api/news?type=whatever');
  assert.equal(status, 400);
  assert.equal(body.error, 'invalid type');
});

test('GET /api/worlds 返回 3 个场景', async () => {
  const { status, body } = await get('/api/worlds');
  assert.equal(status, 200);
  assert.equal(body.length, 3);
  assert.ok(body.every((w) => w.id && w.name && w.imageUrl && w.description));
});

test('GET /api/cities 返回愿景数据', async () => {
  const { status, body } = await get('/api/cities');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body) && body.length >= 1);
  assert.ok(body.every((c) => c.id && c.title && c.imageUrl && c.description));
});

test('未知路径返回 404 JSON', async () => {
  const { status, body } = await get('/api/nope');
  assert.equal(status, 404);
  assert.equal(body.error, 'Not Found');
});
