'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { StreamResolver, TIER } = require('../lib/stream-resolver');

/**
 * 取得元ごとの応答時間モデル（index.js の履歴から実際のホップ数を数えて想定した値）。
 *   min-tube API : 1ホップ
 *   sia-dl       : siawaseok → /360 → getlate.dev の3ホップ
 *   ai-fetch     : aijimy → noembed → /360 → getlate.dev の4ホップ（旧実装はさらに+2秒の待機）
 *   rapid        : 1ホップ（旧実装は他が全滅した後でしか試さない）
 */
const LATENCY = {
  'min-tube:fast': 250,
  'min-tube:slow': 1800,
  'sia-dl': 1200,
  'ai-fetch': 2200,
  rapid: 700,
  comments: 900,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jsonResponse = (body, ms) =>
  sleep(ms).then(() => ({ ok: true, status: 200, json: async () => body }));

function makeFetch({ fail = new Set() } = {}) {
  const fetchImpl = async (url, options = {}) => {
    if (typeof url !== 'string') throw new Error('unexpected url');
    // 呼び出し回数を記録（下位ティアを無駄に呼んでいないかの検証用）
    const count = (name) => fetchImpl.calls.set(name, (fetchImpl.calls.get(name) || 0) + 1);
    if (url.includes('/sia-dl/')) count('sia-dl');
    if (url.includes('/ai-fetch/')) count('ai-fetch');
    if (url.includes('/rapid/')) count('rapid');
    if (url.includes('/api/video/')) count('video');
    if (url.includes('/api/comments/')) count('comments');

    if (url.includes('/api/video/')) {
      const name = url.includes('/fast') ? 'min-tube:fast' : 'min-tube:slow';
      if (fail.has(name)) throw new Error(`${name} failed`);
      return jsonResponse(
        { stream_url: `https://googlevideo.example/${name}`, videoTitle: 'mock' },
        LATENCY[name]
      );
    }
    if (url.includes('/api/comments/')) {
      if (fail.has('comments')) return sleep(99999).then(() => { throw new Error('hang'); });
      return jsonResponse({ commentCount: 2, comments: [{ author: 'a', content: 'b' }] }, LATENCY.comments);
    }
    if (url.includes('/sia-dl/')) {
      if (fail.has('sia-dl')) throw new Error('sia-dl failed');
      return jsonResponse({ stream_url: 'https://googlevideo.example/sia' }, LATENCY['sia-dl']);
    }
    if (url.includes('/ai-fetch/')) {
      if (fail.has('ai-fetch')) throw new Error('ai-fetch failed');
      // 旧実装の既定値どおり、失敗時は埋め込みURLを返す
      return jsonResponse({ stream_url: 'https://www.youtube-nocookie.com/embed/mock' }, LATENCY['ai-fetch']);
    }
    if (url.includes('/rapid/')) {
      if (fail.has('rapid')) throw new Error('rapid failed');
      return jsonResponse({ stream_url: 'https://googlevideo.example/rapid' }, LATENCY.rapid);
    }
    throw new Error(`unknown url: ${url}`);
  };
  fetchImpl.calls = new Map();
  return fetchImpl;
}

const API_LIST = ['http://api.test/fast', 'http://api.test/slow'];
const BASE = 'http://app.test';

/** 旧実装（2026-05-09 〜 /video/:id のロジック）を同じモックで再現したもの */
async function oldResolve(videoId, fetchImpl) {
  const started = Date.now();
  const host = 'app.test';
  const protocol = 'http';
  let videoData = null;
  let commentsData = { commentCount: 0, comments: [] };

  for (const apiBase of API_LIST) {
    try {
      videoData = await Promise.any([
        fetchImpl(`${apiBase}/api/video/${videoId}`, {})
          .then((res) => (res.ok ? res.json() : Promise.reject()))
          .then((data) => (data.stream_url ? data : Promise.reject())),
        fetchImpl(`${protocol}://${host}/sia-dl/${videoId}`, {})
          .then((res) => (res.ok ? res.json() : Promise.reject()))
          .then((data) => (data.stream_url ? data : Promise.reject())),
        new Promise((resolve, reject) => {
          setTimeout(() => {
            fetchImpl(`${protocol}://${host}/ai-fetch/${videoId}`, {})
              .then((res) => (res.ok ? res.json() : Promise.reject()))
              .then((data) => (data.stream_url ? resolve(data) : reject()))
              .catch(reject);
          }, 2000); // ← 旧実装の2秒の待機
        }),
      ]);
      try {
        const cRes = await fetchImpl(`${apiBase}/api/comments/${videoId}`, {});
        if (cRes.ok) commentsData = await cRes.json();
      } catch (e) {}
      break;
    } catch (e) {
      try {
        const rapidRes = await fetchImpl(`${protocol}://${host}/rapid/${videoId}`, {});
        if (rapidRes.ok) {
          const rapidData = await rapidRes.json();
          if (rapidData.stream_url) {
            videoData = rapidData;
            try {
              const cRes = await fetchImpl(`${apiBase}/api/comments/${videoId}`, {});
              if (cRes.ok) commentsData = await cRes.json();
            } catch (e) {}
            break;
          }
        }
      } catch (rapidErr) {}
    }
  }
  return { videoData, commentsData, ms: Date.now() - started };
}

test('最速の取得元が勝ち、遅い取得元を待たない', async () => {
  const fetchImpl = makeFetch();
  const resolver = new StreamResolver({ fetchImpl, deadline: 6000 });
  const started = Date.now();
  const result = await resolver.resolve('aaaaaaaaaaa', { apiList: API_LIST, baseUrl: BASE });
  const elapsed = Date.now() - started;

  assert.equal(result.provider, 'min-tube:api.test');
  assert.equal(result.cached, false);
  assert.ok(elapsed < 800, `最速取得元(250ms)で解決すべき: ${elapsed}ms`);

  // 上位ティアが早く答えたので、回数制限のある rapid / 外部依存の ai-fetch は呼ばない
  await new Promise((r) => setTimeout(r, 1200)); // ヘッジが発動しないことを確認する
  assert.equal(fetchImpl.calls.get('rapid'), undefined, 'RapidAPI は無駄に呼ばない');
  assert.equal(fetchImpl.calls.get('ai-fetch'), undefined, 'ai-fetch は無駄に呼ばない');
});

test('上位ティアが遅い/失敗したときだけ予備(rapid, ai-fetch)を走らせる', async () => {
  const fetchImpl = makeFetch({ fail: new Set(['min-tube:fast', 'min-tube:slow', 'sia-dl']) });
  const resolver = new StreamResolver({ fetchImpl, deadline: 6000 });
  const result = await resolver.resolve('ggggggggggg', { apiList: API_LIST, baseUrl: BASE });

  assert.equal(result.provider, 'rapid', '予備の取得元で解決する');
  assert.ok(fetchImpl.calls.get('rapid') >= 1);
});

test('2回目はキャッシュから即座に返る（ページの行き来が速い）', async () => {
  const resolver = new StreamResolver({ fetchImpl: makeFetch(), deadline: 6000 });
  await resolver.resolve('bbbbbbbbbbb', { apiList: API_LIST, baseUrl: BASE });

  const started = Date.now();
  const second = await resolver.resolve('bbbbbbbbbbb', { apiList: API_LIST, baseUrl: BASE });
  const elapsed = Date.now() - started;

  assert.equal(second.cached, true);
  assert.ok(elapsed < 50, `キャッシュなら一瞬で返るべき: ${elapsed}ms`);
  assert.equal(resolver.stats.hits, 1);
});

test('上位ティアが全滅しても最終手段(ai-fetch)でページは成立する', async () => {
  const resolver = new StreamResolver({
    fetchImpl: makeFetch({ fail: new Set(['min-tube:fast', 'min-tube:slow', 'sia-dl', 'rapid']) }),
    deadline: 6000,
  });
  const result = await resolver.resolve('ccccccccccc', { apiList: API_LIST, baseUrl: BASE });

  assert.equal(result.provider, 'ai-fetch');
  assert.equal(result.tier, TIER.EMBED);
  assert.match(result.data.stream_url, /youtube-nocookie\.com\/embed/);
});

test('コメントは打ち切り時間を超えてページをブロックしない', async () => {
  const resolver = new StreamResolver({
    fetchImpl: makeFetch({ fail: new Set(['comments']) }),
    deadline: 6000,
  });
  const started = Date.now();
  const comments = await resolver.resolveComments('ddddddddddd', { apiList: API_LIST });
  const elapsed = Date.now() - started;

  assert.deepEqual(comments, { commentCount: 0, comments: [] });
  assert.ok(elapsed < 3000, `コメント待ちは打ち切られるべき: ${elapsed}ms`);
});

test('旧実装より速い（最速取得元が失敗するケース）', async () => {
  const fail = new Set(['min-tube:fast', 'min-tube:slow']);
  const fetchImpl = makeFetch({ fail });

  const oldResult = await oldResolve('eeeeeeeeeee', fetchImpl);

  const resolver = new StreamResolver({ fetchImpl, deadline: 6000 });
  const started = Date.now();
  const [resolved, comments] = await Promise.all([
    resolver.resolve('eeeeeeeeeee', { apiList: API_LIST, baseUrl: BASE }),
    resolver.resolveComments('eeeeeeeeeee', { apiList: API_LIST }),
  ]);
  const newMs = Date.now() - started;

  assert.ok(oldResult.videoData, '旧実装も動画データは取れる');
  assert.ok(resolved, '新実装も動画データは取れる');
  assert.equal(comments.commentCount, 2, '新実装はコメントも並列で取れる');

  console.log(`  old: ${oldResult.ms}ms (stream→comments 直列)`);
  console.log(`  new: ${newMs}ms (全取得元レース + コメント並列) provider=${resolved.provider}`);
  assert.ok(newMs < oldResult.ms, `新実装(${newMs}ms)は旧実装(${oldResult.ms}ms)より速いべき`);
});

test('全部失敗したときは null を返し、呼び出し側のフォールバックに任せる', async () => {
  const resolver = new StreamResolver({
    fetchImpl: makeFetch({ fail: new Set(['min-tube:fast', 'min-tube:slow', 'sia-dl', 'rapid', 'ai-fetch']) }),
    deadline: 6000,
  });
  const result = await resolver.resolve('fffffffffff', { apiList: API_LIST, baseUrl: BASE });
  assert.equal(result, null);
});
