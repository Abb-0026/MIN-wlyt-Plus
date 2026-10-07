'use strict';

/** 検索の絞り込み（sp パラメータ）のテスト */
const test = require('node:test');
const assert = require('node:assert');
const { buildSearchParams, parseSearchParams, filtersFromQuery, CHOICES } = require('../lib/search-filters');

/** YouTube のURLで実際に見かける値と一致しているか（外に出られないので形で担保する） */
test('よく知られた sp の形になる', () => {
  // 並び替えだけ: sort=date → 08 02 → "CAI="
  assert.strictEqual(buildSearchParams({ sort: 'date' }), 'CAI=');
  assert.strictEqual(buildSearchParams({ sort: 'views' }), 'CAM=');
  assert.strictEqual(buildSearchParams({ sort: 'rating' }), 'CAE=');

  // フィルタだけ: 動画 → 12 02 10 01 → "EgIQAQ=="
  assert.strictEqual(buildSearchParams({ type: 'video' }), 'EgIQAQ==');
  assert.strictEqual(buildSearchParams({ type: 'channel' }), 'EgIQAg==');
  assert.strictEqual(buildSearchParams({ type: 'playlist' }), 'EgIQAw==');
  // 長さ: 短い(4分未満) / 長い(20分以上)
  assert.strictEqual(buildSearchParams({ duration: 'short' }), 'EgIYAQ==');
  assert.strictEqual(buildSearchParams({ duration: 'long' }), 'EgIYAg==');
  // 期間: 1時間以内/今日/今週/今月/今年
  assert.strictEqual(buildSearchParams({ uploadDate: 'lastHour' }), 'EgIIAQ==');
  assert.strictEqual(buildSearchParams({ uploadDate: 'today' }), 'EgIIAg==');
  assert.strictEqual(buildSearchParams({ uploadDate: 'thisWeek' }), 'EgIIAw==');
  assert.strictEqual(buildSearchParams({ uploadDate: 'thisMonth' }), 'EgIIBA==');
  assert.strictEqual(buildSearchParams({ uploadDate: 'thisYear' }), 'EgIIBQ==');
});

test('指定なしなら空文字（＝通常の検索と同じリクエストになる）', () => {
  assert.strictEqual(buildSearchParams(), '');
  assert.strictEqual(buildSearchParams({}), '');
  assert.strictEqual(buildSearchParams({ sort: 'relevance' }), '');
  assert.strictEqual(buildSearchParams({ sort: '', uploadDate: '', type: '', duration: '' }), '');
});

test('複数の条件を同時に指定できる', () => {
  // sort=date + 今週 + 動画 → 08 02 | 12 04 | 08 03 | 10 01
  const sp = buildSearchParams({ sort: 'date', uploadDate: 'thisWeek', type: 'video' });
  assert.strictEqual(sp, Buffer.from([0x08, 0x02, 0x12, 0x04, 0x08, 0x03, 0x10, 0x01]).toString('base64'));
});

test('作った sp は読み戻せる（往復する）', () => {
  const cond = { sort: 'views', uploadDate: 'thisYear', type: 'video', duration: 'long' };
  assert.deepStrictEqual(parseSearchParams(buildSearchParams(cond)), cond);

  const cond2 = { sort: 'date', uploadDate: 'today', type: 'playlist', duration: 'short' };
  assert.deepStrictEqual(parseSearchParams(buildSearchParams(cond2)), cond2);

  assert.deepStrictEqual(parseSearchParams(''), { sort: 'relevance', uploadDate: '', type: '', duration: '' });
});

test('未知の値は無視する（フロントからの変な入力で壊れない）', () => {
  assert.strictEqual(buildSearchParams({ sort: 'nonsense' }), '');
  assert.strictEqual(buildSearchParams({ type: '<script>' }), '');
  assert.strictEqual(buildSearchParams({ duration: 999 }), '');
  assert.strictEqual(buildSearchParams({ uploadDate: null }), '');
  // 数字を渡されても落ちない
  assert.strictEqual(typeof buildSearchParams({ sort: 2 }), 'string');
});

test('壊れた sp を読んでも例外を投げない', () => {
  const out = parseSearchParams('!!!not-base64!!!');
  assert.strictEqual(out.sort, 'relevance');
});

test('クエリから条件を取り出す（未入力は空・既定は関連度）', () => {
  assert.deepStrictEqual(filtersFromQuery({}), { sort: 'relevance', uploadDate: '', type: '', duration: '' });
  assert.deepStrictEqual(filtersFromQuery({ sort: 'date', date: 'today', type: 'video', duration: 'short' }),
    { sort: 'date', uploadDate: 'today', type: 'video', duration: 'short' });
  assert.deepStrictEqual(filtersFromQuery({ sort: '  ' }), { sort: 'relevance', uploadDate: '', type: '', duration: '' });
  assert.deepStrictEqual(filtersFromQuery({ date: undefined }), { sort: 'relevance', uploadDate: '', type: '', duration: '' });
});

test('フロントに出す一覧は実際に使える値だけ', () => {
  for (const [key, list] of Object.entries(CHOICES)) {
    for (const choice of list) {
      if (!choice.value || choice.value === 'relevance') continue; // '' と relevance は「指定なし」
      const cond = key === 'sort' ? { sort: choice.value } : { [key]: choice.value };
      assert.notStrictEqual(buildSearchParams(cond), '', `${key}=${choice.value} は使える`);
    }
  }
});

/* -------------------------------------------------- サーバとフロントのつながり */

const fs = require('fs');
const path = require('path');
const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const homeSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'home.html'), 'utf8');

test('/api/search は絞り込みを受け取って sp にする', () => {
  const block = indexSrc.slice(indexSrc.indexOf('app.get("/api/search"'), indexSrc.indexOf('app.get("/api/1-search"'));
  assert.match(block, /filtersFromQuery\(req\.query\)/, 'クエリから条件を取り出す');
  assert.match(block, /buildSearchParams\(filters\)/, 'sp を作る');
  assert.match(block, /ytMeta\.search\(query, \{ page, sp: sp \|\| undefined \}\)/, 'sp を渡す');
  // 絞り込みで0件でも「何も出ない」にしない
  assert.match(block, /filterApplied/, '絞り込みが効いたかを返す');
  assert.match(block, /ytMeta\.search\(query, \{ page \}\)/, '駄目なら絞り込みなしで再検索する');
});

test('フロントの一覧はサーバの CHOICES と一致している', () => {
  // home.html はページの読み込みを速くするため一覧を直書きしているので、ズレたらテストで気づく
  const block = homeSrc.slice(homeSrc.indexOf('const SEARCH_FILTERS = {'), homeSrc.indexOf('const FILTER_LABELS'));
  // 「1時間以内」はホームの使い勝手を考えて出していない（サーバ側では受け付ける）
  const OMITTED = ['lastHour'];
  for (const [key, list] of Object.entries(CHOICES)) {
    const htmlKey = key === 'uploadDate' ? 'date' : key;
    const m = block.match(new RegExp(`${htmlKey}:\\s*\\[([^\\]]*)\\]`, 's'));
    assert.ok(m, `${htmlKey} の選択肢が home.html にある`);

    // サーバが知らない値をフロントが送ってこないこと
    const values = [...m[1].matchAll(/value:\s*'([^']*)'/g)].map(x => x[1]);
    for (const v of values) {
      if (!v) continue; // ''=指定なし
      assert.ok(list.some(o => o.value === v), `${htmlKey}: ${v} はサーバが知っている値`);
    }
    // 逆に、サーバ側の選択肢がフロントから消えていないこと
    for (const choice of list) {
      if (!choice.value || OMITTED.includes(choice.value)) continue;
      assert.ok(values.includes(choice.value), `${htmlKey}: ${choice.label}(${choice.value}) が home.html にある`);
    }
  }
});

test('検索のURLは絞り込みを付け忘れない', () => {
  const loadContent = homeSrc.slice(
    homeSrc.indexOf('async function loadContent'),
    homeSrc.indexOf('async function loadPersonalizedFeed'));
  assert.ok(loadContent.length > 100, 'loadContent が見つかる');
  // 本検索とショートの追加取得は searchEndpoint() に集約する
  assert.match(loadContent, /searchEndpoint\(query, page\)/);
  assert.match(loadContent, /searchEndpoint\(currentQuery, p\)/);
  // 残ってよいのは「別カテゴリで補充する」1か所だけ（別のクエリなので絞り込みは付けない）
  const inline = loadContent.match(/\/api\/search\?q=/g) || [];
  assert.strictEqual(inline.length, 1, 'loadContent 内で直接 /api/search を書いてよいのは補充の1か所だけ');
  // パーソナライズ（履歴から作る検索）は絞り込みを付けない
  const personal = homeSrc.slice(homeSrc.indexOf('async function loadPersonalizedFeed'));
  assert.doesNotMatch(personal.slice(0, 3000), /searchEndpoint\(/, 'おすすめ欄には絞り込みを掛けない');
});

test('絞り込みはURLにも載る（再読み込みで消えない）', () => {
  assert.match(homeSrc, /function searchUrl\(/, 'URL生成の関数がある');
  assert.match(homeSrc, /pushState\(null, '', searchUrl\(q\)\)/, '検索時にURLへ反映する');
  assert.match(homeSrc, /function filtersFromUrl\(/, 'URLから読み戻す');
  assert.match(homeSrc, /filtersFromUrl\(\);/, '読み込み時に復元する');
});

test('絞り込みを外して再検索したときは一言出す', () => {
  assert.match(homeSrc, /filterNote/, 'お知らせを表示する');
  assert.match(homeSrc, /renderFilterBar\(\);/, 'クエリが変わったら絞り込み行も更新する');
});

test('/search を再読み込みしても 404 にならない', () => {
  // 絞り込みをURLに載せたので、共有・再読み込みで開かれても同じページを返す必要がある
  assert.match(indexSrc, /app\.get\("\/search", serveHome\)/, '/search ルートがある');
  assert.match(indexSrc, /app\.get\("\/", serveHome\)/, '/ と同じページを返す');
  const block = indexSrc.slice(indexSrc.indexOf('const serveHome'), indexSrc.indexOf('app.get("/api/trending"'));
  assert.match(block, /home\.html/, 'ホームを返す');
});
