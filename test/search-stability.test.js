'use strict';

/**
 * 「検索が0件になりにくい」ための工夫のテスト
 *
 * ブロック環境だと従来経路（youtube-search-api）は www.youtube.com へ直に行って
 * 毎回数秒ハングして終わる。その間にホームは0件のままになるので:
 *   1. 一度失敗したらしばらく使わない（無駄な外向き通信を止める）
 *   2. YouTube本体に拒否されている最中はそもそも試さない
 *   3. いつまでも待たせない（時間で切る）
 *   4. プロキシが死んでいただけなら一度だけ再挑戦する
 *   5. 取れた分が少なければ従来経路で補う（id重複は除く）
 */
const test = require('node:test');
const assert = require('node:assert');

function load({ yts, ytMeta = null, enabled = true, now, timeoutMs } = {}) {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8');
  const from = src.indexOf('const LEGACY_COOLDOWN');
  const to = src.indexOf('/** id が被らないように足す */');
  assert.ok(from > 0 && to > from, '従来経路の実装が見つかる');
  // mergeItems も一緒に取り込む
  const mergeTo = src.indexOf('/* ------------------------------------------------------------ 検索候補 */');
  const code = src.slice(from, mergeTo) + '; return { legacySearch, mergeItems, legacyIsDead, LEGACY_TIMEOUT, LEGACY_COOLDOWN };';
  return new Function('yts', 'ytMeta', 'YT_META_ENABLED', 'normalizeYtsItems', 'Date', 'process', code)(
    yts, ytMeta, enabled, (items) => (items || []).map((i) => ({ ...i, type: 'video' })),
    now ? { now: () => now(), LEGACY_TIMEOUT_UNUSED: 0 } && Object.assign(Object.create(Date), { now: () => now() }) : Date,
    { env: timeoutMs ? { YT_LEGACY_TIMEOUT: String(timeoutMs) } : {} });
}

test('従来経路が失敗したらしばらく呼ばない（外向き通信を増やさない）', async () => {
  let calls = 0;
  let clock = 1000;
  const yts = { GetListByKeyword: async () => { calls += 1; throw new Error('ECONNRESET'); } };
  const api = load({ yts, ytMeta: null, enabled: false, now: () => clock });

  assert.deepStrictEqual(await api.legacySearch('a'), []);
  assert.strictEqual(calls, 1);

  await api.legacySearch('a');
  await api.legacySearch('b');
  assert.strictEqual(calls, 1, '冷却中は呼ばない');

  clock += api.LEGACY_COOLDOWN + 1;
  await api.legacySearch('a');
  assert.strictEqual(calls, 2, '冷却が明けたらまた試す');
});

test('YouTube本体に拒否されている最中は従来経路を使わない', async () => {
  let calls = 0;
  const yts = { GetListByKeyword: async () => { calls += 1; return { items: [] }; } };
  const blocked = { isBlocked: true };
  await load({ yts, ytMeta: blocked, enabled: true }).legacySearch('a');
  assert.strictEqual(calls, 0, 'ブロック中は直アクセスを増やさない');

  const ok = { isBlocked: false };
  await load({ yts, ytMeta: ok, enabled: true }).legacySearch('a');
  assert.strictEqual(calls, 1, 'ブロックが解けたら使う');
});

test('従来経路が応答しないときは時間で切る（いつまでも待たせない）', async () => {
  const yts = { GetListByKeyword: () => new Promise(() => {}) }; // 永遠に返らない
  // テストでは待ち時間を縮めて試す（既定は4秒）
  const api = load({ yts, ytMeta: null, enabled: false, timeoutMs: 200 });
  const started = Date.now();
  const out = await api.legacySearch('a');
  const elapsed = Date.now() - started;
  assert.deepStrictEqual(out, []);
  assert.ok(elapsed < 1500, `早く諦める（${elapsed}ms）`);
  assert.ok(api.legacyIsDead(), '諦めたら冷却に入る');
});

test('従来経路が返した結果は整形される', async () => {
  const yts = {
    GetListByKeyword: async () => ({
      items: [{ id: 'aaaaaaaaaaa', type: 'video', title: 't', channelTitle: 'c', length: { simpleText: '3:00' } }],
    }),
  };
  const api = load({ yts, ytMeta: { isBlocked: false }, enabled: true });
  const out = await api.legacySearch('a');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].type, 'video');
});

test('id が被らないように足し合わせる', () => {
  const { mergeItems } = load({ yts: {}, ytMeta: null, enabled: false });
  const a = [{ id: '1' }, { id: '2' }];
  const b = [{ id: '2' }, { id: '3' }, { id: '4' }];
  assert.deepStrictEqual(mergeItems(a, b).map((x) => x.id), ['1', '2', '3', '4']);
  // 空・ゴミが混ざっても落ちない
  assert.deepStrictEqual(mergeItems(null, [null, {}, { id: 'x' }]).map((x) => x.id), ['x']);
  assert.deepStrictEqual(mergeItems([], []), []);
  // 上限を超えない
  assert.strictEqual(mergeItems([], Array.from({ length: 100 }, (_, i) => ({ id: String(i) }))).length, 60);
});

test('/api/search は段階的に粘る（絞り込み → 再挑戦 → 従来経路）', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8');
  const block = src.slice(src.indexOf('app.get("/api/search"'), src.indexOf('app.get("/api/recommendations"'));

  assert.match(block, /const fast = await fastMeta\(/, 'まず高速経路');
  assert.match(block, /!items\.length && wanted && sp/, '絞り込みで0件なら外してもう一度');
  assert.match(block, /transportFailures > 0/, 'プロキシ不通なら再挑戦');
  assert.match(block, /!ytMeta\.isBlocked/, 'YouTube本体に拒否されている時は再挑戦しない');
  assert.match(block, /items\.length < MIN_ITEMS/, '少なければ従来経路で補う');
  assert.match(block, /mergeItems\(items, extra\)/, '重複は除いて足す');
  assert.match(block, /source/, 'どこから取れたかを返す（実機検証で使う）');
  // 0件でも 500 の HTML を返さない
  assert.match(block, /res\.json\(\{ items: \[\], filters, filterApplied: false, source: "error" \}\)/);
});
