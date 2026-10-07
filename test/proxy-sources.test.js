'use strict';

/**
 * 無料プロキシリストの自動取得のテスト
 *
 * 本物のリスト配信元には到達できないので、手元に
 *   「リスト配信サーバ」＋「プロキシ」＋「偽YouTube」
 * を立てて、取得→反映→実際にメタデータが取れるところまでを検証する。
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const nodeFetch = require('node-fetch');
const { ProxyHarvester, parseProxyListText, DEFAULT_SOURCES, isPrivateHost } = require('../lib/proxy-sources');
const { ProxyPool, createProxiedFetch } = require('../lib/proxy-tunnel');
const { YtMetadata } = require('../lib/yt-innertube');
const { startMockStack } = require('../test-utils/mock-proxy');

const ALLOW_PRIVATE = true; // 手元の 127.0.0.1 を使うので

/** リスト配信サーバを立てる。routes: { '/http.txt': '...' } */
async function startListServer(routes) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    const key = String(req.url).split('?')[0];
    if (Object.prototype.hasOwnProperty.call(routes, key)) {
      const body = routes[key];
      const status = typeof body === 'number' ? body : 200;
      res.writeHead(status, { 'Content-Type': 'text/plain' });
      res.end(typeof body === 'number' ? 'error' : body);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    hits,
    url: (path) => `http://127.0.0.1:${port}${path}`,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('リストの書式はバラバラでも読める', () => {
  const cases = [
    ['1.2.3.4:8080\n5.6.7.8:3128', ['http://1.2.3.4:8080', 'http://5.6.7.8:3128']],
    ['http://1.2.3.4:8080\r\nsocks5://5.6.7.8:1080', ['http://1.2.3.4:8080', 'socks5://5.6.7.8:1080']],
    ['1.2.3.4:8080:user:pass', ['http://1.2.3.4:8080']], // 認証つき（ラベルには出ない）
    ['1.2.3.4:8080 US-N+S- https', ['http://1.2.3.4:8080']], // spys.me 形式
    ['# comment\n\n1.2.3.4:8080', ['http://1.2.3.4:8080']],
    ['[{"ip":"1.2.3.4","port":8080,"protocol":"http"}]', ['http://1.2.3.4:8080']],
    ['{"data":[{"host":"1.2.3.4","port":1080,"protocol":"socks5"}]}', ['socks5://1.2.3.4:1080']],
  ];
  for (const [text, expected] of cases) {
    const list = parseProxyListText(text);
    assert.deepStrictEqual(list.map((p) => p.label), expected, text);
  }

  // 重複は1つにまとめる
  assert.strictEqual(parseProxyListText('1.2.3.4:8080\n1.2.3.4:8080').length, 1);
  // ゴミは捨てる
  assert.deepStrictEqual(parseProxyListText('hello\nnope:notanumber\n1.2.3.4:8080').map((p) => p.label), ['http://1.2.3.4:8080']);
  assert.deepStrictEqual(parseProxyListText('').length, 0);
  assert.deepStrictEqual(parseProxyListText(null).length, 0);

  // 認証情報は取りこぼさない（ラベルには出さない）
  const withAuth = parseProxyListText('1.2.3.4:8080:alice:secret')[0];
  assert.strictEqual(withAuth.username, 'alice');
  assert.strictEqual(withAuth.password, 'secret');
  assert.strictEqual(withAuth.label, 'http://1.2.3.4:8080');
});

test('プライベート/ループバックは既定で弾く（テストでは許可する）', () => {
  assert.ok(isPrivateHost('127.0.0.1'));
  assert.ok(isPrivateHost('10.0.0.1'));
  assert.ok(isPrivateHost('192.168.1.1'));
  assert.ok(!isPrivateHost('8.8.8.8'));
  assert.deepStrictEqual(parseProxyListText('127.0.0.1:8080').length, 0);
  assert.deepStrictEqual(parseProxyListText('127.0.0.1:8080', { allowPrivate: true }).length, 1);
});

test('既定の取得元が複数ある（1つ死んでも成立するように）', () => {
  assert.ok(DEFAULT_SOURCES.length >= 5, JSON.stringify(DEFAULT_SOURCES.length));
  assert.ok(DEFAULT_SOURCES.some((u) => /socks5/i.test(u)), 'socks5 の取得元も含む');
  for (const url of DEFAULT_SOURCES) assert.match(url, /^https?:\/\//);
});

test('取得元から取ったプロキシがプールに入る', async () => {
  const server = await startListServer({
    '/http.txt': '1.2.3.4:8080\n5.6.7.8:3128\n',
    '/socks5.txt': 'socks5://9.9.9.9:1080\n',
  });
  const pool = new ProxyPool([]);
  const harvester = new ProxyHarvester({
    pool,
    fetchImpl: nodeFetch,
    sources: [server.url('/http.txt'), server.url('/socks5.txt')],
    refreshMs: 0,
  });

  const result = await harvester.refresh();
  assert.strictEqual(result.added, 3);
  assert.strictEqual(pool.size, 3);
  assert.strictEqual(pool.direct, false, 'プロキシが入ったら直接接続をやめる');
  assert.deepStrictEqual(
    pool.status().proxies.map((p) => p.proxy),
    ['http://1.2.3.4:8080', 'socks5://9.9.9.9:1080', 'http://5.6.7.8:3128'],
    '取得元ごとに交互に混ぜる'
  );
  const st = harvester.status();
  assert.strictEqual(st.sources.length, 2);
  assert.ok(st.sources.every((s) => s.ok));
  await server.close();
});

test('一部の取得元が死んでいても、取れた分だけで成立する', async () => {
  const server = await startListServer({
    '/ok.txt': '1.2.3.4:8080\n',
    '/dead.txt': 500,
    '/gone.txt': 404,
  });
  const pool = new ProxyPool([]);
  const harvester = new ProxyHarvester({
    pool,
    fetchImpl: nodeFetch,
    sources: [server.url('/dead.txt'), server.url('/ok.txt'), server.url('/gone.txt')],
    refreshMs: 0,
  });
  const result = await harvester.refresh();
  assert.strictEqual(result.added, 1);
  const st = harvester.status();
  assert.strictEqual(st.sources.filter((s) => s.ok).length, 1);
  assert.strictEqual(st.sources.filter((s) => !s.ok).length, 2);
  await server.close();
});

test('全部コケたら前回のリストを捨てない', async () => {
  const good = await startListServer({ '/ok.txt': '1.2.3.4:8080\n5.6.7.8:3128\n' });
  const pool = new ProxyPool([]);
  const harvester = new ProxyHarvester({
    pool,
    fetchImpl: nodeFetch,
    sources: [good.url('/ok.txt')],
    refreshMs: 0,
  });
  await harvester.refresh();
  assert.strictEqual(pool.size, 2);

  harvester.sources = ['http://127.0.0.1:1/nope.txt']; // 到達不能
  const result = await harvester.refresh();
  assert.strictEqual(result.kept, true, '前回のリストを保持する');
  assert.strictEqual(pool.size, 2, 'リストは消えない');
  await good.close();
});

test('自動取得したプロキシ経由でメタデータが取れる（端到端）', async () => {
  const stack = await startMockStack();
  try {
    // 「無料プロキシのリスト」に、手元のモックプロキシを載せて配信する
    const listServer = await startListServer({
      '/http.txt': [
        '# 実際のリストは死んだプロキシが大半なので、ダミーも混ぜる',
        '203.0.113.1:8080',   // TEST-NET-3（到達不能）
        stack.goodProxyUrl.replace('http://', ''),
        '198.51.100.2:3128',  // TEST-NET-2（到達不能）
      ].join('\n'),
    });

    const pool = new ProxyPool([]);
    const harvester = new ProxyHarvester({
      pool,
      fetchImpl: nodeFetch,
      sources: [listServer.url('/http.txt')],
      refreshMs: 0,
      allowPrivate: ALLOW_PRIVATE,
    });
    await harvester.refresh();
    assert.strictEqual(pool.size, 3, 'リストがプールに入る');

    const fetchImpl = createProxiedFetch({
      pool,
      fetchImpl: nodeFetch,
      rejectUnauthorized: false,
      tunnelTimeout: 800,
    });
    const yt = new YtMetadata({ fetchImpl, host: stack.originUrl, timeout: 1500, hedgeMs: 0 });

    // リストの先頭は到達不能でも、ローテーションで生きているプロキシに当たる
    let res = null;
    for (let i = 0; i < 6 && !(res && res.items.length); i++) {
      res = await yt.search('テスト').catch(() => null);
    }
    assert.ok(res && res.items.length === 1, `自動取得したプロキシ経由でメタデータが取れる (state=${JSON.stringify(yt.state())})`);
    // プロキシ不通は「YouTube に拒否された」とは別枠なので、回路は開かない
    assert.strictEqual(yt.state().circuitOpen, false, 'プロキシ不通でいきなり回路は開かない');
    assert.strictEqual(res.items[0].title, 'プロキシ経由の動画');

    // 到達不能なプロキシは冷却されて、以降は避けられる
    const status = pool.status().proxies;
    const dead = status.filter((p) => !p.proxy.includes(String(stack.originPort)) && p.coolingFor > 0);
    assert.ok(dead.length >= 1, `死んだプロキシが冷却されている: ${JSON.stringify(status)}`);
    await listServer.close();
  } finally {
    await stack.close();
  }
});

test('start()/stop(): 起動をブロックせず、定期更新のタイマーを持つ', async () => {
  const server = await startListServer({ '/ok.txt': '1.2.3.4:8080\n' });
  const pool = new ProxyPool([]);
  const harvester = new ProxyHarvester({
    pool,
    fetchImpl: nodeFetch,
    sources: [server.url('/ok.txt')],
    refreshMs: 600000,
  });
  harvester.start();
  // 待たずに次へ進める（起動をブロックしない）
  assert.strictEqual(harvester.status().running, true);
  await harvester.refresh(); // 走っているジョブが完了するのを待つ
  assert.strictEqual(pool.size, 1);
  harvester.stop();
  await server.close();
});
