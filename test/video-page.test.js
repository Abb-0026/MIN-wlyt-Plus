'use strict';

/**
 * 動画ページ（/video/:id）の「遷移が壊れないこと」を守る結合テスト。
 *
 * 過去に起きていた不具合:
 *   1. /video/* が人間確認(robots)ページでガードされ、遷移できないことがあった
 *   2. Service Worker が cache-first で動画ページ/認証ページを保存し、
 *      リロードループや失効URLの再生につながった（→ no-store を返すことを検証）
 *   3. タイトルに引用符や </script> が入るとページの JS が壊れた
 *   4. プレイヤーが window.onload 待ちで、再生開始まで余計な往復が発生していた
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MOCK_PORT = 4310;
const APP_PORT = 4311;
const VIDEO_ID = 'dQw4w9WgXcQ';

const waitForServer = async (url, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (e) {
      /* 起動待ち */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server did not start: ${url}`);
};

const get = (pathname, headers = {}) =>
  fetch(`http://127.0.0.1:${APP_PORT}${pathname}`, { headers, redirect: 'manual' });

let mock;
let app;

test.before(async () => {
  mock = spawn(process.execPath, [path.join(ROOT, 'test-utils', 'mock-upstream.js'), String(MOCK_PORT)], {
    cwd: ROOT,
    stdio: 'ignore',
  });
  await waitForServer(`http://127.0.0.1:${MOCK_PORT}/min-tube-api.json`);

  app = spawn(process.execPath, [path.join(ROOT, 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      MIN_TUBE_API_LIST: `http://127.0.0.1:${MOCK_PORT}/min-tube-api.json`,
      NODE_ENV: 'test',
    },
    stdio: 'ignore',
  });
  await waitForServer(`http://127.0.0.1:${APP_PORT}/healthz`);
});

test.after(() => {
  if (app) app.kill();
  if (mock) mock.kill();
});

test('人間確認の cookie が無くても動画ページが開く', async () => {
  const res = await get(`/video/${VIDEO_ID}`);
  assert.equal(res.status, 200);

  const html = await res.text();
  assert.ok(!html.includes('Verification Required'), '認証ページに差し替えられていない');
  assert.match(html, /<h1 class="video-title">/, '動画ページ本体が描画されている');
});

test('動画ページは no-store で返り、Service Worker にキャッシュされない', async () => {
  const res = await get(`/video/${VIDEO_ID}`);
  const cacheControl = (res.headers.get('cache-control') || '').toLowerCase();
  assert.match(cacheControl, /no-store/, '動画ページは no-store であるべき');
});

test('プレイヤーはサーバー側で描画済み（追加fetch・window.onload待ちがない）', async () => {
  const html = await (await get(`/video/${VIDEO_ID}`)).text();
  assert.match(html, /<video id="mainPlayer"[^>]*><source src="https:\/\/rr1---sn-mock/, 'video 要素に src が直接入っている');
  assert.doesNotMatch(html, /class="spinner"><\/div><\/div>\s*\n\s*<\/div>\s*\n\s*<div id="videoLoadingOverlay"/, 'プレースホルダのままになっていない');
});

test('タイトルに引用符や </script> が入ってもページの JS が壊れない', async () => {
  const html = await (await get(`/video/${VIDEO_ID}`)).text();
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

  // script ブロックは1つだけ（上流データで </script> を注入されても増えない）
  assert.equal(scripts.length, 1, 'script ブロックが途中で閉じられていない');
  assert.ok(!scripts[0].includes('</script>'), 'script 内に生の </script> が入り込まない');
  assert.ok(html.includes('&lt;/script&gt;') || html.includes('\\u003c/script'), 'HTML 上は無害化されている');

  // 抽出したインライン JS が構文として成立していること
  const { execFileSync } = require('node:child_process');
  const fs = require('node:fs');
  const tmp = path.join(require('node:os').tmpdir(), `inline-${process.pid}-${Date.now()}.js`);
  fs.writeFileSync(tmp, scripts.join('\n;\n'));
  try {
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('2回目の動画ページはキャッシュから即返る（戻る・関連動画の行き来が速い）', async () => {
  await get(`/video/${VIDEO_ID}`); // 1回目でキャッシュを作る

  const started = Date.now();
  const res = await get(`/video/${VIDEO_ID}`);
  const elapsed = Date.now() - started;
  await res.text();

  assert.equal(res.status, 200);
  assert.ok(elapsed < 400, `キャッシュ済みなら十分に速いべき: ${elapsed}ms`);
});

test('cookie が無くても /api が JSON を返す（動画ページの関連動画が読める）', async () => {
  const res = await get('/api/recommendations?title=a&channel=b&id=c');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /application\/json/);
  const body = await res.json();
  assert.ok(Array.isArray(body.items));
});
