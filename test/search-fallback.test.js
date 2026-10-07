'use strict';

/**
 * 従来経路（youtube-search-api）の結果整形のテスト
 *
 * youtube-search-api は { id, type, thumbnail, title, channelTitle,
 * shortBylineText, length, isLive } しか返さない。home.html は
 * viewCountText / publishedTimeText / lengthText / channelThumbnail を見るので、
 * ここで揃えないとカードに何も出ない（＝「チャンネルアイコンが表示されない」の根本原因）。
 */
const test = require('node:test');
const assert = require('node:assert');

// index.js から切り出したのと同じ実装（index.js は起動時にサーバを張るので直接読まない）
const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8');
const start = src.indexOf('function normalizeYtsItems');
const end = src.indexOf('/**', start);
// アイコンの使い回し（knownAvatar）は外から差し込む。ここでは「まだ何も知らない」状態にする。
const factory = new Function('textOf', 'knownAvatar', `${src.slice(start, end)}; return normalizeYtsItems;`);
const { textOf } = require('../lib/yt-innertube');
const normalizeYtsItems = factory(textOf, () => '');

/** youtube-search-api が実際に返す形 */
const ytsVideo = (id, title, channel, length) => ({
  id,
  type: 'video',
  thumbnail: { thumbnails: [{ url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, width: 336, height: 188 }] },
  title,
  channelTitle: channel,
  shortBylineText: { runs: [{ text: channel }] },
  length: { simpleText: length, accessibility: { accessibilityData: { label: '10分31秒' } } },
  isLive: false,
});

test('従来経路のitemを home.html が見る形に整える', () => {
  const out = normalizeYtsItems([ytsVideo('aaaaaaaaaaa', '動画A', 'Ch A', '10:31')]);
  assert.strictEqual(out.length, 1);
  const item = out[0];
  // length は {simpleText} のオブジェクトで来るので文字列にする
  assert.strictEqual(item.lengthText, '10:31');
  // 足りないフィールドは空文字で揃えておく（undefined のまま出さない）
  assert.strictEqual(item.viewCountText, '');
  assert.strictEqual(item.publishedTimeText, '');
  assert.strictEqual(item.channelThumbnail, '');
  assert.strictEqual(item.channelTitle, 'Ch A');
  assert.strictEqual(item.type, 'video');
  // 元のフィールドは消さない
  assert.strictEqual(item.thumbnail.thumbnails[0].url, 'https://i.ytimg.com/vi/aaaaaaaaaaa/hqdefault.jpg');
});

test('channelTitle が無いときは shortBylineText から補う', () => {
  const [item] = normalizeYtsItems([{ id: 'bbbbbbbbbbb', type: 'video', title: 't', shortBylineText: { runs: [{ text: 'Ch B' }] } }]);
  assert.strictEqual(item.channelTitle, 'Ch B');
});

test('channel / playlist はカードに混ぜない', () => {
  const items = [
    ytsVideo('aaaaaaaaaaa', 'v', 'c', '1:00'),
    { id: 'UCxxxxxxxxxxxxxxxxxxxxx', type: 'channel', title: 'ch' },
    { id: 'PLyyyyyyyyyyyyyyyyyyyyy', type: 'playlist', title: 'pl' },
  ];
  const out = normalizeYtsItems(items);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].id, 'aaaaaaaaaaa');
});

test('ゴミは捨てる', () => {
  assert.deepStrictEqual(normalizeYtsItems([null, {}, { id: 'x' }]).length, 1);
  assert.deepStrictEqual(normalizeYtsItems(null), []);
  assert.deepStrictEqual(normalizeYtsItems(undefined), []);
});

test('/api/trending は viewCountText が無くても結果を返す', () => {
  const block = src.slice(src.indexOf('app.get("/api/trending"'), src.indexOf('app.get("/api/search"'));
  // youtube-search-api は viewCountText を返さないので、それを条件にすると常に0件になる
  assert.doesNotMatch(block, /if \(item\.viewCountText\)/, 'viewCountText を必須にしない');
  assert.match(block, /legacySearch\(/, '従来経路の結果を整形して使う');
  assert.match(block, /seenIdsServer\.has\(item\.id\)/, 'id の重複排除は残す');
});

test('/api/channel は二重登録されていない（page が効く）', () => {
  const count = (src.match(/app\.get\("\/api\/channel"/g) || []).length;
  assert.strictEqual(count, 1, '同じルートが2つあると先に登録した方が page を無視する');
  const block = src.slice(src.indexOf('app.get("/api/channel"'));
  assert.match(block, /legacySearch\(channelName, 20, page\)/, 'page を渡す方だけ残す');
  assert.match(block, /legacySearch\(/, '従来経路も整形して使う');
});

test('/api/inv/channel は InnerTube を本線にし Invidious は保険', () => {
  const invAt = src.indexOf("app.get('/api/inv/channel/:name'");
  const nextAt = src.indexOf('\napp.get(', invAt + 10);
  assert.ok(invAt > 0 && nextAt > invAt, 'inv ルートが定義されている');
  const block = src.slice(invAt, nextAt);
  assert.match(block, /ytMeta\.channel\(/, 'InnerTube（検索・メタデータ専用）を先に試す');
  assert.match(block, /authorThumbnails/, 'チャンネルページが読む形に合わせる');
  assert.match(block, /INVIDIOUS_CHANNEL/, 'Invidious はフォールバックとして残す');
  // ストリーム取得は外部API依存のまま（InnerTube で player を叩かない）
  assert.doesNotMatch(block, /ytMeta\.player|innertube\/player/i);
});

test('登録者数は "12.3万人の登録者" から数値部分だけ取り出す', () => {
  const from = src.indexOf('function subCountForPage');
  const to = src.indexOf("app.get('/api/inv/channel/:name'");
  assert.ok(from > 0 && to > from, 'subCountForPage が定義されている');
  const fn = new Function(`${src.slice(from, to)}; return subCountForPage;`)();
  assert.strictEqual(fn('12.3万人の登録者'), '12.3万');
  assert.strictEqual(fn('1,234人の登録者'), '1,234');
  assert.strictEqual(fn('登録者 5.6万人'), '5.6万');
  assert.strictEqual(fn(''), '');
  assert.strictEqual(fn(null), '');
});
