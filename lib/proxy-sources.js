'use strict';

/**
 * 無料プロキシリストの自動取得
 *
 * プロキシを手で設定しなくても、公開されている無料プロキシのリストを
 * 定期的に取り込んでローテーションに回す。
 *
 * 方針:
 *   1. 取得元は複数。1つ死んでも他が生きていれば成立する（1本もダメなら前回のリストを保持）
 *   2. 起動をブロックしない（裏で取りに行き、取れた分から使い始める）
 *   3. 「検証」はしない。数百本すべてに CONNECT を打つと逆に重いので、
 *      実際に使って失敗したものから冷却して外す（lib/proxy-tunnel.js の ProxyPool）
 *   4. 応答は上限 max 件で打ち切り、メモリも通信も膨らませない
 *
 * ⚠ 無料プロキシは第三者が運用しています。
 *   TLS はプロキシを貫通して end-to-end に張る（CONNECT トンネル）ので、
 *   見えるのは暗号化トラフィックと接続先ホスト名（www.youtube.com）だけです。
 *   証明書検証は既定で有効なので、MITM は失敗します（YT_META_TLS_REJECT=0 にしないこと）。
 */
const { parseProxyUrl, isProxyEntry } = (() => {
  const m = require('./proxy-tunnel');
  return {
    parseProxyUrl: m.parseProxyUrl,
    isProxyEntry: (v) => !!v && typeof v === 'object' && !!v.type && !!v.host,
  };
})();

/** 既定の取得元（環境変数 YT_META_PROXY_SOURCES で丸ごと差し替えられる） */
const DEFAULT_SOURCES = [
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
  'https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/socks5.txt',
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt',
  'https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-http.txt',
  'https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-socks5.txt',
  'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all',
  'https://api.proxyscrape.com/v2/?request=getproxies&protocol=socks5&timeout=10000&country=all',
  'https://www.proxy-list.download/api/v1/get?type=http',
  'https://spys.me/proxy.txt',
];

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** プライベート/ループバックは外からは使えないので弾く（テストでは allowPrivate） */
function isPrivateHost(host) {
  const m = String(host).match(IPV4);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 0 || a >= 224) return true;
  return false;
}

const isIpv4 = (host) => IPV4.test(String(host)) && String(host).split('.').every((n) => Number(n) <= 255);

/**
 * リストのテキストをプロキシ一覧にする。
 * 取得元ごとに書式がバラバラなので、だいたい何でも読めるようにする:
 *   1.2.3.4:8080              （生の host:port → http 扱い）
 *   http://1.2.3.4:8080
 *   socks5://1.2.3.4:1080
 *   1.2.3.4:8080:user:pass    （認証つき）
 *   1.2.3.4:8080 US-N+S-      （spys.me 形式 → 最初のトークンだけ使う）
 *   [{"ip":"1.2.3.4","port":8080,"protocol":"http"}] （JSON）
 */
function parseProxyListText(text, { allowPrivate = false, defaultType = 'http' } = {}) {
  const out = [];
  const seen = new Set();
  const push = (entry) => {
    if (!entry || !isProxyEntry(entry)) return;
    if (!allowPrivate && (isPrivateHost(entry.host) || (!isIpv4(entry.host) && !/\.[a-z]{2,}$/i.test(entry.host)))) return;
    const key = entry.label;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(entry);
  };

  const raw = String(text == null ? '' : text);

  // JSON のとき（配列 or {"data":[...]}）
  const trimmed = raw.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      const rows = Array.isArray(parsed) ? parsed
        : Array.isArray(parsed && parsed.data) ? parsed.data
        : Array.isArray(parsed && parsed.proxies) ? parsed.proxies
        : null;
      if (rows) {
        for (const row of rows) {
          if (typeof row === 'string') {
            push(parseProxyUrl(row));
          } else if (row && typeof row === 'object') {
            const host = row.ip || row.host || row.address || row.proxy;
            const port = row.port;
            const type = String(row.protocol || row.type || defaultType).toLowerCase();
            if (host && port) {
              const scheme = type.startsWith('socks') ? 'socks5' : 'http';
              push(parseProxyUrl(`${scheme}://${row.username ? `${row.username}:${row.password || ''}@` : ''}${host}:${port}`));
            }
          }
        }
        return out;
      }
    } catch (e) {
      /* JSON じゃなかった。テキストとして解析する */
    }
  }

  for (const line of raw.split(/\r?\n/)) {
    let token = line.trim();
    if (!token || token.startsWith('#') || token.startsWith('//')) continue;
    // "1.2.3.4:8080 US-N+S-" のような行は最初のトークンだけ使う
    token = token.split(/\s+/)[0].replace(/[",;]/g, '');
    if (!token) continue;

    let entry = parseProxyUrl(token);
    if (!entry) {
      // host:port[:user:pass] 形式
      const m = token.match(/^([^\s:/]+):(\d{1,5})(?::([^:\s]*):([^:\s]*))?$/);
      if (!m) continue;
      const [, host, port, user, pass] = m;
      const scheme = defaultType === 'socks5' ? 'socks5' : 'http';
      entry = parseProxyUrl(
        `${scheme}://${user ? `${encodeURIComponent(user)}:${encodeURIComponent(pass || '')}@` : ''}${host}:${port}`
      );
    }
    push(entry);
  }
  return out;
}

/** 同時実行数を制限しながら map する */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index).catch((err) => ({ error: err }));
    }
  });
  await Promise.all(runners);
  return results;
}

class ProxyHarvester {
  constructor({
    pool,
    fetchImpl,
    sources,
    timeout = 6000,
    concurrency = 4,
    refreshMs = 15 * 60 * 1000,
    max = 300,
    minKeep = 10,
    allowPrivate = false,
    now = () => Date.now(),
    logger = null,
  } = {}) {
    if (!pool) throw new TypeError('ProxyHarvester requires a ProxyPool');
    this.pool = pool;
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.sources = (() => {
      if (Array.isArray(sources) && sources.length) return sources.filter(Boolean);
      if (typeof sources === 'string' && sources.trim()) return sources.split(/[,\s]+/).filter(Boolean);
      return DEFAULT_SOURCES;
    })();
    this.timeout = timeout;
    this.concurrency = concurrency;
    this.refreshMs = refreshMs;
    this.max = max;
    this.minKeep = minKeep;
    this.allowPrivate = allowPrivate;
    this.now = now;
    this.logger = logger;
    this._timer = null;
    this._job = null;
    this.last = {
      at: 0,
      ms: 0,
      added: 0,
      total: 0,
      kept: false,
      sources: [],
      running: false,
    };
  }

  _log(msg, extra) {
    if (this.logger) this.logger('[yt-proxy] ' + msg, extra);
  }

  /** 1つの取得元を取りに行く */
  async _fetchOne(url) {
    const started = this.now();
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeout) : null;
    try {
      const res = await this.fetchImpl(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MIN-wlyt-Plus/1.0)' },
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : 'no response'}`);
      const text = await res.text();
      const isSocks = /socks/i.test(url);
      const list = parseProxyListText(text, {
        allowPrivate: this.allowPrivate,
        defaultType: isSocks ? 'socks5' : 'http',
      });
      return { url, ok: true, count: list.length, ms: this.now() - started, list };
    } catch (err) {
      return { url, ok: false, count: 0, ms: this.now() - started, error: err && err.message, list: [] };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 全取得元から集める（同時実行は concurrency まで） */
  async refresh() {
    if (this._job) return this._job;
    this._job = (async () => {
      this.last.running = true;
      const started = this.now();
      try {
        const results = await mapLimit(this.sources, this.concurrency, (url) => this._fetchOne(url));

        const collected = [];
        const seen = new Set();
        // 取得元ごとに交互に混ぜる（1つのソースに偏らせない）
        const lists = results.filter((r) => r && r.ok && r.list.length).map((r) => r.list.slice());
        for (let i = 0; collected.length < this.max; i++) {
          let progressed = false;
          for (const list of lists) {
            const entry = list[i];
            if (!entry) continue;
            progressed = true;
            if (seen.has(entry.label)) continue;
            seen.add(entry.label);
            collected.push(entry);
            if (collected.length >= this.max) break;
          }
          if (!progressed) break;
        }

        let kept = false;
        if (collected.length >= Math.min(this.minKeep, 1)) {
          this.pool.setEntries(collected);
        } else if (this.pool.size > 0) {
          // 全部コケたときは、今あるリストを捨てない
          kept = true;
        }

        this.last = {
          at: this.now(),
          ms: this.now() - started,
          added: collected.length,
          total: this.pool.size,
          kept,
          running: false,
          sources: results.map((r) => ({
            url: r && r.url,
            ok: !!(r && r.ok),
            count: (r && r.count) || 0,
            ms: (r && r.ms) || 0,
            error: (r && r.error) || null,
          })),
        };
        this._log(`refresh: ${collected.length} proxies from ${results.filter((r) => r && r.ok).length}/${results.length} sources`, {
          total: this.last.total,
          ms: this.last.ms,
          kept,
        });
        return this.last;
      } finally {
        this.last.running = false;
        this._job = null;
      }
    })();
    return this._job;
  }

  /** 起動時に裏で取りに行く（待たない）＋ 定期更新 */
  start() {
    this.refresh().catch((err) => this._log('refresh failed: ' + (err && err.message)));
    if (this.refreshMs > 0) {
      this._timer = setInterval(() => {
        // 使えるプロキシが尽きかけたら待たずに取り直す
        const starving = this.pool.size === 0 || this.pool.healthyCount() <= 1;
        if (starving || this.now() - this.last.at >= this.refreshMs) {
          this.refresh().catch(() => {});
        }
      }, Math.min(this.refreshMs, 60000));
      if (typeof this._timer.unref === 'function') this._timer.unref();
    }
    return this;
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  status() {
    return {
      enabled: true,
      refreshMs: this.refreshMs,
      max: this.max,
      sourceCount: this.sources.length,
      lastRefreshAt: this.last.at,
      lastRefreshMs: this.last.ms,
      lastAdded: this.last.added,
      keptPrevious: this.last.kept,
      running: !!this._job,
      sources: this.last.sources,
    };
  }
}

module.exports = {
  ProxyHarvester,
  parseProxyListText,
  DEFAULT_SOURCES,
  isPrivateHost,
};
