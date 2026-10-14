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

test('/api/search は専用リゾルバで追加経路と従来経路を併用する', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const resolver = src.slice(src.indexOf('/* SEARCH_ONLY_BEGIN */'), src.indexOf('/* SEARCH_ONLY_END */'));
  const block = src.slice(src.indexOf('app.get("/api/search"'), src.indexOf('app.get("/api/recommendations"'));
  const wiring = src.slice(src.indexOf('const searchResolver ='), src.indexOf('// 動的レスポンス'));

  assert.match(block, /searchResolver\.search\(query, \{ page, sp \}\)/);
  assert.match(wiring, /fastMeta\(/, '高速経路を残す');
  assert.match(wiring, /wistaSearch\.search/, 'Wista を検索専用で追加');
  assert.match(wiring, /legacySearch\(query, limit, page\)/, '従来経路も残す');
  assert.match(wiring, /transportFailures > 0/);
  assert.match(wiring, /!ytMeta\.isBlocked/);
  assert.match(resolver, /result\.items\.length < MIN_ITEMS/);
  assert.match(resolver, /mergeItems\(result\.items, extra\.items\)/);
  assert.match(block, /res\.json\(\{ items: \[\], filters, filterApplied: false, source: "error", page, hasMore: false, nextPage: null \}\)/);
});


/* 新しいファイルを増やさず、index.js の検索専用ブロックをサーバ起動なしで検証する。 */
function loadSearchAdapters() {
  const fs = require('node:fs');
  const path = require('node:path');
  const indexPath = path.join(__dirname, '..', 'index.js');
  const src = fs.readFileSync(indexPath, 'utf8');
  const from = src.indexOf('/* SEARCH_ONLY_BEGIN */');
  const to = src.indexOf('/* SEARCH_ONLY_END */');
  assert.ok(from >= 0 && to > from, '検索専用ブロックが存在する');
  const code = src.slice(from, to)
    .replace('const { WistaSearch, SearchResolver } =', 'const adapters =')
    .replace('return { WistaSearch, SearchResolver };',
      'return { WistaSearch, SearchResolver, DEFAULT_SEARCH_BASES, normalizeWistaItems, firstWithItems, FILTER_NOTE };');
  return new Function('require', code + '; return adapters;')(require('node:module').createRequire(indexPath));
}

/* Wista検索専用アダプタ（既存テストへ統合） */
{
  const test = require('node:test');
  const assert = require('node:assert/strict');
  const { WistaSearch, DEFAULT_SEARCH_BASES, normalizeWistaItems } = loadSearchAdapters();

  const ID = 'abcdefghijk';
  const BASES = ['https://one.example', 'https://two.example', 'https://three.example'];
  const video = (id = ID, extra = {}) => ({
    type: 'Video', id, title: { text: '日本語の動画 <test> & "引用"' },
    author: { id: 'UCtest', name: 'チャンネル', thumbnails: [{ url: 'https://yt3.ggpht.com/icon', width: 88 }] },
    thumbnails: [{ url: 'https://i.ytimg.com/small.jpg', width: 120 }, { url: 'https://i.ytimg.com/large.jpg', width: 480 }],
    duration: { text: '10:31', seconds: 631 }, view_count: { text: '1,234回視聴' }, published: { text: '1日前' },
    endpoint: { metadata: { api_url: '/player' }, payload: { url: 'https://example.com/not-used' } },
    ...extra,
  });
  const response = (videos = [video()], extra = {}) => ({
    ok: true, status: 200, json: async () => ({ videos, nextPageToken: 2, ...extra }),
  });
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  test('指定の5台が検索専用の既定取得元になっている', () => {
    assert.deepEqual(DEFAULT_SEARCH_BASES, [
      'https://wista-yt-api-ls13.onrender.com', 'https://wista-yt-api-vdjb.onrender.com',
      'https://wista-yt-api-n85t.onrender.com', 'https://wista-yt-api-0jl8.onrender.com',
      'https://wista-yt-api.onrender.com',
    ]);
  });

  test('実際の Text / Author / Duration 形式を既存カードの形へ正規化する', () => {
    const [item] = normalizeWistaItems([video()]);
    assert.equal(item.id, ID);
    assert.equal(item.type, 'video');
    assert.equal(item.title, '日本語の動画 <test> & "引用"');
    assert.equal(item.channelTitle, 'チャンネル');
    assert.equal(item.channelId, 'UCtest');
    assert.equal(item.channelThumbnail, 'https://yt3.ggpht.com/icon');
    assert.equal(item.thumbnail.thumbnails[0].url, 'https://i.ytimg.com/large.jpg');
    assert.equal(item.lengthText, '10:31');
    assert.equal(item.viewCountText, '1,234回視聴');
    assert.equal(item.publishedTimeText, '1日前');
    assert.equal(item.endpoint, undefined, '上流の再生関連情報を持ち込まない');
  });

  test('runs・秒数だけの長さ・ライブ・Shorts・画像欠損にも対応する', () => {
    const [item] = normalizeWistaItems([video(ID, {
      title: { runs: [{ text: 'Hello ' }, { text: '世界' }] }, duration: { seconds: 3661 },
      author: { name: 'ch', thumbnails: [{ url: 'javascript:alert(1)' }] }, thumbnails: [],
    })]);
    assert.equal(item.title, 'Hello 世界');
    assert.equal(item.lengthText, '1:01:01');
    assert.equal(item.channelThumbnail, '');
    assert.equal(item.thumbnail.thumbnails[0].url, `https://i.ytimg.com/vi/${ID}/hqdefault.jpg`);
    assert.equal(normalizeWistaItems([video(ID, { type: 'Shorts' })])[0].isShort, true);
    assert.equal(normalizeWistaItems([video(ID, { is_live: true })])[0].lengthText, 'ライブ');
    assert.equal(normalizeWistaItems([video(ID, { badges: [{ style: 'BADGE_STYLE_TYPE_LIVE_NOW' }] })])[0].isLive, true);
  });

  test('重複・動画以外・不正ID・不正な画像URLを除く', () => {
    assert.equal(normalizeWistaItems([null, {}, video(), video(), video('bad'), video('12345678901', { type: 'Channel' })]).length, 1);
    assert.deepEqual(normalizeWistaItems(null), []);
    const [item] = normalizeWistaItems([video(ID, { channelThumbnail: 'data:text/html,evil', author: {} })]);
    assert.equal(item.channelThumbnail, '');
  });

  test('GET /api/search の q と page だけを送り、0始まりを1始まりへ変換する', async () => {
    const calls = [];
    const api = new WistaSearch({ bases: [BASES[0]], fetchImpl: async (url, options) => {
      calls.push({ url: new URL(url), options });
      return response(undefined, { nextPageToken: 3 });
    } });
    const out = await api.search(' 日本語 + & #猫 ', { page: 1, sp: 'not-sent', type: 'video' });
    assert.equal(calls[0].url.pathname, '/api/search');
    assert.equal(calls[0].url.searchParams.get('q'), '日本語 + & #猫');
    assert.equal(calls[0].url.searchParams.get('page'), '2');
    assert.deepEqual([...calls[0].url.searchParams.keys()].sort(), ['page', 'q']);
    assert.equal(calls[0].options.method, 'GET');
    assert.equal(out.hasMore, true);
    assert.equal(out.nextPage, 2);
  });

  test('速い1台が返れば残り4台を無駄に呼ばない', async () => {
    let calls = 0;
    const api = new WistaSearch({ fetchImpl: async () => { calls++; return response(); } });
    await api.search('music');
    await delay(10);
    assert.equal(calls, 1);
  });

  test('0件が先に返っても、他の取得元の有効な検索結果を待つ', async () => {
    const calls = [];
    const api = new WistaSearch({ bases: BASES, fetchImpl: async (url) => {
      calls.push(url);
      return calls.length === 1 ? response([]) : response();
    } });
    const out = await api.search('music');
    assert.equal(out.items.length, 1);
    assert.equal(calls.length, 2);
  });

  test('遅い主系にはヘッジし、成功後は敗者を実際に中断する', async () => {
    const calls = [];
    const api = new WistaSearch({ bases: BASES, hedgeMs: 5, timeout: 1000, fetchImpl: (url, options) => {
      calls.push({ url, signal: options.signal });
      return calls.length === 1 ? new Promise(() => {}) : Promise.resolve(response());
    } });
    const start = Date.now();
    const out = await api.search('music');
    assert.equal(out.items.length, 1);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].signal.aborted, true);
    assert.ok(Date.now() - start < 500, 'ハングしている主系を待たない');
    assert.equal(api.hosts[0].failures, 0, 'レース敗者の中断は障害ではない');
  });

  test('JSON本文が止まった場合にもタイムアウトが効く', async () => {
    let calls = 0;
    const api = new WistaSearch({ bases: BASES.slice(0, 2), timeout: 20, hedgeMs: 100, fetchImpl: async () => {
      calls++;
      return calls === 1 ? { ok: true, json: () => new Promise(() => {}) } : response();
    } });
    const out = await api.search('body-timeout');
    assert.equal(out.items.length, 1);
    assert.equal(calls, 2);
    assert.equal(api.hosts[0].failures, 1);
  });

  test('HTML・HTTPエラー・壊れたJSONを飛ばして次の取得元へ進む', async () => {
    let calls = 0;
    const api = new WistaSearch({ bases: [...BASES, 'https://four.example'], fetchImpl: async () => {
      calls++;
      if (calls === 1) return { ok: false, status: 503 };
      if (calls === 2) return { ok: true, json: async () => { throw new Error('HTML'); } };
      if (calls === 3) return { ok: true, json: async () => ({ items: [] }) };
      return response();
    } });
    assert.equal((await api.search('recover')).items.length, 1);
    assert.equal(calls, 4);
  });

  test('全台不通でも全体の締め切りで返り、残りの接続を中断する', async () => {
    const signals = [];
    const api = new WistaSearch({ bases: BASES, timeout: 1000, deadline: 30, hedgeMs: 5, fetchImpl: (_, options) => {
      signals.push(options.signal);
      return new Promise(() => {});
    } });
    const started = Date.now();
    const out = await api.search('hung');
    assert.equal(out.failed, true);
    assert.deepEqual(out.items, []);
    assert.ok(Date.now() - started < 500);
    assert.ok(signals.every((signal) => signal.aborted));
  });

  test('障害ホストを冷却し、冷却後は再び試す', async () => {
    let clock = 1000;
    let failures = 0;
    const api = new WistaSearch({ bases: BASES.slice(0, 2), now: () => clock, cooldown: 100, fetchImpl: async (url) => {
      if (url.startsWith(BASES[0])) { failures++; return { ok: false, status: 429 }; }
      return response();
    } });
    await api.search('a');
    await api.search('b');
    assert.equal(failures, 1);
    clock += 101;
    await api.search('c');
    assert.equal(failures, 2);
  });

  test('同じ検索は single-flight + TTL、ページ別には別のキャッシュを使う', async () => {
    let calls = 0;
    let clock = 1000;
    const pages = [];
    const api = new WistaSearch({ bases: [BASES[0]], ttl: 100, now: () => clock, fetchImpl: async (url) => {
      calls++; pages.push(new URL(url).searchParams.get('page')); await delay(5); return response();
    } });
    const [a, b] = await Promise.all([api.search('music'), api.search('music')]);
    assert.equal(a, b);
    await api.search('music');
    assert.equal(calls, 1);
    await api.search('music', { page: 1 });
    assert.deepEqual(pages, ['1', '2']);
    clock += 101;
    await api.search('music');
    assert.equal(calls, 3);
  });

  test('正常な0件は短時間だけ記憶し、障害による0件を長期キャッシュしない', async () => {
    let clock = 1000;
    let calls = 0;
    const api = new WistaSearch({ bases: [BASES[0]], now: () => clock, fetchImpl: async () => { calls++; return response([]); } });
    assert.equal((await api.search('nothing')).failed, false);
    await api.search('nothing');
    assert.equal(calls, 1);
    clock += 10001;
    await api.search('nothing');
    assert.equal(calls, 2);
  });

  test('継続なし・自己ループする継続・page上限では無限取得を止める', async () => {
    for (const token of [null, '', '1', 'not-a-number']) {
      const api = new WistaSearch({ bases: [BASES[0]], fetchImpl: async () => response(undefined, { nextPageToken: token }) });
      assert.equal((await api.search('music')).hasMore, false, String(token));
    }
    const api = new WistaSearch({ bases: [BASES[0]], fetchImpl: async () => response(undefined, { nextPageToken: 102 }) });
    assert.equal((await api.search('music', { page: 100 })).hasMore, false);
  });

  test('無効化・空検索・不正ページでは外向き通信しない', async () => {
    let calls = 0;
    const api = new WistaSearch({ fetchImpl: () => { calls++; throw new Error('must not call'); } });
    for (const page of [-1, 101, 0.5, NaN, '1']) await api.search('q', { page });
    await api.search(' ');
    api.enabled = false;
    await api.search('q');
    assert.equal(calls, 0);
  });

  test('実際の ShortsLockupView も id・タイトル・再生数を取り出して検索結果に残す', () => {
    const short = {
      type: 'ShortsLockupView', entity_id: `shorts-shelf-item-${ID}`, thumbnail: [],
      overlay_metadata: { primary_text: { text: '猫のショート' }, secondary_text: { text: '123万回視聴' } },
      on_tap_endpoint: { payload: { videoId: ID, thumbnail: { thumbnails: [{ url: `https://i.ytimg.com/vi/${ID}/frame0.jpg`, width: 1080 }] }, playerParams: 'not-used' } },
      inline_player_data: { payload: { url: 'https://example.com/not-used' } },
    };
    const [item] = normalizeWistaItems([short]);
    assert.equal(item.id, ID);
    assert.equal(item.title, '猫のショート');
    assert.equal(item.viewCountText, '123万回視聴');
    assert.equal(item.isShort, true);
    assert.equal(item.thumbnail.thumbnails[0].url, `https://i.ytimg.com/vi/${ID}/frame0.jpg`);
    assert.equal(item.on_tap_endpoint, undefined);
    assert.equal(item.inline_player_data, undefined);
    delete short.on_tap_endpoint;
    assert.equal(normalizeWistaItems([short])[0].id, ID, 'entity_id からも復元できる');
  });
}

/* 検索経路の選択とキャッシュ（既存テストへ統合） */
{
  const test = require('node:test');
  const assert = require('node:assert/strict');
  const { SearchResolver, firstWithItems, FILTER_NOTE } = loadSearchAdapters();

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const items = (n = 8, offset = 0) => Array.from({ length: n }, (_, i) => ({ id: String(i + offset).padStart(11, '0'), title: `動画${i + offset}` }));
  const make = (options = {}) => new SearchResolver({
    primarySearch: async () => null, wistaSearch: async () => null, legacySearch: async () => [],
    hedgeMs: 5, primaryTimeout: 50, retryTimeout: 25, legacyTimeout: 25, supplementWait: 5, deadline: 150,
    ...options,
  });

  test('レースでは0件や例外を成功と見なさない', async () => {
    const out = await firstWithItems([Promise.resolve({ items: [] }), Promise.reject(new Error('bad')), delay(5).then(() => ({ items: items() }))]);
    assert.equal(out.items.length, 8);
    assert.equal(await firstWithItems([]), null);
  });

  test('速い InnerTube の結果が十分あれば Wista も従来経路も呼ばない', async () => {
    let remote = 0;
    let legacy = 0;
    const api = make({
      primarySearch: async () => ({ items: items(), continuation: 'next' }),
      wistaSearch: async () => { remote++; return null; }, legacySearch: async () => { legacy++; return []; },
    });
    const out = await api.search('q');
    await delay(10);
    assert.equal(out.source, 'innertube');
    assert.equal(out.hasMore, true);
    assert.equal(out.nextPage, 1);
    assert.equal(remote, 0);
    assert.equal(legacy, 0);
  });

  test('InnerTube が遅くても Wista を先に返し、検索全体を直列待ちにしない', async () => {
    const api = make({ primaryTimeout: 1000, primarySearch: () => new Promise(() => {}),
      wistaSearch: async () => ({ items: items(), hasMore: true, nextPage: 1 }) });
    const start = Date.now();
    const out = await api.search('q');
    assert.equal(out.source, 'wista');
    assert.ok(Date.now() - start < 500);
    assert.equal(out.filterApplied, false);
  });

  test('絞り込み時は高速な Wista より条件に対応した InnerTube を優先する', async () => {
    const api = make({ primarySearch: async (_, opts) => {
      assert.equal(opts.sp, 'filtered'); await delay(20); return { items: items(1), continuation: null };
    }, wistaSearch: async () => ({ items: items() }) });
    const out = await api.search('q', { sp: 'filtered' });
    assert.equal(out.source, 'innertube');
    assert.equal(out.items.length, 1, '条件なしの動画を補充しない');
    assert.equal(out.filterApplied, true);
    assert.equal(out.filterNote, undefined);
  });

  test('絞り込み不能時に Wista を使った場合は必ず明示する', async () => {
    const api = make({ primarySearch: async () => { await delay(10); return null; },
      wistaSearch: async () => ({ items: items(), hasMore: false }) });
    const out = await api.search('q', { sp: 'filtered' });
    assert.equal(out.source, 'wista');
    assert.equal(out.filterApplied, false);
    assert.equal(out.filterNote, FILTER_NOTE);
    assert.equal(out.hasMore, false);
  });

  test('絞り込みで0件なら条件を外した InnerTube も使える（適用済みと偽らない）', async () => {
    const params = [];
    const api = make({ primarySearch: async (_, opts) => {
      params.push(opts.sp);
      return opts.sp ? null : { items: items() };
    } });
    const out = await api.search('q', { sp: 'filtered' });
    assert.deepEqual(params, ['filtered', undefined]);
    assert.equal(out.source, 'innertube');
    assert.equal(out.filterApplied, false);
    assert.equal(out.filterNote, FILTER_NOTE);
  });

  test('通信経路の不通なら一度だけ再挑戦できる', async () => {
    let calls = 0;
    const api = make({ shouldRetry: () => true, primarySearch: async () => {
      calls++; return calls === 2 ? { items: items() } : null;
    } });
    const out = await api.search('q');
    assert.equal(calls, 2);
    assert.equal(out.source, 'innertube-retry');
  });

  test('YouTube側に拒否されているなら再挑戦しない', async () => {
    let calls = 0;
    const api = make({ shouldRetry: () => false, primarySearch: async () => { calls++; throw new Error('blocked'); } });
    assert.equal((await api.search('q')).items.length, 0);
    assert.equal(calls, 1);
  });

  test('少数の結果だけを、同じキーワードの Wista で順序を保って補う', async () => {
    const queries = [];
    const api = make({ primarySearch: async () => ({ items: items(2), continuation: null }),
      wistaSearch: async (q) => { queries.push(q); return { items: items(3, 1), hasMore: true, nextPage: 1 }; } });
    const out = await api.search('検索語');
    assert.deepEqual(queries, ['検索語']);
    assert.equal(out.source, 'mixed');
    assert.deepEqual(out.items.map(item => item.id), items(4).map(item => item.id));
    assert.equal(out.hasMore, true);
  });

  test('少数でも取得済みの結果を遅い補充のために長く待たせない', async () => {
    const api = make({ primarySearch: async () => ({ items: items(2) }), wistaSearch: () => new Promise(() => {}) });
    const start = Date.now();
    const out = await api.search('q');
    assert.equal(out.items.length, 2);
    assert.ok(Date.now() - start < 100);
  });

  test('従来経路は初回だけの保険として残り、ページ2以降に先頭を繰り返さない', async () => {
    let calls = 0;
    const api = make({ legacySearch: async (q, limit, page) => {
      calls++; assert.equal(page, 0); return items(3);
    } });
    const first = await api.search('q');
    assert.equal(first.source, 'legacy');
    assert.equal(first.hasMore, false);
    assert.equal(first.nextPage, null);
    assert.equal((await api.search('q', { page: 1 })).items.length, 0);
    assert.equal(calls, 1);
  });

  test('従来経路に落ちた場合も絞り込み不能のお知らせを返す', async () => {
    const api = make({ legacySearch: async () => items(3) });
    const out = await api.search('q', { sp: 'filtered' });
    assert.equal(out.source, 'legacy');
    assert.equal(out.filterApplied, false);
    assert.equal(out.filterNote, FILTER_NOTE);
  });

  test('同一検索を束ね、キーワード・page・絞り込みを別々にキャッシュする', async () => {
    let calls = 0;
    let clock = 1000;
    const api = make({ ttl: 100, now: () => clock, primarySearch: async () => {
      calls++; await delay(2); return { items: items() };
    } });
    const [a, b] = await Promise.all([api.search('q'), api.search('q')]);
    assert.equal(a, b);
    assert.equal(calls, 1);
    await api.search('q');
    assert.equal(calls, 1);
    await api.search('q', { page: 1 });
    await api.search('q', { sp: 'filtered' });
    await api.search('other');
    assert.equal(calls, 4);
    clock += 101;
    await api.search('q');
    assert.equal(calls, 5);
  });

  test('障害による0件をキャッシュせず、復旧直後に検索し直せる', async () => {
    let recovered = false;
    const api = make({ primarySearch: async () => recovered ? { items: items() } : null });
    assert.equal((await api.search('q')).source, 'none');
    recovered = true;
    assert.equal((await api.search('q')).source, 'innertube');
  });

  test('取得元が全部ハングしても全体の時間予算を超えない', async () => {
    const hung = () => new Promise(() => {});
    const api = make({ primarySearch: hung, wistaSearch: hung, legacySearch: hung, deadline: 40 });
    const start = Date.now();
    const out = await api.search('q');
    assert.equal(out.items.length, 0);
    assert.equal(out.hasMore, false);
    assert.ok(Date.now() - start < 500);
  });

  test('上限ページでは継続を停止する', async () => {
    const api = make({ primarySearch: async () => ({ items: items(), continuation: 'next' }) });
    const out = await api.search('q', { page: 100 });
    assert.equal(out.hasMore, false);
    assert.equal(out.nextPage, null);
  });
}

/* 検索画面の競合・ページ送り（既存テストへ統合） */
{
  const test = require('node:test');
  const assert = require('node:assert/strict');
  const vm = require('node:vm');
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'home.html'), 'utf8');
  const cut = (from, to) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));
  const item = (n, extra = {}) => ({ id: String(n).padStart(11, '0'), title: `動画${n}`, ...extra });
  const deferred = () => {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
  };
  const json = (data) => ({ ok: true, status: 200, json: async () => data });

  function element() {
    let html = '';
    return {
      style: {}, children: [], textContent: '', hidden: true,
      set innerHTML(value) { html = value; this.children = []; },
      get innerHTML() { return html; },
      appendChild(child) { this.children.push(child); },
    };
  }

  function load(fetchImpl, chips = []) {
    const grid = element();
    const note = element();
    const loading = element();
    const context = vm.createContext({
      AbortController, setTimeout, clearTimeout, console,
      fetch: fetchImpl, videoGrid: grid, shortsRow: element(), shortsSection: element(), loading,
      document: {
        getElementById: () => note, querySelectorAll: () => chips.map(q => ({ dataset: { q } })),
        createElement: () => element(),
      },
      shuffleArray: list => list,
      renderFilterBar: () => {}, updateShortsToggleUI: () => {},
      getThumbUrl: id => `/thumb/${id}`, esc: value => String(value || ''),
      createVideoCard: value => ({ id: value.id }),
      searchEndpoint: (q, page) => `/api/search?q=${encodeURIComponent(q)}&page=${page}`,
      getSubscribedChannels: () => ['履歴のチャンネル'], getHistoryKeywords: () => ({ channels: [], titleWords: [] }),
    });
    const state = cut('    let displayedIds = new Set();', '    /* ── 検索の絞り込み');
    const fetchCode = cut('    async function fetchFeedResponse(', '    function normalizeAndFilterList(');
    const normalize = cut('    function normalizeAndFilterList(', '    function updateShortsToggleUI(');
    const content = cut('    async function loadContent(', '    searchForm.onsubmit');
    const personalized = cut('    async function loadPersonalizedFeed(', '    // パーソナライズモードかどうか');
    vm.runInContext(`let shortsExpanded = true; let filterNote = '';\n${state}\n${fetchCode}\n${normalize}\n${content}\n${personalized}\n`
      + 'globalThis.api = { loadContent, loadPersonalizedFeed, fetchFeedResponse, state: () => ({ isFetching, hasMoreContent, nextContentPage, currentPage, ids: [...displayedIds] }) };', context);
    return { api: context.api, grid, note, loading };
  }

  const ids = ui => Array.from(ui.grid.children, card => card.id);

  test('検索結果が少なくても無関係なカテゴリを補充しない', async () => {
    const calls = [];
    const ui = load(async url => { calls.push(url); return json({ items: [item(1)], hasMore: false }); }, ['音楽', 'ゲーム']);
    await ui.api.loadContent('固有の検索語', 0);
    assert.equal(calls.length, 1);
    assert.deepEqual(ids(ui), [item(1).id]);
  });

  test('filterNote と hasMore を items 配列に変換する前に受け取る', async () => {
    const ui = load(async () => json({ items: [item(1)], hasMore: false, filterApplied: false, filterNote: '絞り込みなしで表示' }));
    await ui.api.loadContent('q', 0);
    assert.equal(ui.note.textContent, '絞り込みなしで表示');
    assert.equal(ui.note.hidden, false);
    assert.equal(ui.api.state().hasMoreContent, false);
  });

  test('検索中に別の検索をすると古いリクエストを中断して新しい検索を開始する', async () => {
    const a = deferred(); const b = deferred(); const signals = [];
    const ui = load((url, options) => {
      signals.push(options.signal);
      return url.includes('q=A') ? a.promise : b.promise;
    });
    const first = ui.api.loadContent('A', 0);
    const second = ui.api.loadContent('B', 0);
    assert.equal(signals.length, 2, 'isFetching だけを理由に再検索を無視しない');
    assert.equal(signals[0].aborted, true);
    a.resolve(json({ items: [item(1)] }));
    await first;
    assert.equal(ui.api.state().isFetching, true, '古い finally は新しい検索の状態を解除しない');
    assert.equal(ui.loading.style.display, 'block');
    b.resolve(json({ items: [item(2)], hasMore: false }));
    await second;
    assert.deepEqual(ids(ui), [item(2).id]);
    assert.equal(ui.api.state().isFetching, false);
  });

  test('古い検索が遅れて完了しても、新しい検索結果を上書きしない', async () => {
    const old = deferred();
    const ui = load(url => url.includes('q=old') ? old.promise : Promise.resolve(json({ items: [item(2)] })));
    const pending = ui.api.loadContent('old', 0);
    await ui.api.loadContent('new', 0);
    old.resolve(json({ items: [item(1)] }));
    await pending;
    assert.deepEqual(ids(ui), [item(2).id]);
  });

  test('パーソナライズ取得から検索へ切り替えても古いフィードを混ぜない', async () => {
    const pending = deferred();
    const ui = load(url => url.includes('q=new') ? Promise.resolve(json({ items: [item(9)] })) : pending.promise);
    const first = ui.api.loadPersonalizedFeed(0);
    await ui.api.loadContent('new', 0);
    pending.resolve(json({ items: [item(1)] }));
    await first;
    assert.deepEqual(ids(ui), [item(9).id]);
  });

  test('検索結果の関連度順を保持し、少数のShortsや # 付きタイトルも捨てない', async () => {
    const videos = [item(3, { title: '#ハッシュタグ' }), item(1, { type: 'short' }), item(2)];
    const calls = [];
    const ui = load(async url => { calls.push(url); return json({ items: videos, hasMore: false }); });
    await ui.api.loadContent('q', 0);
    assert.deepEqual(ids(ui), videos.map(video => video.id));
    assert.equal(calls.length, 1, 'Shortsを集めるために別ページを先読みしない');
  });

  test('hasMore=false の後は追加取得せず、新しい検索では再び取得できる', async () => {
    let calls = 0;
    const ui = load(async () => { calls++; return json({ items: [item(calls)], hasMore: false }); });
    await ui.api.loadContent('q', 0);
    await ui.api.loadContent('q', 1);
    assert.equal(calls, 1);
    await ui.api.loadContent('other', 0);
    assert.equal(calls, 2);
  });

  test('上流が同じページを繰り返しても重複を表示せず、2回で追加取得を停止する', async () => {
    let calls = 0;
    const ui = load(async () => { calls++; return json({ items: [item(1)], hasMore: true }); });
    for (let page = 0; page < 4; page++) await ui.api.loadContent('q', page);
    assert.equal(calls, 3);
    assert.deepEqual(ids(ui), [item(1).id]);
    assert.equal(ui.api.state().hasMoreContent, false);
  });

  test('サーバーから受け取った次ページ番号を保つ', async () => {
    const ui = load(async () => json({ items: [item(1)], hasMore: true, nextPage: 3 }));
    await ui.api.loadContent('q', 0);
    assert.equal(ui.api.state().nextContentPage, 3);
  });

  test('通信失敗を通知してローディングを必ず解除する', async () => {
    const ui = load(async () => ({ ok: false, status: 503 }));
    await ui.api.loadContent('q', 0);
    assert.match(ui.grid.innerHTML, /検索に失敗/);
    assert.equal(ui.api.state().isFetching, false);
    assert.equal(ui.loading.style.display, 'none');
  });

  test('検索のURL更新・戻る進むの復元処理が残り、インラインJSも構文として成立する', () => {
    const script = [...src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]).find(body => body.includes('async function loadContent'));
    assert.ok(script);
    assert.doesNotThrow(() => new vm.Script(script));
    assert.match(script, /history\.replaceState\(null, '', searchUrl\(currentQuery\)\)/);
    assert.match(script, /addEventListener\('popstate'/);
    assert.match(script, /hasMoreContent/);
  });
}

/* Express検索APIの結合検証（既存テストへ統合） */
{
  /** 外部ネットワークを使わず、実際の Express ルートと Wista アダプタを接続する。 */
  const test = require('node:test');
  const assert = require('node:assert/strict');
  const http = require('node:http');
  const { spawn } = require('node:child_process');
  const path = require('node:path');
  const fs = require('node:fs');

  const ROOT = path.resolve(__dirname, '..');
  let upstream;
  let app;
  let base;
  const calls = [];
  const unexpected = [];
  const listen = (server) => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  const close = (server) => new Promise(resolve => server.close(resolve));
  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  async function ready(url) {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(url)).ok) return; } catch (_) { /* 起動待ち */ }
      await delay(100);
    }
    throw new Error('Search test app did not start');
  }

  test.before(async () => {
    upstream = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://mock');
      res.setHeader('Content-Type', 'application/json');
      if (url.pathname === '/list') return res.end('[]');
      if (url.pathname !== '/api/search') { unexpected.push(url.pathname); res.statusCode = 404; return res.end('{}'); }
      calls.push({ path: url.pathname, q: url.searchParams.get('q'), page: url.searchParams.get('page'), method: req.method, keys: [...url.searchParams.keys()] });
      if (url.searchParams.get('q') === 'broken') { res.statusCode = 503; return res.end('{"error":"offline"}'); }
      const page = Number(url.searchParams.get('page'));
      res.end(JSON.stringify({ videos: [{
        type: 'Video', id: String(page).padStart(11, '0'), title: { text: 'モック検索動画' },
        author: { name: '検索テストch', thumbnails: [{ url: 'https://yt3.ggpht.com/mock-icon' }] },
        duration: { text: '3:21' }, view_count: { text: '1,234回視聴' }, published: { text: '今日' },
      }], nextPageToken: page + 1 }));
    });
    const upstreamPort = await listen(upstream);
    const reserve = http.createServer();
    const port = await listen(reserve);
    await close(reserve);
    base = `http://127.0.0.1:${port}`;
    app = spawn(process.execPath, [path.join(ROOT, 'index.js')], {
      cwd: ROOT, stdio: 'ignore', env: {
        ...process.env, PORT: String(port), NODE_ENV: 'test', YT_META: '0', YT_META_PROXY_AUTO: '0',
        YT_LEGACY_TIMEOUT: '300', WISTA_SEARCH: '1', WISTA_SEARCH_TIMEOUT: '300',
        WISTA_SEARCH_URLS: `http://127.0.0.1:${upstreamPort}`, MIN_TUBE_API_LIST: `http://127.0.0.1:${upstreamPort}/list`,
      },
    });
    await ready(`${base}/healthz`);
  });

  test.after(async () => {
    if (app) {
      const exited = new Promise(resolve => app.once('exit', resolve));
      app.kill();
      await exited;
    }
    if (upstream) await close(upstream);
  });

  const get = route => fetch(`${base}${route}`);

  test('YouTube側の取得を無効にしても指定の検索経路で検索できる', async () => {
    const query = ' 日本語 & +検索 ';
    const res = await get(`/api/search?q=${encodeURIComponent(query)}&page=0`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('cache-control'), /no-store/);
    const body = await res.json();
    assert.equal(body.source, 'wista');
    assert.equal(body.items[0].title, 'モック検索動画');
    assert.equal(body.items[0].channelTitle, '検索テストch');
    assert.equal(body.items[0].channelThumbnail, 'https://yt3.ggpht.com/mock-icon');
    assert.equal(body.items[0].lengthText, '3:21');
    assert.equal(body.items[0].viewCountText, '1,234回視聴');
    assert.equal(body.items[0].publishedTimeText, '今日');
    assert.equal(body.hasMore, true);
    assert.equal(body.nextPage, 1);
    assert.equal(calls.at(-1).q, query.trim());
    assert.equal(calls.at(-1).page, '1');
    assert.equal(calls.at(-1).method, 'GET');
  });

  test('page=1 は上流の page=2 に対応し、結果を繰り返さない', async () => {
    const body = await (await get('/api/search?q=paging&page=1')).json();
    assert.equal(body.items[0].id, '00000000002');
    assert.equal(body.page, 1);
    assert.equal(body.nextPage, 2);
    assert.equal(calls.at(-1).page, '2');
  });

  test('フィルターは Wista へ誤送信せず、適用できなかった旨を返す', async () => {
    const body = await (await get('/api/search?q=filtered&sort=date&date=today&duration=short&type=video')).json();
    assert.equal(body.source, 'wista');
    assert.equal(body.filterApplied, false);
    assert.match(body.filterNote, /絞り込みを適用できなかった/);
    assert.equal(body.filters.sort, 'date');
    assert.equal(body.filters.uploadDate, 'today');
    assert.deepEqual(calls.at(-1).keys.sort(), ['page', 'q']);
  });

  test('検索で取得したチャンネルアイコンを既存の記憶域にも保存する', async () => {
    const res = await fetch(`${base}/api/avatar?name=${encodeURIComponent('検索テストch')}`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://yt3.ggpht.com/mock-icon');
  });

  test('同一検索の再実行はキャッシュを利用する', async () => {
    await get('/api/search?q=cached');
    const before = calls.length;
    await get('/api/search?q=cached');
    assert.equal(calls.length, before);
  });

  test('空白・複数値・不正page・長すぎる検索語を400のJSONとして返す', async () => {
    const before = calls.length;
    for (const params of ['', 'q=%20%20', 'q=a&q=b', 'q=a&page=-1', 'q=a&page=1.5', 'q=a&page=1x',
      'q=a&page=101', 'q=a&page=1&page=2', `q=${'a'.repeat(201)}`]) {
      const res = await get(`/api/search?${params}`);
      assert.equal(res.status, 400, params);
      assert.ok(Array.isArray((await res.json()).items));
    }
    assert.equal(calls.length, before);
  });

  test('全取得元が失敗してもHTMLエラーにせず、終端のJSONを返す', async () => {
    const res = await get('/api/search?q=broken&page=1');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    const body = await res.json();
    assert.deepEqual(body.items, []);
    assert.equal(body.hasMore, false);
    assert.equal(body.nextPage, null);
    assert.deepEqual(unexpected, []);
  });

  test('Wista を検索以外のルートやストリーム取得元に配線していない', () => {
    const src = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
    const resolver = fs.readFileSync(path.join(ROOT, 'lib', 'stream-resolver.js'), 'utf8');
    assert.doesNotMatch(resolver, /wistaSearch|WistaSearch|wista-yt-api/);
    for (const route of ['/api/trending', '/api/recommendations', '/api/comments/:videoId', '/api/channel', '/api/suggest']) {
      const from = src.indexOf(`app.get("${route}"`);
      assert.notEqual(from, -1, route);
      const to = src.indexOf('\napp.get(', from + 10);
      assert.doesNotMatch(src.slice(from, to < 0 ? undefined : to), /wistaSearch|searchResolver/, route);
    }
  });
}
