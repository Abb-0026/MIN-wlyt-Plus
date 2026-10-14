const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const index = read('index.js');
const serviceWorker = read('sw.js');
const manifest = JSON.parse(read('manifest.json'));
const packageJson = JSON.parse(read('package.json'));
const packageLock = JSON.parse(read('package-lock.json'));
const railway = JSON.parse(read('railway.json'));
const render = read('render.yaml');

test('Node runtime is pinned consistently to supported Node 24', () => {
  assert.equal(packageJson.engines.node, '>=24 <25');
  assert.equal(packageLock.packages[''].engines.node, packageJson.engines.node);
  assert.equal(read('.nvmrc').trim(), '24');
  assert.equal(railway.build.env.NODE_VERSION, '24');
  assert.match(render, /key: NODE_VERSION\s+value: "24"/);
});

test('hosting health checks use an upstream-independent endpoint', () => {
  assert.match(index, /app\.get\("\/healthz"/);
  assert.match(render, /healthCheckPath:\s*\/healthz/);
  assert.equal(railway.deploy.healthcheckPath, '/healthz');
});

test('PWA starts at the routed application hub', () => {
  assert.equal(manifest.start_url, '/youtube-pro');
  assert.match(index, /app\.get\("\/youtube-pro"[\s\S]*?public["],\s*"min-tube-pro\.html"/);
  assert.ok(fs.existsSync(path.join(root, 'public', 'min-tube-pro.html')));
});

test('home feed starts at DOMContentLoaded instead of waiting for every asset', () => {
  const home = read('public/home.html');
  assert.match(home, /document\.addEventListener\('DOMContentLoaded', initializeHomeFeed/);
  assert.match(home, /document\.addEventListener\('DOMContentLoaded', runHomePromotionOnce/);
  assert.doesNotMatch(home, /window\.onload/);
});

test('manifest, service worker, and icons map to files that exist', () => {
  const routes = [
    { route: '/manifest.json', file: 'manifest.json', pattern: /app\.get\("\/manifest\.json"[\s\S]*?path\.join\(__dirname,\s*"manifest\.json"\)/ },
    { route: '/sw.js', file: 'sw.js', pattern: /app\.get\("\/sw\.js"[\s\S]*?path\.join\(__dirname,\s*"sw\.js"\)/ },
    { route: '/min-img.png', file: 'img/min-tube-pro.png', pattern: /app\.get\("\/min-img\.png"[\s\S]*?path\.join\(__dirname,\s*"img",\s*"min-tube-pro\.png"\)/ },
    { route: '/classroom.192', file: 'img/classroom.192.png', pattern: /app\.get\("\/classroom\.192"[\s\S]*?path\.join\(__dirname,\s*"img",\s*"classroom\.192\.png"\)/ },
    { route: '/classroom.512', file: 'img/classroom.512.png', pattern: /app\.get\("\/classroom\.512"[\s\S]*?path\.join\(__dirname,\s*"img",\s*"classroom\.512\.png"\)/ },
  ];

  for (const item of routes) {
    assert.ok(fs.existsSync(path.join(root, item.file)), `${item.file} should exist`);
    assert.match(index, item.pattern, `${item.route} should serve ${item.file}`);
  }

  for (const icon of manifest.icons) {
    assert.ok(routes.some(item => item.route === icon.src), `${icon.src} should have an Express route`);
  }
});

test('metadata fast path never touches the player endpoint (streams stay API-dependent)', () => {
  const yt = read('lib/yt-innertube.js');
  assert.doesNotMatch(yt, /['"`]player['"`]/, 'player エンドポイントは使わない');
  assert.doesNotMatch(yt, /streamingData|formats\[|adaptiveFormats/, 'ストリーム解析を含めない');
});

test('metadata fast path is additive: yts fallback still reachable in every handler', () => {
  for (const handler of ['/api/trending', '/api/recommendations']) {
    const block = index.slice(index.indexOf(`app.get("${handler}"`));
    const body = block.slice(0, block.indexOf('\napp.get('));
    assert.match(body, /fastMeta\(/, `${handler} に高速経路がある`);
    // 従来経路は legacySearch() に集約した（ブロック環境で無駄に外へ出さないため）
    assert.match(body, /legacySearch\(/, `${handler} の従来経路が残っている`);
  }
  const searchWiring = index.slice(index.indexOf('const searchResolver ='), index.indexOf('// 動的レスポンス'));
  assert.match(searchWiring, /fastMeta\(/, '/api/search の高速経路が残っている');
  assert.match(searchWiring, /legacySearch\(/, '/api/search の従来経路も残っている');
  // その legacySearch が本当に youtube-search-api を呼ぶこと
  const helper = index.slice(index.indexOf('async function legacySearch'), index.indexOf('/** id が被らないように足す */'));
  assert.match(helper, /yts\.GetListByKeyword/, '従来経路は youtube-search-api のまま');
  assert.match(helper, /normalizeYtsItems/, '従来経路の結果も整形する');
  // コメント継続は従来の API ループも残す
  const comments = index.slice(index.indexOf('app.get("/api/comments/:videoId"'));
  assert.match(comments, /ytMeta\.commentsNext\(/);
  assert.match(comments, /apiListCache/);
});

test('home.html escapes external metadata before injecting it into innerHTML', () => {
  const home = read('public/home.html');
  assert.match(home, /function esc\(s\)/);
  assert.match(home, /function safeUrl\(url\)/);
  // 生の item.title / channelTitle を innerHTML へ直接埋めない
  assert.doesNotMatch(home, /\$\{item\.title[^}]*\}[^}]*<h3>/);
  for (const raw of ['${item.title}', '${item.channelTitle}', '${item.viewCountText}', '${item.lengthText}']) {
    assert.equal(home.split(raw).length - 1, 0, `${raw} は必ず esc() を通す`);
  }
  // アバター URL は常に safeUrl() を通る（カード描画は createVideoCard() に1本化した）
  const avatars = home.match(/const avatarUrl = .*/g) || [];
  assert.equal(avatars.length, 1, 'カード描画は1か所だけ');
  for (const line of avatars) assert.match(line, /safeUrl\(/);
});

test('metadata diagnostics stay closed unless debug mode is on', () => {
  const block = index.slice(index.indexOf('app.get("/api/meta-stats"'));
  const body = block.slice(0, block.indexOf('\napp.get('));
  assert.match(body, /YT_META_DEBUG\s*!==\s*"1"\s*\)\s*return\s+res\.status\(404\)/);
  assert.doesNotMatch(body, /visitorId:/, 'visitorId そのものは返さない（真偽値のみ）');
  assert.match(body, /hasVisitorId:\s*!!ytMeta\.visitorId/);
});

test('verification script and docs ship with the fast path', () => {
  const script = read('scripts/verify-meta.js');
  assert.match(script, /\/api\/meta-stats/);
  assert.match(script, /\/api\/recommendations/);
  assert.match(script, /process\.exit\(failures \? 1 : 0\)/);
  const docs = read('docs/metadata-verification.md');
  assert.match(docs, /YT_META=0/);
  assert.match(docs, /scripts\/verify-meta\.js/);
});

test('proxy handling stays opt-out and keeps the manual override', () => {
  const block = index.slice(index.indexOf('const YT_META_ENABLED'));
  const body = block.slice(0, block.indexOf('// --- ストリーム解決'));
  assert.match(body, /YT_META_PROXY/);
  assert.match(body, /YT_META_PROXY_AUTO/, '自動取得の停止スイッチがある');
  assert.match(body, /ProxyHarvester/, '自動取得が配線されている');
  assert.match(body, /manualProxies\.length \? manualProxies/, '手動指定が最優先');
  // 自動取得は既定の公開リストを持ち、起動をブロックしない
  const sources = read('lib/proxy-sources.js');
  assert.match(sources, /DEFAULT_SOURCES\s*=/);
  assert.match(sources, /start\(\)[\s\S]{0,400}this\.refresh\(\)\.catch/);
  const tunnel = read('lib/proxy-tunnel.js');
  // 依存を増やさない（コメントで言及しているだけなので require の形で見る）
  assert.doesNotMatch(tunnel, /require\(['"]undici['"]\)/);
  assert.doesNotMatch(tunnel, /require\(['"]https-proxy-agent['"]\)/);
  assert.doesNotMatch(tunnel, /require\(['"]socks-proxy-agent['"]\)/);
});

test('既存4方式を維持し、履歴で見つかった直列ホップと不要な待ちを削る', () => {
  const resolver = read('lib/stream-resolver.js');
  const routeBlock = (start, end) => {
    const from = index.indexOf(start);
    assert.notEqual(from, -1, `${start} route exists`);
    const to = index.indexOf(end, from);
    return index.slice(from, to === -1 ? undefined : to);
  };

  const sia = routeBlock("app.get('/sia-dl/:videoId'", "app.get('/ai-fetch/:videoId'");
  const ai = routeBlock("app.get('/ai-fetch/:videoId'", 'app.get("/youtube-pro"');
  const rapid = routeBlock("app.get('/rapid/:id'", "app.get('/streams'");

  assert.match(resolver, /name: `min-tube:/, 'Min-Tube API 経路を維持');
  assert.match(sia, /Promise\.all/, 'Sia メタデータとストリームを並列取得');
  assert.match(sia, /streamResolver\.getLateUrl\(videoId\)/, '既存 getlate キャッシュを再利用');
  assert.doesNotMatch(sia, /\/360\//, 'Sia の自サーバーへの往復を除去');
  assert.match(rapid, /fetchWithAbort\(/, 'RapidAPI 上流を時間切れ時に中断');
  assert.match(index, /function abortOnResponseClose\(/, '勝者決定後の切断を個別の上流にも伝える');
  assert.match(sia, /abortOnResponseClose\(res\)/);
  assert.match(rapid, /abortOnResponseClose\(res\)/);
  assert.match(ai, /abortOnResponseClose\(res\)/);
  assert.match(ai, /Promise\.all/, 'AI メタデータ・タイトル・ストリームを並列取得');
  assert.match(ai, /streamResolver\.getLateUrl\(videoId\)/, 'AI 経路も同じ getlate 解決を再利用');
  assert.doesNotMatch(ai, /\/360\//, 'AI 経路も自サーバーへの往復を除去');
  assert.match(ai, /GetListByKeyword\(videoId, false, 20, 0\)/, 'YTS の既存補助情報は残し、10ページ逐次検索を避ける');
  assert.match(resolver, /fastFallback: true/, '起動済み Rapid の成功は遅い主系を待たず採用');
  assert.match(resolver, /controller\.abort\(\)/, 'レース敗者の上流リクエストを中断');
  assert.match(resolver, /this\.inflight = new Map\(\)/, '同一動画の同時要求を集約');
});

test('service worker only precaches valid app-shell paths', () => {
  const match = serviceWorker.match(/const PRECACHE = (\[[\s\S]*?\]);/);
  assert.ok(match, 'PRECACHE list should be present');

  const precache = [...match[1].matchAll(/[\"']([^\"']+)[\"']/g)].map(item => item[1]);
  assert.deepEqual(precache, [
    '/youtube-pro',
    '/manifest.json',
    '/min-img.png',
    '/classroom.192',
    '/classroom.512',
  ]);
  assert.doesNotMatch(serviceWorker, /\/public\/min-tube-pro\.html|\/img\/min-tube-pro\.png/);
});
