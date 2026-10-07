'use strict';

/**
 * プロキシ経由で https を喋るための最小実装（依存パッケージなし）
 *
 * なぜ自前:
 *   undici / https-proxy-agent を足すと依存が増える（≈1MB）。必要なのは
 *   「CONNECT でトンネルを掘って、その上で TLS する」だけなので 200 行で足りる。
 *
 *   直接接続 ──→ YouTube（IP ブロックされうる）
 *   プロキシ ──→ CONNECT www.youtube.com:443 ──→ TLS ──→ YouTube
 *
 * 対応スキーム:
 *   http://[user:pass@]host:port   … CONNECT トンネル（いわゆる HTTP プロキシ）
 *   https://[user:pass@]host:port  … 同上（プロキシ自体が TLS の場合は非対応）
 *   socks5://[user:pass@]host:port … SOCKS5（no-auth / username-password）
 *
 * TLS はプロキシを**貫通**します（end-to-end）。プロキシ事業者に平文を見せない。
 */
const http = require('http');
const https = require('https');
const tls = require('tls');
const net = require('net');

const DEFAULT_TIMEOUT = 10000;

/** プロキシ URL を分解する。おかしい値は null */
function parseProxyUrl(input) {
  if (!input || typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw) return null;
  const withScheme = /^\w+:\/\//.test(raw) ? raw : `http://${raw}`;
  let u;
  try {
    u = new URL(withScheme);
  } catch (e) {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'socks5:') return null;
  if (!u.hostname) return null;

  const port = Number(u.port) || (u.protocol === 'socks5:' ? 1080 : u.protocol === 'https:' ? 443 : 80);
  if (!(port > 0 && port < 65536)) return null;

  const entry = {
    type: u.protocol === 'socks5:' ? 'socks5' : 'http',
    host: u.hostname.replace(/^\[|\]$/g, ''),
    port,
    username: u.username ? decodeURIComponent(u.username) : '',
    password: u.password ? decodeURIComponent(u.password) : '',
    raw,
  };
  // 認証情報を含まない表示用の文字列（ログ・/metastats 用）
  entry.label = `${entry.type}://${entry.host}:${entry.port}`;
  return entry;
}

/** パース済みのプロキシオブジェクトかどうか */
const isProxyEntry = (v) => !!v && typeof v === 'object' && !!v.type && !!v.host;

/**
 * プロキシ一覧をパースする。
 * ・ 'http://a:1,socks5://b:2'  … カンマ/空白区切りの文字列
 * ・ ['http://a:1', ...]        … 配列
 * ・ parseProxyUrl() 済みのオブジェクト配列 … そのまま通す（二重パースで消さない）
 */
function parseProxyList(input) {
  if (Array.isArray(input)) {
    return input.map((item) => (isProxyEntry(item) ? item : parseProxyUrl(item))).filter(Boolean);
  }
  return String(input || '')
    .split(/[,\s]+/)
    .map(parseProxyUrl)
    .filter(Boolean);
}

/** 認証情報を落とした表示用ラベル（パスワードをログに出さない） */
const maskProxy = (p) => (p ? p.label : '');

function withTimeout(promise, ms, message) {
  if (!(ms > 0)) return promise;
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message || `timeout after ${ms}ms`)), ms);
    }),
  ]);
}

/* ------------------------------------------------------------ SOCKS5 */

function socks5Handshake(socket, { host, port, username, password }, timeout) {
  return new Promise((resolve, reject) => {
    let stage = 'greeting';
    let buffer = Buffer.alloc(0);

    const fail = (msg) => {
      socket.destroy();
      reject(new Error(`socks5 ${stage}: ${msg}`));
    };

    // n バイト溜まるまで待つ。1つのチャンクに複数段の応答が入っていることがあるので、
    // 受け取り済みの buffer を最初に必ず見る（ここを見落とすとハンドシェイクが止まる）。
    const expect = (n) => new Promise((res) => {
      const take = () => {
        if (buffer.length < n) return false;
        const out = buffer.subarray(0, n);
        buffer = buffer.subarray(n);
        res(out);
        return true;
      };
      if (take()) return;
      const onData = (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (take()) socket.removeListener('data', onData);
      };
      socket.on('data', onData);
    });

    (async () => {
      const methods = username ? [0x00, 0x02] : [0x00];
      socket.write(Buffer.from([0x05, methods.length, ...methods]));

      stage = 'method selection';
      const methodsReply = await expect(2);
      if (methodsReply[0] !== 0x05) return fail('bad version');
      const method = methodsReply[1];
      if (method === 0x02) {
        stage = 'username/password auth';
        const user = Buffer.from(username, 'utf8');
        const pass = Buffer.from(password || '', 'utf8');
        socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
        const authReply = await expect(2);
        if (authReply[1] !== 0x00) return fail('auth rejected');
      } else if (method !== 0x00) {
        return fail('no acceptable auth method');
      }

      stage = 'connect request';
      const hostBuf = Buffer.from(host, 'utf8');
      socket.write(Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
        hostBuf,
        Buffer.from([(port >> 8) & 0xff, port & 0xff]),
      ]));

      stage = 'connect reply';
      const head = await expect(4);
      if (head[1] !== 0x00) return fail(`request rejected (status 0x${head[1].toString(16)})`);
      // 残りのバインドアドレスを読み飛ばす（アドレス種別で長さが変わる）
      const rest = head[3] === 0x01 ? 6 : head[3] === 0x04 ? 18 : (await expect(1))[0] + 2;
      await expect(rest);
      resolve(socket);
    })().catch((err) => fail(err && err.message));

    socket.setTimeout(timeout, () => fail('timeout'));
    socket.once('error', (err) => reject(err));
  });
}

/* --------------------------------------------------------- CONNECT */

/** プロキシを通して targetHost:targetPort までの素のソケットを掘る */
function connectThroughProxy(proxy, targetHost, targetPort, { timeout = DEFAULT_TIMEOUT } = {}) {
  if (proxy.type === 'socks5') {
    return new Promise((resolve, reject) => {
      const socket = net.connect(proxy.port, proxy.host);
      socket.setTimeout(timeout, () => {
        socket.destroy();
        reject(new Error(`socks5 connect timeout (${proxy.label})`));
      });
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.setTimeout(0);
        socks5Handshake(socket, { host: targetHost, port: targetPort, username: proxy.username, password: proxy.password }, timeout)
          .then(resolve, reject);
      });
    });
  }

  return new Promise((resolve, reject) => {
    const headers = { Host: `${targetHost}:${targetPort}` };
    if (proxy.username) {
      const cred = Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64');
      headers['Proxy-Authorization'] = `Basic ${cred}`;
    }

    const req = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers,
      agent: false,
    });
    req.setTimeout(timeout, () => req.destroy(new Error(`proxy connect timeout (${proxy.label})`)));
    req.once('error', reject);
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`proxy refused CONNECT: HTTP ${res.statusCode} (${proxy.label})`));
        return;
      }
      socket.setTimeout(0);
      socket.setNoDelay(true);
      resolve(socket);
    });
    req.end();
  });
}

/**
 * https.Agent を継承したトンネル用エージェント。
 * createConnection で「CONNECT → その上に TLS」をして TLS ソケットを渡す。
 */
class TunnelAgent extends https.Agent {
  constructor(proxy, options = {}) {
    super({ keepAlive: false, maxSockets: Infinity, ...options });
    this.proxy = proxy;
    this.tunnelTimeout = options.tunnelTimeout || DEFAULT_TIMEOUT;
  }

  createConnection(options, oncreate) {
    const done = (err, socket) => {
      if (typeof oncreate === 'function') oncreate(err, socket);
    };
    const host = options.host || options.hostname;
    const port = Number(options.port) || 443;

    connectThroughProxy(this.proxy, host, port, { timeout: this.tunnelTimeout })
      .then((raw) => {
        const secure = tls.connect({
          socket: raw,
          servername: options.servername || host,
          rejectUnauthorized: options.rejectUnauthorized !== false,
          ALPNProtocols: ['http/1.1'],
        });
        secure.once('secureConnect', () => done(null, secure));
        secure.once('error', (err) => done(err));
      })
      .catch((err) => done(err));
    return undefined;
  }
}

/* -------------------------------------------------------- プール */

/**
 * 複数プロキシのローテーションと「死んだプロキシを一定時間外す」管理。
 * IP ブロックされたプロキシを延々と叩き続けないためのもの。
 */
class ProxyPool {
  constructor(list, { now = () => Date.now(), cooldown = 30000, maxCooldown = 600000, failThreshold = 1 } = {}) {
    this.now = now;
    this.cooldown = cooldown;
    this.maxCooldown = maxCooldown;
    this.failThreshold = failThreshold;
    this.entries = parseProxyList(list).map((proxy) => ({
      proxy,
      agent: null,
      failures: 0,
      coolUntil: 0,
      lastUsed: 0,
      ok: 0,
    }));
    this.cursor = 0;
    this.last = null;
    this.direct = false;
    if (!this.entries.length) this.direct = true;
  }

  get size() {
    return this.entries.length;
  }

  /** 今すぐ使える（冷却中でない）本数 */
  healthyCount() {
    const now = this.now();
    return this.entries.filter((e) => e.coolUntil <= now).length;
  }

  /**
   * 一覧を差し替える。同じプロキシの「失敗回数 / 冷却」は引き継ぐ。
   * （リストを取り直すたびに成績がリセットされると、死んだプロキシを毎回試すことになる）
   */
  setEntries(list) {
    const parsed = parseProxyList(list);
    const previous = new Map(this.entries.map((e) => [e.proxy.label, e]));
    this.entries = parsed.map((proxy) => {
      const old = previous.get(proxy.label);
      return old
        ? Object.assign(old, { proxy })
        : { proxy, agent: null, failures: 0, coolUntil: 0, lastUsed: 0, ok: 0 };
    });
    this.direct = this.entries.length === 0;
    this.cursor = 0;
    return this.entries.length;
  }

  _agentFor(entry, options) {
    if (!entry.agent) entry.agent = new TunnelAgent(entry.proxy, options);
    return entry.agent;
  }

  /** 次に使うプロキシ（クールダウン中は飛ばす。全滅なら最も古い失敗を1つ試す） */
  pick(options = {}) {
    if (this.direct) return null;
    const now = this.now();
    const healthy = this.entries.filter((e) => e.coolUntil <= now);
    const list = healthy.length ? healthy : this.entries;
    if (!list.length) return null;
    // 「一度も失敗していないもの」を優先してラウンドロビン。
    // 全滅時だけ、冷却が最も早く明けるものから順に試す。
    let minFailures = Infinity;
    for (const e of list) if (e.failures < minFailures) minFailures = e.failures;
    let pool = list.filter((e) => e.failures === minFailures);
    if (!pool.length) pool = [...list].sort((a, b) => a.coolUntil - b.coolUntil);
    const entry = pool[this.cursor++ % pool.length];
    entry.lastUsed = now;
    this.last = entry;
    return this._agentFor(entry, options);
  }

  reportSuccess(target) {
    const entry = target || this.last;
    if (!entry) return;
    entry.failures = 0;
    entry.coolUntil = 0;
    entry.ok += 1;
  }

  reportFailure(target) {
    const entry = target || this.last;
    if (!entry) return;
    entry.failures += 1;
    if (entry.failures >= this.failThreshold) {
      entry.coolUntil = this.now() + Math.min(
        this.cooldown * 2 ** (entry.failures - this.failThreshold),
        this.maxCooldown
      );
    }
  }

  status() {
    const now = this.now();
    return {
      direct: this.direct,
      count: this.entries.length,
      proxies: this.entries.map((e) => ({
        proxy: maskProxy(e.proxy), // 認証情報は含めない
        failures: e.failures,
        coolingFor: Math.max(0, e.coolUntil - now),
        ok: e.ok,
      })),
    };
  }
}

/* --------------------------------------------------------- fetch */

/**
 * プロキシ対応の fetch を作る。
 *   - プロキシ未設定なら素の https.Agent（従来どおり直接接続）
 *   - 設定されていればリクエストごとにローテーション
 *   - node-fetch v2 互換（res.ok / res.status / res.json() / res.text()）
 */
function createProxiedFetch({
  proxies,
  timeout = 0,
  tunnelTimeout = DEFAULT_TIMEOUT,
  rejectUnauthorized = true,
  fetchImpl = null,
  now = () => Date.now(),
  pool: existingPool = null,
  poolOptions = {},
} = {}) {
  const nodeFetch = fetchImpl || require('node-fetch');
  const pool = existingPool || new ProxyPool(proxies, { now, ...poolOptions });
  const agentOptions = { tunnelTimeout, rejectUnauthorized };
  const directAgent = new https.Agent({ keepAlive: false, rejectUnauthorized });

  const fetchFn = async (url, init = {}) => {
    const agent = pool.direct
      ? directAgent
      : () => pool.pick(agentOptions) || directAgent;
    const options = { ...init, agent };
    if (timeout > 0 && !options.signal) options.timeout = timeout;

    try {
      const res = await nodeFetch(url, options);
      if (res && res.ok) pool.reportSuccess();
      return res;
    } catch (err) {
      pool.reportFailure();
      throw err;
    }
  };

  fetchFn.pool = pool;
  fetchFn.status = () => pool.status();
  return fetchFn;
}

/** 環境変数から一覧を読む（YT_META_PROXY 優先、なければ HTTPS_PROXY / HTTP_PROXY） */
function proxiesFromEnv(env = process.env) {
  const list = env.YT_META_PROXY || env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || '';
  return parseProxyList(list);
}

module.exports = {
  parseProxyUrl,
  parseProxyList,
  maskProxy,
  connectThroughProxy,
  TunnelAgent,
  ProxyPool,
  createProxiedFetch,
  proxiesFromEnv,
};
