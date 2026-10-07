'use strict';

/**
 * 検索候補（サジェスト）のテスト
 *
 * 以前はブラウザが suggestqueries.google.com へ JSONP で直に行っていたが、
 * IPブロック環境ではそれも落ちて候補が一切出なかった。
 * サーバ側（/api/suggest）に移し、駄目なら履歴で代替する。
 */
const test = require('node:test');
const assert = require('node:assert');

const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8');
const home = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'home.html'), 'utf8');

/** index.js から候補まわりを取り出して単体で試す（サーバは起動しない） */
function loadSuggest({ fetchImpl, ytMeta = null, enabled = true, now } = {}) {
  const from = src.indexOf('const SUGGEST_ENDPOINTS');
  const to = src.indexOf('app.get("/api/suggest"');
  assert.ok(from > 0 && to > from, '候補の実装が見つかる');
  const code = src.slice(from, to)
    + '; return { parseSuggestBody, fetchSuggest, suggestCache, SUGGEST_ENDPOINTS };';
  return new Function('fetch', 'ytMeta', 'YT_META_ENABLED', 'Date', code)(
    fetchImpl, ytMeta, enabled,
    now ? { now: () => now() } : Date);
}

test('候補のJSONをほどける', () => {
  const { parseSuggestBody } = loadSuggest({ fetchImpl: async () => ({ ok: false }) });
  // 素のJSON配列
  assert.deepStrictEqual(parseSuggestBody('["a",[["a b",0],["a c",0]]]'), ['a b', 'a c']);
  // JSONPでラップされていてもほどける
  assert.deepStrictEqual(parseSuggestBody('google.suggest(["a",[["x",0]]])'), ['x']);
  // 空・壊れ
  assert.deepStrictEqual(parseSuggestBody(''), []);
  assert.deepStrictEqual(parseSuggestBody('["a",[]]'), []);
  assert.throws(() => parseSuggestBody('not json'));
});

test('候補は長すぎるものや空白を落とす', () => {
  const { parseSuggestBody } = loadSuggest({ fetchImpl: async () => ({ ok: false }) });
  const long = 'x'.repeat(200);
  const body = JSON.stringify(['q', [[long, 0], ['  ', 0], ['ok', 0]]]);
  const out = parseSuggestBody(body);
  assert.ok(out.includes('ok'));
  assert.ok(out.every((t) => t.length <= 120));
  assert.ok(!out.includes('  '));
});

test('取れた候補はキャッシュされ、2回目は外に出ない', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, text: async () => JSON.stringify(['q', [['候補1', 0], ['候補2', 0]]]) };
  };
  const { fetchSuggest } = loadSuggest({ fetchImpl, ytMeta: { fetchImpl }, enabled: true });

  const first = await fetchSuggest('test');
  assert.deepStrictEqual(first.items, ['候補1', '候補2']);
  assert.strictEqual(first.source, 'remote');
  assert.strictEqual(calls, 1);

  const second = await fetchSuggest('test');
  assert.deepStrictEqual(second.items, ['候補1', '候補2']);
  assert.strictEqual(second.source, 'cache');
  assert.strictEqual(calls, 1, '2回目は外に取りに行かない');
});

test('期限が切れたらもう一度取りに行く', async () => {
  let calls = 0;
  let clock = 1000000;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, text: async () => JSON.stringify(['q', [['あ', 0]]]) };
  };
  const { fetchSuggest } = loadSuggest({
    fetchImpl,
    ytMeta: { fetchImpl },
    enabled: true,
    now: () => clock,
  });

  await fetchSuggest('x');
  assert.strictEqual(calls, 1);
  clock += 11 * 60 * 1000; // TTL(10分)を過ぎる
  const again = await fetchSuggest('x');
  assert.strictEqual(calls, 2);
  assert.strictEqual(again.source, 'remote');
});

test('ブロックされていても空を返す（500にしない・落ちない）', async () => {
  const fail = async () => { throw new Error('ECONNRESET'); };
  const { fetchSuggest } = loadSuggest({ fetchImpl: fail, ytMeta: { fetchImpl: fail }, enabled: true });
  const out = await fetchSuggest('test');
  assert.deepStrictEqual(out, { items: [], source: 'none' });

  const denied = async () => ({ ok: false, status: 403, text: async () => '' });
  const out2 = await loadSuggest({ fetchImpl: denied, ytMeta: { fetchImpl: denied }, enabled: true })
    .fetchSuggest('test');
  assert.deepStrictEqual(out2, { items: [], source: 'none' });
});

test('候補は空でも全候補元を試す', async () => {
  const tried = [];
  const empty = async (url) => {
    tried.push(url);
    return { ok: true, text: async () => '["q",[]]' };
  };
  const { fetchSuggest, SUGGEST_ENDPOINTS } = loadSuggest({ fetchImpl: empty, ytMeta: { fetchImpl: empty }, enabled: true });
  await fetchSuggest('test');
  assert.strictEqual(tried.length, SUGGEST_ENDPOINTS.length, '全部の候補元を試す');
  assert.ok(SUGGEST_ENDPOINTS.length >= 1);
});

test('メタデータの経路が無効なら素の fetch を使う', async () => {
  const seen = [];
  const fetchImpl = async (url) => { seen.push(url); return { ok: false }; };
  const { fetchSuggest } = loadSuggest({ fetchImpl, ytMeta: null, enabled: false });
  await fetchSuggest('test');
  assert.ok(seen.length >= 1, 'fetch が呼ばれる');
});

test('/api/suggest はJSONを返す', () => {
  const block = src.slice(src.indexOf('app.get("/api/suggest"'), src.indexOf('app.get("/api/meta-stats"'));
  assert.match(block, /res\.json\(\{ query: q, \.\.\.out \}\)/, '候補をJSONで返す');
  assert.match(block, /catch \(err\)/, '失敗しても落ちない');
  assert.match(block, /res\.json\(\{ query: q, items: \[\], source: 'none' \}\)/, '失敗時は空を返す');
  assert.match(block, /\.trim\(\)\.slice\(0, 100\)/, '長すぎる入力は切る');
});

test('フロントは JSONP をやめて /api/suggest を使う', () => {
  assert.doesNotMatch(home, /https:\/\/suggestqueries/, 'ブラウザから直に取りに行かない');
  assert.doesNotMatch(home, /suggestScript/, 'JSONP用のscriptタグを足さない');
  assert.doesNotMatch(home, /ytSuggestCallback/, 'JSONPのコールバックをやめる');
  assert.match(home, /fetch\(`\/api\/suggest\?q=/, 'サーバの端点を使う');
  // 取れなくても履歴で代替する
  assert.match(home, /function localSuggestions/, '履歴からの候補を持つ');
  assert.match(home, /LIB_SEARCH_HISTORY/, '検索履歴を参照する');
});

test('古い入力の結果で書き換えない', () => {
  assert.match(home, /suggestSeq/, '入力のたびに番号を振る');
  assert.match(home, /if \(seq !== suggestSeq\) return;/, '古い結果は捨てる');
});
