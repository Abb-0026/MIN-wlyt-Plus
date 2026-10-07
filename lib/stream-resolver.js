'use strict';

/**
 * ストリーム取得の共通ロジック。
 *
 * 方針（過去バージョンの比較から採用したもの）:
 *   1. すべての取得元を「同時に」走らせる（逐次フォールバック・2秒の待機をしない）
 *   2. 優先度(ティア)を付け、最上位ティアが1つでも成功した時点で即座に解決する
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
async function fetchJson(fetchImpl, url, timeout) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeout) : null;
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : 'no response'}`);
    return await res.json();
  } finally {
    if (timer) clearTimeout(timer);
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
 * ・下位ティアは「hedge」として、上位が hedgeDelay 以内に答えなかった時だけ走らせる。
 *   こうしないと RapidAPI など回数制限のある取得元を毎回消費してしまう。
 * ・最上位ティアが1つでも成功した瞬間に解決する（他を待たない）
 */
function raceTiered(providers, { fetchJson: get, timeout, deadline, now }) {
  return new Promise((resolve) => {
    let best = null;
    let finished = false;
    const timers = [];

    // 未決着の取得元（未発動のヘッジを含む）をティア付きで持つ
    const outstanding = new Map();
    providers.forEach((provider, index) => outstanding.set(index, provider.tier));

    const finish = () => {
      if (finished) return;
      finished = true;
      for (const timer of timers) clearTimeout(timer);
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
      get(provider.url, timeout)
        .then((data) => {
          if (hasStream(data) && (!best || provider.tier < best.tier)) {
            best = { data, provider: provider.name, tier: provider.tier, ms: now() };
          }
        })
        .catch(() => {})
        .then(() => {
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
    this.now = now;
    this.cache = new Map();
    this.commentCache = new Map();
    this.lateCache = new Map();
    this.stats = { hits: 0, misses: 0, commentHits: 0, byProvider: {} };
  }

  /** /360/:videoId 相当。getlate.dev のリダイレクト先 URL を返す（キャッシュ付き） */
  async getLateUrl(videoId) {
    const cached = this.lateCache.get(videoId);
    if (cached && cached.expiry > this.now()) return cached.url;

    const res = await this.fetchImpl(lateTargetUrl(videoId), {
      method: 'GET',
      headers: LATE_HEADERS,
      redirect: 'follow',
    });
    const url = res && res.url ? res.url : '';
    if (!url) throw new Error('getlate.dev returned no url');
    this.lateCache.set(videoId, { url, expiry: this.now() + DEFAULTS.lateTtl });
    return url;
  }

  providers(videoId, { apiList = [], baseUrl = '' } = {}) {
    return [
      ...apiList.map((base) => ({
        name: `min-tube:${hostOf(base)}`,
        tier: TIER.PRIMARY,
        url: `${base}/api/video/${videoId}`,
      })),
      { name: 'sia-dl', tier: TIER.PRIMARY, url: `${baseUrl}/sia-dl/${videoId}` },
      // 下位ティアは回数制限や外部依存があるため、上位が早々に答えた場合は走らせない
      { name: 'rapid', tier: TIER.SECONDARY, url: `${baseUrl}/rapid/${videoId}`, delay: this.hedgeDelay },
      { name: 'ai-fetch', tier: TIER.EMBED, url: `${baseUrl}/ai-fetch/${videoId}`, delay: this.hedgeDelay },
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
    this.stats.misses += 1;

    const startedAt = this.now();
    const get = (url, timeout) => fetchJson(this.fetchImpl, url, timeout);
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
