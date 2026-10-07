'use strict';

/**
 * テスト用の「プロキシ + 偽YouTube」スタック
 *
 * サンドボックスから本物の YouTube には到達できないので、手元に
 *   偽YouTube(https) / CONNECTプロキシ / SOCKS5プロキシ / ブロックするプロキシ
 * を立てて、「プロキシ経由で youtubei を叩く」経路を実機相当で検証する。
 */
const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

/** テスト用の自己署名証明書（テスト実行時に生成する） */
function makeSelfSignedCert() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-yt-'));
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath,
    '-days', '1', '-subj', '/CN=localhost',
  ], { stdio: 'ignore' });
  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
}

/** videoRenderer の最小フィクスチャ */
function renderer(id, title, extra = {}) {
  return {
    videoRenderer: Object.assign({
      videoId: id,
      title: { runs: [{ text: title }] },
      ownerText: { runs: [{ text: 'Ch' }] },
      viewCountText: { simpleText: '1,000 回視聴' },
      publishedTimeText: { simpleText: '1 日前' },
      lengthText: { simpleText: '5:00' },
    }, extra),
  };
}

/** 偽 YouTube（youtubei/v1 の最小限の応答） */
function createFakeYouTube({ cert, onRequest } = {}) {
  const requests = [];
  const sockets = [];
  const server = https.createServer(cert || makeSelfSignedCert(), (req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let payload = {};
      try {
        payload = body ? JSON.parse(body) : {};
      } catch (e) { /* noop */ }
      requests.push({ method: req.method, url: req.url, payload, headers: req.headers });
      if (typeof onRequest === 'function') onRequest(requests[requests.length - 1]);

      const endpoint = String(req.url || '').split('/').pop().split('?')[0];
      let out;
      if (endpoint === 'search') {
        out = {
          contents: {
            twoColumnSearchResultsRenderer: {
              primaryContents: {
                sectionListRenderer: {
                  contents: [{
                    itemSectionRenderer: {
                      contents: [renderer('aaaaaaaaaaa', 'プロキシ経由の動画')],
                    },
                  }],
                },
              },
            },
          },
        };
      } else if (endpoint === 'browse') {
        out = {
          contents: {
            twoColumnBrowseResultsRenderer: {
              tabs: [{
                tabRenderer: {
                  selected: true,
                  content: {
                    richGridRenderer: {
                      contents: [{
                        richItemRenderer: {
                          content: renderer('bbbbbbbbbbb', 'トレンド経由の動画'),
                        },
                      }],
                    },
                  },
                },
              }],
            },
          },
        };
      } else if (endpoint === 'next') {
        out = {
          contents: {
            twoColumnWatchNextResults: {
              results: {
                results: {
                  contents: [{
                    videoPrimaryInfoRenderer: { title: { runs: [{ text: 'next 経由' }] } },
                  }],
                },
              },
              secondaryResults: { secondaryResults: { results: [] } },
            },
          },
        };
      } else {
        out = { ok: true, endpoint: endpoint || '' };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  server.requests = requests;
  server.sockets = sockets;
  server.on('secureConnection', (socket) => {
    sockets.push(socket);
    socket.on('close', () => {
      const i = sockets.indexOf(socket);
      if (i >= 0) sockets.splice(i, 1);
    });
  });
  return server;
}

/** CONNECT プロキシ（blocked=true なら 403 を返して接続を拒む） */
function createConnectProxy({ blocked = false, onConnect } = {}) {
  const connects = [];
  const sockets = [];
  const track = (socket) => {
    sockets.push(socket);
    socket.on('close', () => {
      const i = sockets.indexOf(socket);
      if (i >= 0) sockets.splice(i, 1);
    });
  };
  const server = http.createServer((req, res) => {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('this is a proxy');
  });
  server.on('connect', (req, clientSocket, head) => {
    connects.push(req.url);
    track(clientSocket);
    if (typeof onConnect === 'function') onConnect(req.url);
    if (blocked) {
      clientSocket.write('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      clientSocket.destroy();
      return;
    }
    const [host, port] = String(req.url || '').split(':');
    const upstream = net.connect(Number(port) || 443, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    track(upstream);
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  server.connects = connects;
  server.sockets = sockets;
  return server;
}

/** SOCKS5 プロキシ（no-auth / username-password 両対応） */
function createSocksProxy({ username = '', password = '', blocked = false } = {}) {
  const connects = [];
  const sockets = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.on('close', () => {
      const i = sockets.indexOf(socket);
      if (i >= 0) sockets.splice(i, 1);
    });
    let buffer = Buffer.alloc(0);
    let authed = false;
    let tunneling = false;

    const handle = () => {
      // トンネル開通後は生データを流すだけ。ここで解析すると TLS の
      // ClientHello を SOCKS リクエストと誤解して切断してしまう。
      if (tunneling) return;
      if (buffer.length < 2) return;
      // authed は false / 'pending' / true の3状態。
      // `if (!authed)` にすると 'pending'（認証待ち）が弾かれるので注意。
      if (authed !== true) {
        const version = buffer[0];
        if (version === 0x05) {
          const nmethods = buffer[1];
          if (buffer.length < 2 + nmethods) return;
          const methods = [...buffer.subarray(2, 2 + nmethods)];
          buffer = buffer.subarray(2 + nmethods);
          if (username) {
            if (!methods.includes(0x02)) return socket.destroy();
            socket.write(Buffer.from([0x05, 0x02]));
            authed = 'pending';
          } else {
            socket.write(Buffer.from([0x05, 0x00]));
            authed = true;
          }
          return handle();
        }
        if (version === 0x01 && authed === 'pending') {
          const ulen = buffer[1];
          if (buffer.length < 2 + ulen + 1) return;
          const user = buffer.subarray(2, 2 + ulen).toString('utf8');
          const plen = buffer[2 + ulen];
          if (buffer.length < 2 + ulen + 1 + plen) return;
          const pass = buffer.subarray(3 + ulen, 3 + ulen + plen).toString('utf8');
          buffer = buffer.subarray(3 + ulen + plen);
          if (user !== username || pass !== password) {
            socket.write(Buffer.from([0x01, 0x01]));
            return socket.destroy();
          }
          socket.write(Buffer.from([0x01, 0x00]));
          authed = true;
          return handle();
        }
        return socket.destroy();
      }

      // CONNECT リクエスト
      const [ver, cmd, , atyp] = buffer;
      if (ver !== 0x05 || cmd !== 0x01) return socket.destroy();
      let host;
      let offset;
      if (atyp === 0x01) {
        if (buffer.length < 10) return;
        host = [...buffer.subarray(4, 8)].join('.');
        offset = 8;
      } else if (atyp === 0x03) {
        const len = buffer[4];
        if (buffer.length < 5 + len + 2) return;
        host = buffer.subarray(5, 5 + len).toString('utf8');
        offset = 5 + len;
      } else {
        return socket.destroy();
      }
      const port = buffer.readUInt16BE(offset);
      connects.push(`${host}:${port}`);
      buffer = Buffer.alloc(0);

      if (blocked) {
        socket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        return socket.destroy();
      }
      tunneling = true;
      const upstream = net.connect(port, host, () => {
        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      sockets.push(upstream);
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
    };

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      handle();
    });
    socket.on('error', () => {});
  });
  server.connects = connects;
  server.sockets = sockets;
  return server;
}

/** まとめて起動する。close() で全部止める */
async function startMockStack({ socksAuth = null, blockedSocks = false } = {}) {
  const cert = makeSelfSignedCert();
  const servers = {};

  const listen = (server, port = 0) => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });

  const origin = createFakeYouTube({ cert });
  const goodProxy = createConnectProxy();
  const blockedProxy = createConnectProxy({ blocked: true });
  const socks = createSocksProxy({
    username: socksAuth ? socksAuth.username : '',
    password: socksAuth ? socksAuth.password : '',
    blocked: blockedSocks,
  });

  const originPort = await listen(origin);
  const goodPort = await listen(goodProxy);
  const blockedPort = await listen(blockedProxy);
  const socksPort = await listen(socks);

  Object.assign(servers, { origin, goodProxy, blockedProxy, socks });

  return {
    origin,
    originPort,
    originUrl: `https://127.0.0.1:${originPort}`,
    goodProxy,
    goodProxyUrl: `http://127.0.0.1:${goodPort}`,
    blockedProxy,
    blockedProxyUrl: `http://127.0.0.1:${blockedPort}`,
    socks,
    socksUrl: socksAuth
      ? `socks5://${encodeURIComponent(socksAuth.username)}:${encodeURIComponent(socksAuth.password)}@127.0.0.1:${socksPort}`
      : `socks5://127.0.0.1:${socksPort}`,
    requests: origin.requests,
    async close() {
      // まだ生きているコネクションを先に切る。
      // server.close() は「全コネクションが終わるまで」コールバックを呼ばないので、
      // keep-alive のソケットが1本残るだけでハングする。
      for (const s of Object.values(servers)) {
        for (const socket of s.sockets || []) socket.destroy();
      }
      for (const s of Object.values(servers)) {
        if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
        for (const socket of s.sockets || []) socket.destroy();
      }
      await Promise.all(Object.values(servers).map((s) => new Promise((resolve) => s.close(resolve))));
    },
  };
}

module.exports = {
  startMockStack,
  createFakeYouTube,
  createConnectProxy,
  createSocksProxy,
  makeSelfSignedCert,
};
