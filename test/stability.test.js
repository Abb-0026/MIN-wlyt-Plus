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
  for (const handler of ['/api/search', '/api/trending', '/api/recommendations']) {
    const block = index.slice(index.indexOf(`app.get("${handler}"`));
    const body = block.slice(0, block.indexOf('\napp.get('));
    assert.match(body, /fastMeta\(/, `${handler} に高速経路がある`);
    // 従来経路は legacySearch() に集約した（ブロック環境で無駄に外へ出さないため）
    assert.match(body, /legacySearch\(/, `${handler} の従来経路が残っている`);
  }
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
  // アバター URL は常に safeUrl() を通る
  const avatars = home.match(/const avatarUrl = .*/g) || [];
  assert.equal(avatars.length, 2);
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
