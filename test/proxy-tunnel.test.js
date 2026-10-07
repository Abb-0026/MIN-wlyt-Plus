'use strict';

/**
 * プロキシ経路のテスト
 *
 * 本物の YouTube には到達できないので、手元に
 *   偽YouTube(https) + CONNECTプロキシ + SOCKS5プロキシ + ブロックするプロキシ
 * を立てて「IP ブロック環境」を再現し、プロキシ経由で youtubei を叩けることと、
 * ブロック時に外向き通信を止められることを検証する。
 */
const test = require('node:test');
const assert = require('node:assert');
const nodeFetch = require('node-fetch');
const {
  parseProxyUrl,
  parseProxyList,
  maskProxy,
  connectThroughProxy,
  ProxyPool,
  createProxiedFetch,
  proxiesFromEnv,
} = require('../lib/proxy-tunnel');
const { YtMetadata } = require('../lib/yt-innertube');
const { startMockStack } = require('../test-utils/mock-proxy');

const REJECT_UNAUTHORIZED = false; // 手元の自己署名証明書用

/** テストごとにスタックを立てる */
async function withStack(fn, options) {
  const stack = await startMockStack(options);
  try {
    return await fn(stack);
  } finally {
    await stack.close();
  }
}

const metaFetch = (proxies) =>
  createProxiedFetch({ proxies, fetchImpl: nodeFetch, rejectUnauthorized: REJECT_UNAUTHORIZED, tunnelTimeout: 4000 });

test('プロキシURLのパースと認証情報の隠蔽', () => {
  const withAuth = parseProxyUrl('http://user:secret@1.2.3.4:8080');
  assert.strictEqual(withAuth.type, 'http');
  assert.strictEqual(withAuth.host, '1.2.3.4');
  assert.strictEqual(withAuth.port, 8080);
  assert.strictEqual(withAuth.username, 'user');
  assert.strictEqual(withAuth.password, 'secret');
  assert.strictEqual(maskProxy(withAuth), 'http://1.2.3.4:8080', '認証情報は表示に出さない');
  assert.ok(!String(maskProxy(withAuth)).includes('secret'));

  assert.strictEqual(parseProxyUrl('socks5://h:1080').type, 'socks5');
  assert.strictEqual(parseProxyUrl('1.2.3.4:3128').port, 3128, 'スキーム省略も受け付ける');
  assert.strictEqual(parseProxyUrl('socks5://h').port, 1080, 'socks5 の既定ポート');
  assert.strictEqual(parseProxyUrl(''), null);
  assert.strictEqual(parseProxyUrl('ftp://h:21'), null, '未対応スキームは null');
  assert.strictEqual(parseProxyList('http://a:1, socks5://b:2').length, 2, 'カンマ区切り');
});

test('パース済みのプロキシ配列を渡しても消えない（二重パース事故の回帰）', () => {
  const list = parseProxyList('http://a:1,socks5://b:2');
  assert.strictEqual(list.length, 2);
  // proxiesFromEnv() → createProxiedFetch() の経路で実際に起きた事故
  assert.deepStrictEqual(parseProxyList(list).map((p) => p.label), ['http://a:1', 'socks5://b:2']);
  assert.strictEqual(parseProxyList(['http://a:1', null, 'socks5://b:2']).length, 2);
  assert.deepStrictEqual(parseProxyList([]).length, 0);
});

test('環境変数からプロキシ一覧を読む（YT_META_PROXY 優先）', () => {
  assert.deepStrictEqual(proxiesFromEnv({ YT_META_PROXY: 'http://a:1', HTTPS_PROXY: 'http://b:2' }).map(maskProxy), ['http://a:1']);
  assert.deepStrictEqual(proxiesFromEnv({ HTTPS_PROXY: 'http://b:2' }).map(maskProxy), ['http://b:2']);
  assert.deepStrictEqual(proxiesFromEnv({}).length, 0, '未設定なら直接接続');
});

test('CONNECT プロキシ経由で https が喋れる（プロキシは CONNECT を記録する）', async () => {
  await withStack(async (stack) => {
    const fetchImpl = metaFetch(stack.goodProxyUrl);
    const res = await fetchImpl(`${stack.originUrl}/youtubei/v1/search?key=K`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'x' }),
    });
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.ok(json.contents, 'youtubei の応答が取れる');
    assert.deepStrictEqual(stack.goodProxy.connects, [`127.0.0.1:${stack.originPort}`], 'CONNECT でトンネルを掘っている');
    assert.strictEqual(fetchImpl.status().proxies[0].ok, 1, '成功回数が記録される');
  });
});

test('SOCKS5 プロキシ経由でも通る（認証あり・なし両方）', async () => {
  await withStack(async (stack) => {
    const res = await metaFetch(stack.socksUrl)(`${stack.originUrl}/youtubei/v1/next?key=K`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(stack.socks.connects, [`127.0.0.1:${stack.originPort}`]);
  });

  await withStack(async (stack) => {
    const res = await metaFetch(stack.socksUrl)(`${stack.originUrl}/youtubei/v1/next?key=K`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.strictEqual(res.status, 200, 'ユーザー名/パスワード認証つき SOCKS5 も通る');
  }, { socksAuth: { username: 'u', password: 'p' } });
});

test('ブロックされたプロキシは即エラーになり、プールが冷却する', async () => {
  await withStack(async (stack) => {
    const fetchImpl = metaFetch(stack.blockedProxyUrl);
    let attempts = 0;
    for (let i = 0; i < 2; i++) {
      try {
        await fetchImpl(`${stack.originUrl}/youtubei/v1/search`, { method: 'POST', body: '{}' });
        assert.fail('ブロックされているので成功しない');
      } catch (err) {
        attempts++;
        assert.match(err.message, /proxy refused CONNECT: HTTP 403/, err.message);
      }
    }
    assert.strictEqual(attempts, 2);
    const status = fetchImpl.status();
    assert.strictEqual(status.proxies[0].failures, 2);
    assert.ok(status.proxies[0].coolingFor > 0, '規定回数失敗したら冷却に入る');
    assert.ok(!JSON.stringify(status).includes('secret'), 'status に認証情報を含めない');
  });
});

test('死んだプロキシは避けて生きている方へ回る', async () => {
  await withStack(async (stack) => {
    const fetchImpl = metaFetch(`${stack.blockedProxyUrl},${stack.goodProxyUrl}`);
    const pool = fetchImpl.pool;
    assert.strictEqual(pool.size, 2);

    const blockedLabel = maskProxy(parseProxyUrl(stack.blockedProxyUrl));
    const goodLabel = maskProxy(parseProxyUrl(stack.goodProxyUrl));

    // 交互に振られるので、ブロック側が規定回数（2回）失敗するまで回す
    for (let i = 0; i < 6; i++) {
      await fetchImpl(`${stack.originUrl}/youtubei/v1/search`, { method: 'POST', body: '{}' }).catch(() => {});
    }
    const status = pool.status();
    const blockedEntry = status.proxies.find((p) => p.proxy === blockedLabel);
    const goodEntry = status.proxies.find((p) => p.proxy === goodLabel);
    assert.ok(blockedEntry.failures >= 2, `ブロック側が失敗している: ${JSON.stringify(status)}`);
    assert.ok(blockedEntry.coolingFor > 0, 'ブロック側が冷却に入る');
    assert.ok(goodEntry.ok >= 2, '生きている側は成功している');

    // 以降は健全な方だけが選ばれる
    const used = new Set();
    for (let i = 0; i < 4; i++) {
      const entry = pool.pick({});
      used.add(entry.proxy.label);
    }
    assert.deepStrictEqual([...used], [maskProxy(parseProxyUrl(stack.goodProxyUrl))], '冷却中のプロキシは選ばれない');
  });
});

test('YtMetadata はプロキシ経由でメタデータを取れる', async () => {
  await withStack(async (stack) => {
    const yt = new YtMetadata({
      fetchImpl: metaFetch(stack.goodProxyUrl),
      host: stack.originUrl,
      timeout: 4000,
    });
    const res = await yt.search('テスト');
    assert.strictEqual(res.items.length, 1);
    assert.strictEqual(res.items[0].id, 'aaaaaaaaaaa');
    assert.strictEqual(res.items[0].title, 'プロキシ経由の動画');

    const trending = await yt.trending();
    assert.strictEqual(trending.items[0].title, 'トレンド経由の動画');

    // リクエストはプロキシを通っている
    assert.ok(stack.goodProxy.connects.length >= 2, JSON.stringify(stack.goodProxy.connects));
  });
});

test('ブロックされた環境では外向き通信を止める（サーキットブレーカー）', async () => {
  await withStack(async (stack) => {
    let outbound = 0;
    const countingFetch = (url, init) => {
      outbound++;
      return nodeFetch(url, init);
    };
    const blockedFetch = createProxiedFetch({
      proxies: stack.blockedProxyUrl,
      fetchImpl: countingFetch,
      rejectUnauthorized: REJECT_UNAUTHORIZED,
      tunnelTimeout: 2000,
    });

    const yt = new YtMetadata({
      fetchImpl: blockedFetch,
      host: stack.originUrl,
      timeout: 2000,
      hedgeMs: 0,
      circuitThreshold: 2,
      circuitCooldown: 60000,
      negativeTtl: 30000,
    });

    // 規定回数までは実際に叩く
    await assert.rejects(() => yt.search('a'));
    await assert.rejects(() => yt.search('b'));
    const usedBefore = outbound;
    assert.ok(usedBefore > 0);
    assert.ok(yt.state().circuitOpen, '規定回数後は回路が開く');

    // ここからは外向き通信ゼロ
    for (const q of ['c', 'd', 'e']) {
      await assert.rejects(() => yt.search(q), /circuit-open|negative-cached/);
    }
    assert.strictEqual(outbound, usedBefore, '回路が開いている間は外向き通信を増やさない');
    assert.ok(yt.stats.shortCircuited >= 3);
    assert.strictEqual(yt.state().hedging, false, '失敗中は予備クライアントを並走させない');

    // 冷却が明けたら再開する
    const realNow = yt.now;
    yt.now = () => realNow() + 120000;
    assert.strictEqual(yt.state().circuitOpen, false, '冷却時間経過で閉じる');
    await assert.rejects(() => yt.search('f'), /failed/); // 今度は本当に叩きにいく
    assert.ok(outbound > usedBefore, '冷却後に再開する');
  });
});

test('同一リクエストの連続失敗はネガティブキャッシュで即座に諦める', async () => {
  await withStack(async (stack) => {
    let outbound = 0;
    const countingFetch = (url, init) => {
      outbound++;
      return nodeFetch(url, init);
    };
    const blockedFetch = createProxiedFetch({
      proxies: stack.blockedProxyUrl,
      fetchImpl: countingFetch,
      rejectUnauthorized: REJECT_UNAUTHORIZED,
      tunnelTimeout: 2000,
    });
    const yt = new YtMetadata({
      fetchImpl: blockedFetch,
      host: stack.originUrl,
      timeout: 2000,
      hedgeMs: 0,
      circuitThreshold: 99, // 回路は開かせず、ネガティブキャッシュだけを見る
      negativeTtl: 30000,
    });

    await assert.rejects(() => yt.search('same query'));
    const after1 = outbound;
    await assert.rejects(() => yt.search('same query'), /negative-cached/);
    assert.strictEqual(outbound, after1, '同じクエリは往復せずに即失敗する');

    // 別のクエリは普通に叩く
    await assert.rejects(() => yt.search('other query'), /failed/);
    assert.ok(outbound > after1);
  });
});

test('成功が1回あれば回路は閉じて予備クライアント並走も戻る', async () => {
  await withStack(async (stack) => {
    const yt = new YtMetadata({
      fetchImpl: metaFetch(stack.goodProxyUrl),
      host: stack.originUrl,
      timeout: 4000,
      hedgeMs: 0,
      circuitThreshold: 2,
    });
    await assert.rejects(() => yt.search('nope')).catch(() => {});
    await yt.search('テスト');
    const state = yt.state();
    assert.strictEqual(state.consecutiveFailures, 0);
    assert.strictEqual(state.circuitOpen, false);
    assert.strictEqual(state.hedging, true);
  });
});
