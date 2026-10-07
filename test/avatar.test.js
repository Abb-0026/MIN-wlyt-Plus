'use strict';

/**
 * チャンネルアイコンのテスト
 *
 * 「アイコンが表示されない」原因は3つあった:
 *   1) 検索結果の lockupViewModel からアバターを取れていなかった（yt-innertube.test.js）
 *   2) 従来経路（youtube-search-api）はアイコンを返さないのに home.html は読んでいた
 *   3) プレースホルダを ui-avatars.com に依存していた（ブロック環境で消える）
 * ここでは 2) と 3) を扱う。
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8');

/** index.js から関数を取り出して単体で試す（サーバは起動しない） */
function extract() {
  // アイコンまわりの定義は2か所に分かれているので両方つなげる
  const memFrom = src.indexOf('const AVATAR_TTL');
  const normFrom = src.indexOf('function normalizeYtsItems');
  const normTo = src.indexOf('/**', normFrom);
  const colFrom = src.indexOf('const AVATAR_COLORS');
  const colTo = src.indexOf('app.get("/api/avatar"');
  assert.ok(memFrom > 0 && normFrom > memFrom && normTo > normFrom, '記憶域と整形関数が見つかる');
  assert.ok(colFrom > 0 && colTo > colFrom, 'プレースホルダの色定義が見つかる');
  const code = src.slice(memFrom, normFrom) + src.slice(normFrom, normTo) + src.slice(colFrom, colTo)
    + '; return { rememberAvatars, fillAvatars, knownAvatar, avatarInitial, avatarColor, normalizeYtsItems };';
  // normalizeYtsItems は lib/yt-innertube の textOf を使うので外から渡す
  return new Function('textOf', code)(require('../lib/yt-innertube').textOf);
}

test('ブロック環境でも従来経路のアイコンを埋められる（記憶したものを使い回す）', () => {
  const { rememberAvatars, knownAvatar, normalizeYtsItems } = extract();
  rememberAvatars([
    { channelTitle: 'Ch A', channelThumbnail: 'https://yt3.ggpht.com/a=s88' },
    { channel: 'Ch B', avatar: 'https://yt3.ggpht.com/b=s88' },
  ]);
  assert.strictEqual(knownAvatar('Ch A'), 'https://yt3.ggpht.com/a=s88');
  assert.strictEqual(knownAvatar('ch a'), 'https://yt3.ggpht.com/a=s88', '大文字小文字を無視');
  assert.strictEqual(knownAvatar('Ch B'), 'https://yt3.ggpht.com/b=s88');
  assert.strictEqual(knownAvatar('Ch Z'), '', '知らないチャンネルは空のまま');

  // 従来経路の結果にアイコンを補える
  const out = normalizeYtsItems([{ id: 'aaaaaaaaaaa', type: 'video', title: 't', channelTitle: 'Ch A' }]);
  assert.strictEqual(out[0].channelThumbnail, 'https://yt3.ggpht.com/a=s88');
});

test('記憶したアイコンは有効期限で消える', () => {
  const { rememberAvatars, knownAvatar } = extract();
  rememberAvatars([{ channelTitle: 'Old Ch', channelThumbnail: 'https://yt3.ggpht.com/old=s88' }]);
  assert.match(knownAvatar('Old Ch'), /yt3/);
  // AVATAR_TTL を過ぎた想定にするため、at を直接書き換えるのは難しいので
  // 8日後に進んだ Date.now を差し替えて確認する
  const realNow = Date.now;
  Date.now = () => realNow() + 8 * 24 * 60 * 60 * 1000;
  try {
    assert.strictEqual(knownAvatar('Old Ch'), '');
  } finally {
    Date.now = realNow;
  }
});

test('頭文字と色は名前から安定して決まる', () => {
  const { avatarInitial, avatarColor } = extract();
  assert.strictEqual(avatarInitial('min wlyt'), 'M');
  assert.strictEqual(avatarInitial(''), '?', '空なら ? を出す');
  assert.strictEqual(avatarInitial('🎵music'), '🎵', '絵文字も1文字として扱う');
  assert.strictEqual(avatarColor('Ch A'), avatarColor('Ch A'), '同じ名前なら同じ色');
  assert.notStrictEqual(avatarColor('Ch A'), avatarColor('Ch B'));
  assert.match(avatarColor('Ch A'), /^#[0-9a-f]{6}$/);
});

test('/api/avatar は外部サービスに依存しない', () => {
  const block = src.slice(src.indexOf('app.get("/api/avatar"'), src.indexOf('app.get("/api/meta-stats"'));
  assert.match(block, /image\/svg\+xml/, 'SVGを自前で返す');
  assert.doesNotMatch(block, /ui-avatars/, 'ui-avatars.com を叩かない');
  // 頭文字は利用者入力なので必ず逃がす（SVGはスクリプトを実行できる）
  assert.match(block, /safeInitial/, 'XMLエスケープを通す');
  assert.match(block, /redirect\(302, known\)/, '実アイコンを知っていればそちらへ飛ばす');
  assert.match(block, /\^https\?:\\\/\\\//, 'リダイレクト先は http(s) のみ');
});

test('フロントも ui-avatars.com を直に叩かない', () => {
  const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'home.html'), 'utf8');
  assert.doesNotMatch(html, /https:\/\/ui-avatars\.com/, 'ブロック環境で落ちる外部依存をやめる');
  assert.match(html, /\/api\/avatar\?name=/, '自前の端点を使う');
});

test('/api/avatar は実際にSVGを返す', () => {
  // サーバを張らずにハンドラ本体だけ動かす簡易版
  const from = src.indexOf('(req, res) => {', src.indexOf('app.get("/api/avatar"'));
  const to = src.indexOf('\n});', from);
  assert.ok(from > 0 && to > from, '/api/avatar のハンドラが見つかる');
  const body = src.slice(src.indexOf('{', from) + 1, to);
  const { knownAvatar, avatarInitial, avatarColor } = extract();
  const AVATAR_COLORS = ['#ff0000', '#ff6d00', '#ffd600', '#00c853', '#00b0ff', '#651fff', '#d500f9', '#f50057'];
  const handler = new Function('req', 'res', 'knownAvatar', 'avatarInitial', 'avatarColor', 'AVATAR_COLORS', body);
  const call = (name, known = () => '') => {
    const res = {
      redirected: null, headers: null, body: null,
      redirect(code, url) { this.redirected = { code, url }; return this; },
      set(h) { this.headers = h; return this; },
      end(b) { this.body = b; return this; },
    };
    handler({ query: { name } }, res, known, avatarInitial, avatarColor, AVATAR_COLORS);
    return res;
  };

  const res = call('min wlyt');
  assert.ok(res.body, 'SVGが返る');
  assert.match(res.headers['Content-Type'], /image\/svg\+xml/);
  assert.match(res.body, /<svg/);
  assert.match(res.body, />M</, '頭文字が入る');
  assert.match(res.headers['Cache-Control'], /max-age/, '何度も取りに来ないようキャッシュさせる');

  // 悪意のある入力はエスケープされる（SVGはスクリプトを実行できる）
  const evil = call('<script>alert(1)</script>');
  assert.doesNotMatch(evil.body, /<script>/i, '生のタグを出さない');
  assert.match(evil.body, /&lt;/, 'XMLとして逃がす（頭文字だけを使うので "&lt;" だけ残る）');

  // 名前が空でも落ちない
  const empty = call('');
  assert.match(empty.body, /<svg/);

  // 実アイコンを知っていればそちらへ飛ばす（わざわざSVGを返さない）
  const known = { ch: 'https://yt3.ggpht.com/known=s88' };
  const res3 = call('ch', (n) => (known[String(n).toLowerCase()] || ''));
  assert.deepStrictEqual(res3.redirected, { code: 302, url: 'https://yt3.ggpht.com/known=s88' });

  // javascript: などはリダイレクトしない（SVGを返す）
  const res4 = call('x', () => 'javascript:alert(1)');
  assert.strictEqual(res4.redirected, null, 'http(s) 以外へは飛ばさない');
  assert.match(res4.body, /<svg/);
});

test('同じチャンネルなら、取れなかったカードにも覚えたアイコンを埋める', () => {
  const { rememberAvatars, fillAvatars } = extract();
  rememberAvatars([{ channelTitle: 'Ch A', channelThumbnail: 'https://yt3.ggpht.com/a=s88' }]);
  const items = [
    { channelTitle: 'Ch A', channelThumbnail: '' },
    { channelTitle: 'Ch A' },
    { channelTitle: 'Ch Z' },
    null,
  ];
  fillAvatars(items);
  assert.strictEqual(items[0].channelThumbnail, 'https://yt3.ggpht.com/a=s88');
  assert.strictEqual(items[1].channelThumbnail, 'https://yt3.ggpht.com/a=s88');
  assert.strictEqual(items[2].channelThumbnail, undefined, '知らないチャンネルは触らない');
  assert.strictEqual(items[3], null);
});
