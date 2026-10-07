#!/usr/bin/env node
'use strict';

/**
 * 手元で「IPブロックされる環境」を再現するモック（開発・検証用）
 *
 *   偽YouTube(https) / CONNECTプロキシ / ブロックするプロキシ / SOCKS5プロキシ
 * をまとめて起動する。本物の YouTube に出られない開発環境で、
 * 「プロキシ経由でメタデータが取れるか」「ブロック時に無駄な通信を止められるか」を
 * 実際にアプリを動かして確認できる。
 *
 * 使い方:
 *   node scripts/mock-youtube.js
 *   # 出力された URL をアプリ側へ:
 *   YT_META_HOST=https://127.0.0.1:<origin> \
 *   YT_META_PROXY=http://127.0.0.1:<good> \
 *   YT_META_TLS_REJECT=0 YT_META_DEBUG=1 node index.js
 */
const { startMockStack } = require('../test-utils/mock-proxy');

(async () => {
  const socksAuth = process.env.MOCK_SOCKS_AUTH
    ? { username: 'user', password: 'pass' }
    : null;

  const stack = await startMockStack({ socksAuth });

  // 「外向き通信が本当に止まっているか」を目で見えるようにする
  let total = 0;
  for (const [label, server] of [
    ['proxy(通す)', stack.goodProxy],
    ['proxy(403)', stack.blockedProxy],
    ['socks5', stack.socks],
  ]) {
    const name = label;
    if (server.connects) {
      const seen = server.connects;
      let printed = 0;
      const timer = setInterval(() => {
        while (printed < seen.length) {
          total += 1;
          console.log(`[${name}] CONNECT ${seen[printed]}  (累計 ${total} 回)`);
          printed += 1;
        }
      }, 50);
      timer.unref();
    }
  }

  // 「無料プロキシのリスト配信元」も用意する（自動取得の検証用）
  const http = require('http');
  const listServer = http.createServer((req, res) => {
    if (req.url === '/empty.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('\n');
      return;
    }
    // 実物のリストは「死んだプロキシが大半」なので、到達不能なダミーも混ぜる
    const entries = [
      '# 自動取得の検証用リスト',
      '203.0.113.1:8080',                                   // TEST-NET-3（到達不能）
      stack.goodProxyUrl.replace('http://', ''),            // 通るプロキシ
      '198.51.100.2:3128',                                  // TEST-NET-2（到達不能）
      stack.blockedProxyUrl.replace('http://', ''),         // 403を返すプロキシ
    ].join('\n');
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(entries);
  });
  await new Promise((resolve) => listServer.listen(0, '127.0.0.1', resolve));
  const listPort = listServer.address().port;

  const lines = [
    ['偽YouTube (https)', stack.originUrl],
    ['CONNECT プロキシ（通す）', stack.goodProxyUrl],
    ['CONNECT プロキシ（403で拒否＝ブロック済みIPの想定）', stack.blockedProxyUrl],
    ['SOCKS5 プロキシ', socksAuth ? stack.socksUrl : stack.socksUrl + '  (認証なし)'],
    ['プロキシリスト配信（自動取得用）', `http://127.0.0.1:${listPort}/proxies.txt`],
    ['↑ 空リスト（取得元が死んだ想定）', `http://127.0.0.1:${listPort}/empty.txt`],
  ];
  console.log('\nモック環境を起動しました\n' + '─'.repeat(64));
  for (const [label, url] of lines) console.log(`  ${label}\n    ${url}`);
  console.log('─'.repeat(64));
  console.log(`
動作確認（別のターミナルで）:

  # 1) プロキシ経由でメタデータが取れることを確認
  YT_META_HOST=${stack.originUrl} \\
  YT_META_PROXY=${stack.goodProxyUrl} \\
  YT_META_TLS_REJECT=0 YT_META_DEBUG=1 \\
  PORT=3000 node index.js

  node scripts/verify-meta.js http://127.0.0.1:3000
  # → items が 1 以上になればプロキシ経路は正常

  # 2) ブロックされたプロキシに差し替えて、無駄な通信を止めることを確認
  YT_META_PROXY=${stack.blockedProxyUrl}   # ↑ ここだけ変える
  # → /api/meta-stats の meta.circuitOpen が true になり、
  #   stats.shortCircuited が増えても「外向き通信」は増えない

  # 3) プロキシを手で設定せず、リストから自動取得する（本番の既定動作）
  YT_META_PROXY_SOURCES=http://127.0.0.1:${listPort}/proxies.txt \
  YT_META_PROXY_ALLOW_PRIVATE=1 YT_META_DEBUG=1 \
  PORT=3000 node index.js
  # （YT_META_HOST / YT_META_TLS_REJECT は 1) と同じ）
  # → /api/meta-stats の proxySources.lastAdded が 4 になり、
  #   死んだ2本＋403の1本を避けて、通るプロキシに当たるまで自動で回る

Ctrl+C で終了します。
`);

  const shutdown = async () => {
    listServer.closeAllConnections();
    listServer.close();
    await stack.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
})();
