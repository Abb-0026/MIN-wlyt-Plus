'use strict';

/**
 * ストリーム取得の共通ロジック。
 *
 * 方針（過去バージョンの比較から採用したもの）:
 *   1. Min-Tube API / sia-dl は即時並列、Rapid / ai-fetch は既存600msヘッジで起動（旧2秒待ちはしない）
 *   2. 直接URLの主系を優先しつつ、起動済みの Rapid が先に成功したら遅い主系を待たず返す
 *   3. 結果をメモリキャッシュし、同じ動画の再訪（戻る・関連動画の行き来）を即表示する
 *   4. コメント取得はストリーム取得と並列に走らせ、ページ描画をブロックしない
 *
 * ティア:
 *   0 = 直接再生できる googlevideo URL を返す取得元（Min-Tube API / sia-dl）
 *   1 = 直接再生できるが遅めの取得元（RapidAPI）
 *   2 = 最終手段（ai-fetch。埋め込み URL になることがある）
 */

const LATE_ENDPOINT = 'https://getlate.dev/api/tools/youtube-live-downloader';
const LATE_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
};

const DEFAULTS = {
  timeout: 4000, // 取得元ごとのタイムアウト
  deadline: 6000, // 全体の打ち切り時間
  hedgeDelay: 600, // 上位ティアがこの時間以内に答えたら、下位ティア(RapidAPI等)は呼ばない
  ttl: 10 * 60 * 1000, // 成功結果のキャッシュ保持時間
  commentTtl: 5 * 60 * 1000, // コメントのキャッシュ保持時間
  lateTtl: 60 * 1000, // /360 (getlate.dev) の URL キャッシュ
  lateTimeout: 2500, // getlate.dev の応答待ちを上流の全体期限より短くする
  commentTimeout: 2500, // コメント取得の打ち切り時間
};

const TIER = { PRIMARY: 0, SECONDARY: 1, EMBED: 2 };

/** getlate.dev を経由して 360p 相当の URL を引く（旧 /360/:videoId と同じ挙動） */
function lateTargetUrl(videoId) {
  return `${LATE_ENDPOINT}?url=${encodeURIComponent(
    `https://www.youtube.com/watch?v=${videoId}`
  )}&formatId=2`;
}

function normalizeComments(data) {
  return data && typeof data === 'object' && Array.isArray(data.comments)
    ? data
    : { commentCount: 0, comments: [] };
}

/** URL を JSON として取得する。失敗したら reject する。 */
async function fetchJson(fetchImpl, url, timeout, parentSignal) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal && parentSignal.reason);
  if (parentSignal) {
    if (parentSignal.aborted) abortFromParent();
    else parentSignal.addEventListener('abort', abortFromParent, { once: true });
  }

  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : 'no response'}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
    if (parentSignal) parentSignal.removeEventListener('abort', abortFromParent);
  }
}

const hasStream = (data) => !!(data && typeof data.stream_url === 'string' && data.stream_url.trim());

/** ログ用に API のホスト名だけを取り出す */
function hostOf(base) {
  try {
    return new URL(base).host || base;
  } catch (e) {
    return String(base);
  }
}

/**
 * 複数取得元を走らせ、最も優先度の高い成功結果を返す。
 *
 * ・最上位ティア(PRIMARY)の取得元は即座に全部スタートする（ここが最速化の要点）
 * ・RapidAPI は hedgeDelay 後にだけ起動し、起動後に先に成功した場合は遅い PRIMARY を待たず返す。
 *   すでに回数制限のあるリクエストを消費しているので、結果も待ち時間短縮に使う。
 * ・ai-fetch は直接再生 URL より下位のため、上位の成否が決まってから採用する。
 */
function raceTiered(providers, { fetchJson: get, timeout, deadline, now }) {
  return new Promise((resolve) => {
    let best = null;
    let finished = false;
    const timers = [];
    const active = new Map();

    // 未決着の取得元（未発動のヘッジを含む）をティア付きで持つ
    const outstanding = new Map();
    providers.forEach((provider, index) => outstanding.set(index, provider.tier));

    const finish = () => {
      if (finished) return;
      finished = true;
      for (const timer of timers) clearTimeout(timer);
      // 勝者が決まった後に遅い上流を残さない。キャンセル可能な HTTP を直ちに閉じる。
      for (const controller of active.values()) controller.abort();
      active.clear();
      resolve(best);
    };

    // 自ティアより優先度の高い取得元が残っていなければ、今の最良結果で打ち切る
    const maybeFinish = () => {
      if (finished || !best) return;
      for (const tier of outstanding.values()) {
        if (tier < best.tier) return;
      }
      finish();
    };

    const start = (provider, key) => {
      if (finished || active.has(key)) return;
      const controller = new AbortController();
      active.set(key, controller);

      get(provider.url, timeout, controller.signal)
        .then((data) => {
          if (!hasStream(data)) return;
          if (!best || provider.tier < best.tier) {
            best = { data, provider: provider.name, tier: provider.tier, ms: now() };
          }
          if (provider.fastFallback) finish();
        })
        .catch(() => {})
        .then(() => {
          active.delete(key);
          outstanding.delete(key);
          if (outstanding.size === 0) return finish();
          maybeFinish();
        });
    };

    const deadlineTimer = setTimeout(finish, deadline);
    if (typeof deadlineTimer.unref === 'function') deadlineTimer.unref();
    timers.push(deadlineTimer);

    // 下位ティアは hedgeDelay 後に発動する（それまでに上位が決着したら呼ばれない）
    for (const delay of [...new Set(providers.map((p) => p.delay || 0))].filter((d) => d > 0)) {
      const timer = setTimeout(() => {
        providers.forEach((provider, index) => {
          if ((provider.delay || 0) === delay) start(provider, index);
        });
      }, delay);
      timers.push(timer);
    }

    if (!providers.length) return finish();
    providers.forEach((provider, index) => {
      if (!provider.delay) start(provider, index);
    });
  });
}

class StreamResolver {
  constructor({
    fetchImpl,
    ttl = DEFAULTS.ttl,
    commentTtl = DEFAULTS.commentTtl,
    timeout = DEFAULTS.timeout,
    deadline = DEFAULTS.deadline,
    hedgeDelay = DEFAULTS.hedgeDelay,
    lateTtl = DEFAULTS.lateTtl,
    lateTimeout = DEFAULTS.lateTimeout,
    now = () => Date.now(),
  } = {}) {
    if (typeof fetchImpl !== 'function') {
      throw new TypeError('StreamResolver requires a fetch implementation');
    }
    this.fetchImpl = fetchImpl;
    this.ttl = ttl;
    this.commentTtl = commentTtl;
    this.timeout = timeout;
    this.deadline = deadline;
    this.hedgeDelay = hedgeDelay;
    this.lateTtl = lateTtl;
    this.lateTimeout = lateTimeout;
    this.now = now;
    this.cache = new Map();
    this.commentCache = new Map();
    this.lateCache = new Map();
    this.inflight = new Map();
    this.lateInflight = new Map();
    this.stats = { hits: 0, misses: 0, inflightHits: 0, commentHits: 0, byProvider: {} };
  }

  /** /360/:videoId 相当。getlate.dev のリダイレクト先 URL を返す（キャッシュ・同時取得の集約付き） */
  async getLateUrl(videoId) {
    const cached = this.lateCache.get(videoId);
    if (cached && cached.expiry > this.now()) return cached.url;

    const pending = this.lateInflight.get(videoId);
    if (pending) return pending;

    const request = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.lateTimeout);
      try {
        const res = await this.fetchImpl(lateTargetUrl(videoId), {
          method: 'GET',
          headers: LATE_HEADERS,
          redirect: 'follow',
          signal: controller.signal,
        });
        if (!res || !res.ok) throw new Error(`getlate.dev HTTP ${res ? res.status : 'no response'}`);
        const url = res.url || '';
        if (!url) throw new Error('getlate.dev returned no url');
        // URLだけ必要なので、リダイレクト後の動画本体を誤って読み込まない。
        if (res.body && typeof res.body.destroy === 'function') res.body.destroy();
        this.lateCache.set(videoId, { url, expiry: this.now() + this.lateTtl });
        return url;
      } finally {
        clearTimeout(timer);
      }
    })();

    this.lateInflight.set(videoId, request);
    try {
      return await request;
    } finally {
      if (this.lateInflight.get(videoId) === request) this.lateInflight.delete(videoId);
    }
  }

  providers(videoId, { apiList = [], baseUrl = '' } = {}) {
    // ヘルスチェッカーの重複・末尾スラッシュを除き、同じ API に二重で飛ばさない。
    const uniqueApiList = [...new Set(
      (Array.isArray(apiList) ? apiList : [])
        .filter((base) => typeof base === 'string')
        .map((base) => base.trim().replace(/\/+$/, ''))
        .filter(Boolean)
    )];
    const appBase = String(baseUrl || '').replace(/\/+$/, '');

    return [
      ...uniqueApiList.map((base) => ({
        name: `min-tube:${hostOf(base)}`,
        tier: TIER.PRIMARY,
        url: `${base}/api/video/${videoId}`,
      })),
      { name: 'sia-dl', tier: TIER.PRIMARY, url: `${appBase}/sia-dl/${videoId}` },
      // 下位ティアは回数制限や外部依存があるため、上位が早々に答えた場合は走らせない
      { name: 'rapid', tier: TIER.SECONDARY, url: `${appBase}/rapid/${videoId}`, delay: this.hedgeDelay, fastFallback: true },
      { name: 'ai-fetch', tier: TIER.EMBED, url: `${appBase}/ai-fetch/${videoId}`, delay: this.hedgeDelay },
    ];
  }

  /**
   * 動画データを解決する。失敗したときは null を返す（呼び出し側でフォールバックする）。
   * @returns {Promise<{data: object, provider: string, ms: number, cached: boolean}|null>}
   */
  async resolve(videoId, { apiList = [], baseUrl = '' } = {}) {
    const cached = this.cache.get(videoId);
    if (cached && cached.expiry > this.now()) {
      this.stats.hits += 1;
      return { ...cached.value, cached: true };
    }

    // 同じ動画を同時に開いたときは、全プロバイダーへの重複アクセスを1レースにまとめる。
    const pending = this.inflight.get(videoId);
    if (pending) {
      this.stats.inflightHits += 1;
      return pending;
    }
    this.stats.misses += 1;

    const request = (async () => {
      const startedAt = this.now();
      const get = (url, timeout, signal) => fetchJson(this.fetchImpl, url, timeout, signal);
      const result = await raceTiered(this.providers(videoId, { apiList, baseUrl }), {
        fetchJson: get,
        timeout: this.timeout,
        deadline: this.deadline,
        now: () => this.now() - startedAt,
      });

      if (!result) return null;

      const value = {
        data: result.data,
        provider: result.provider,
        tier: result.tier,
        ms: result.ms,
        cached: false,
      };
      this.stats.byProvider[result.provider] = (this.stats.byProvider[result.provider] || 0) + 1;
      this.cache.set(videoId, { value, expiry: this.now() + this.ttl });
      return value;
    })();

    this.inflight.set(videoId, request);
    try {
      return await request;
    } finally {
      if (this.inflight.get(videoId) === request) this.inflight.delete(videoId);
    }
  }

  /** コメントは「無くてもページは出す」。打ち切り時間を超えたら空で返す。 */
  async resolveComments(videoId, { apiList = [], commentTimeout = DEFAULTS.commentTimeout } = {}) {
    const empty = { commentCount: 0, comments: [] };

    // コメントは変化が遅いので短時間キャッシュする（動画ページの行き来を速くする）
    const cached = this.commentCache.get(videoId);
    if (cached && cached.expiry > this.now()) {
      this.stats.commentHits += 1;
      return cached.value;
    }
    if (!apiList.length) return empty;
    const attempt = (async () => {
      for (const base of apiList) {
        try {
          const data = await fetchJson(this.fetchImpl, `${base}/api/comments/${videoId}`, commentTimeout);
          const normalized = normalizeComments(data);
          if (normalized.comments.length || normalized.commentCount) return normalized;
        } catch (e) {
          /* 次の API へ */
        }
      }
      return empty;
    })();

    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(empty), commentTimeout);
      if (typeof timer.unref === 'function') timer.unref();
    });

    let result;
    try {
      result = await Promise.race([attempt, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    // 0件のときはキャッシュしない（直後に取り直せるように）
    if (result && (result.comments.length || result.commentCount)) {
      this.commentCache.set(videoId, { value: result, expiry: this.now() + this.commentTtl });
    }
    return result || empty;
  }

  /** 期限切れキャッシュの掃除（index.js の定期処理から呼ばれる） */
  sweep() {
    const now = this.now();
    for (const store of [this.cache, this.commentCache, this.lateCache]) {
      for (const [key, entry] of store) {
        if (entry.expiry <= now) store.delete(key);
      }
    }
  }
}

module.exports = {
  StreamResolver,
  TIER,
  DEFAULTS,
  normalizeComments,
  lateTargetUrl,
  hasStream,
};
