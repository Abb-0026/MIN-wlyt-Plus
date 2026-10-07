'use strict';

/**
 * YouTube メタデータ取得（InnerTube 直結）
 *
 * ねらい:
 *   youtube-search-api は「公開ページをスクレイピングする」ため 1 回の検索に
 *   数往復かかり、関連動画のために3回も叩いていた。YouTube 自身の内部 API
 *   (youtubei/v1) を直接叩けば 1 往復で
 *     ・動画メタ（タイトル / チャンネル / 再生数 / 高評価 / 説明 / 関連動画）
 *     ・コメント（継続トークン付き）
 *     ・検索 / トレンド / チャンネル
 *   がまとめて取れる。さらに結果をキャッシュすれば2回目以降は往復ゼロ。
 *
 * 方針（Vandal と同系統の技法を、このリポジトリ向けに自前実装したもの）:
 *   1. まず上位クライアント(WEB)へ即発行し、hedgeMs 以内に返らなければ
 *      予備クライアント(ANDROID/IOS)も並走させる（= 並列ヘッジ）。
 *      速い経路が勝った瞬間に解決し、負けた経路は中断する。
 *   2. visitorData は「待たない」。未取得でもリクエストは即発行し、
 *      裏で1本だけ取得して次回以降に使う（初回1往復の直列待ちを消す）。
 *   3. 応答はキャッシュ + single-flight で束ねる。
 *   4. 継続トークンは受け取り側で正規化し、壊れたトークンを上流へ送らない
 *      （二重エンコード由来の 400 ループを構造的に潰す）。
 *
 * ⚠ ストリーム URL は扱わない。player エンドポイントは呼ばない。
 *   再生用 URL は apiListCache（Min-Tube API 群）側の責務。
 */
const { TtlCache } = require('./ttl-cache');

const HOST = 'https://www.youtube.com';
const API_PATH = '/youtubei/v1';

// 公開されている InnerTube のクライアント定数
const KEYS = {
  WEB: 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
  ANDROID: 'AIzaSyA8eiZmM1fanX44Xqp1Gg9mGKL0r2GzUQw',
  IOS: 'AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc',
};

const CLIENTS = {
  WEB: {
    key: KEYS.WEB,
    clientName: 'WEB',
    clientVersion: '2.20240726.00.00',
    clientNameHeader: '1',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  },
  MWEB: {
    key: KEYS.WEB,
    clientName: 'MWEB',
    clientVersion: '2.20240726.00.00',
    clientNameHeader: '2',
    ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  },
  ANDROID: {
    key: KEYS.ANDROID,
    clientName: 'ANDROID',
    clientVersion: '19.44.38',
    clientNameHeader: '3',
    androidSdkVersion: 30,
    osName: 'Android',
    osVersion: '11',
    ua: 'com.google.android.youtube/19.44.38 (Linux; U; Android 11) gzip',
  },
  IOS: {
    key: KEYS.IOS,
    clientName: 'IOS',
    clientVersion: '19.44.38',
    clientNameHeader: '5',
    deviceMake: 'Apple',
    deviceModel: 'iPhone16,2',
    osName: 'iPhone',
    osVersion: '18.1.0.22B83',
    ua: 'com.google.ios.youtube/19.44.38 (iPhone16,2; U; CPU iOS 18_1_0 like Mac OS X;)',
  },
};

const DEFAULTS = {
  hl: 'ja',
  gl: 'JP',
  timeout: 6000,
  hedgeMs: 400, // この時間以内に返れば予備クライアントは呼ばない
  ttl: 10 * 60 * 1000, // メタのキャッシュ
  commentTtl: 5 * 60 * 1000,
  searchTtl: 10 * 60 * 1000,
  visitorTtl: 25 * 60 * 1000,
  max: 800,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ パース */

/** オブジェクトツリーから key を持つノードを深さ優先で探す（形が変わっても壊れにくい） */
function deepFind(obj, key, limit = 1) {
  const out = [];
  const stack = [obj];
  while (stack.length && out.length < limit) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object') continue;
    if (Array.isArray(cur)) {
      for (let i = cur.length - 1; i >= 0; i--) stack.push(cur[i]);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(cur, key)) out.push(cur[key]);
    for (const k of Object.keys(cur)) {
      const v = cur[k];
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return out.length ? out : null;
}

/** simpleText / runs / content のどれでも文字列にする */
function textOf(t) {
  if (t == null) return '';
  if (typeof t === 'string') return t;
  if (t.simpleText != null) return String(t.simpleText);
  if (typeof t.content === 'string') return t.content;
  if (t.text && typeof t.text.content === 'string') return String(t.text.content);
  if (t.dynamicTextViewModel) return textOf(t.dynamicTextViewModel.text);
  if (Array.isArray(t.runs)) return t.runs.map((r) => (r && r.text) || '').join('');
  return '';
}

const bestThumb = (thumbs) =>
  Array.isArray(thumbs) && thumbs.length ? String(thumbs[thumbs.length - 1].url || '') : '';

const thumbOf = (node) => bestThumb(node && node.thumbnails);

/** "1,234,567 回視聴" / "12万回視聴" などから数値だけ取り出す */
function countOf(text) {
  const raw = textOf(text);
  const m = raw.match(/([\d,\.]+)/);
  if (!m) return 0;
  const n = Number(String(m[1]).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/**
 * 継続トークンの正規化。
 * YouTube は %3D%3D のように既にエンコード済みのトークンを返すことがあり、
 * それをそのまま送り返すと二重エンコードになって 400 になる。受け取り側で剥がす。
 */
function normalizeContinuation(raw) {
  let t = String(raw == null ? '' : raw).trim();
  for (let i = 0; i < 3; i++) {
    if (!/%[0-9A-Fa-f]{2}/.test(t)) break;
    try {
      const d = decodeURIComponent(t);
      if (d === t) break;
      t = d;
    } catch (e) {
      break;
    }
  }
  return t.trim();
}

/** 明らかに壊れたトークンは上流へ送らない（無意味な 400 を生まない） */
function isPlausibleContinuation(t) {
  return typeof t === 'string' && t.length >= 32 && t.length <= 2048 && /^[A-Za-z0-9_\-=]+$/.test(t);
}

const isVideoId = (id) => typeof id === 'string' && /^[\w-]{11}$/.test(id);

/* --------------------------------------------------------- アイテム正規化 */

/** home.html が期待するカード形へ統一する */
function toCard(raw) {
  if (!raw || !raw.id) return null;
  const thumbs = [];
  if (raw.thumb) thumbs.push({ url: raw.thumb, width: 480, height: 270 });
  return {
    type: raw.kind === 'short' ? 'short' : 'video',
    id: raw.id,
    title: raw.title || '',
    channelTitle: raw.channel || '',
    channelId: raw.channelId || '',
    viewCountText: raw.views || '',
    publishedTimeText: raw.published || '',
    lengthText: raw.duration || '',
    thumbnail: { thumbnails: thumbs },
    channelThumbnail: raw.avatar || '',
  };
}

function parseVideoRenderer(r) {
  if (!r) return null;
  const id = r.videoId;
  if (!isVideoId(id)) return null;
  const owner = r.ownerText && r.ownerText.runs && r.ownerText.runs[0];
  const badges = Array.isArray(r.ownerBadges) ? JSON.stringify(r.ownerBadges) : '';
  return {
    kind: 'video',
    id,
    title: textOf(r.title),
    channel: owner ? owner.text : textOf(r.longBylineText) || textOf(r.shortBylineText),
    channelId: (owner && owner.navigationEndpoint && owner.navigationEndpoint.browseEndpoint
      && owner.navigationEndpoint.browseEndpoint.browseId)
      || r.channelId || '',
    views: textOf(r.viewCountText) || textOf(r.shortViewCountText),
    published: textOf(r.publishedTimeText),
    duration: textOf(r.lengthText) || textOf(r.thumbnailOverlays ? deepFind(r.thumbnailOverlays, 'thumbnailOverlayTimeStatusRenderer', 1)?.[0]?.text : ''),
    thumb: bestThumb(r.thumbnail && r.thumbnail.thumbnails) || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    avatar: bestThumb(deepFind(r.channelThumbnailSupportedRenderers || r.channelThumbnail, 'thumbnails', 1)?.[0]),
    verified: /VERIFIED/.test(badges),
  };
}

/** 2024 以降の统一レンダラ（lockupViewModel） */
function parseLockup(vm) {
  if (!vm) return null;
  const id = vm.contentId;
  if (!isVideoId(id)) return null;
  const md = vm.metadata && vm.metadata.lockupMetadataViewModel;
  const rows = [];
  const metaRows = (md && md.metadata && md.metadata.contentMetadataViewModel
    && md.metadata.contentMetadataViewModel.metadataRows) || [];
  for (const row of metaRows) {
    const parts = (row.metadataParts || []).map((p) => textOf(p.text)).filter(Boolean);
    if (parts.length) rows.push(parts);
  }
  const flat = rows.map((r) => r.join(' '));
  const ctype = String(vm.contentType || '');
  const isShort = ctype.includes('SHORT') || ctype.includes('REEL');
  const sources = deepFind(vm.contentImage || {}, 'sources', 1)?.[0];
  let duration = '';
  const badge = deepFind(vm.contentImage || {}, 'thumbnailBadgeViewModel', 1)?.[0];
  if (badge) {
    const t = textOf(badge).trim() || textOf(deepFind(badge, 'text', 1)?.[0]);
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(t)) duration = t;
  }
  return {
    kind: isShort ? 'short' : 'video',
    id,
    title: textOf(md && md.title),
    channel: flat[0] || '',
    channelId: '',
    views: flat.find((t) => /視聴|回視聴/.test(t)) || '',
    published: flat.find((t) => /(前|年前|か月前)/.test(t)) || '',
    duration,
    thumb: bestThumb(sources) || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    avatar: '',
  };
}

function parseReelItem(r) {
  if (!r) return null;
  const id = r.videoId;
  if (!isVideoId(id)) return null;
  return {
    kind: 'short',
    id,
    title: textOf(r.headline),
    channel: '',
    channelId: '',
    views: textOf(r.viewCountText),
    published: '',
    duration: '',
    thumb: bestThumb(r.thumbnail && r.thumbnail.thumbnails) || `https://i.ytimg.com/vi/${id}/hq720.jpg`,
    avatar: '',
  };
}

function parseShortsLockup(vm) {
  if (!vm) return null;
  const id = vm.entityId || deepFind(vm, 'reelWatchEndpoint', 1)?.[0]?.videoId
    || deepFind(vm, 'videoId', 1)?.[0];
  if (!isVideoId(id)) return null;
  const overlay = vm.overlayMetadata && vm.overlayMetadata.primaryText;
  return {
    kind: 'short',
    id,
    title: textOf(overlay),
    channel: '',
    channelId: '',
    views: textOf(vm.overlayMetadata && vm.overlayMetadata.secondaryText),
    published: '',
    duration: '',
    thumb: bestThumb(deepFind(vm, 'sources', 1)?.[0]) || `https://i.ytimg.com/vi/${id}/hq720.jpg`,
    avatar: '',
  };
}

/**
 * 応答ツリーから動画/チャンネル/再生リストを拾い集める。
 * レンダラ名は YouTube が頻繁に変えるので、複数系統をまとめて見る。
 */
function extractItems(root) {
  const items = [];
  const seen = new Set();
  let continuation = null;

  const push = (kind, it) => {
    if (!it || !it.id) return;
    const key = `${kind}:${it.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(it);
  };

  const walk = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 24) return;
    if (Array.isArray(node)) {
      for (const v of node) walk(v, depth + 1);
      return;
    }
    if (node.lockupViewModel) return push('video', parseLockup(node.lockupViewModel));
    if (node.shortsLockupViewModel) return push('short', parseShortsLockup(node.shortsLockupViewModel));
    if (node.richItemRenderer && node.richItemRenderer.content) return walk(node.richItemRenderer.content, depth + 1);
    if (node.reelItemRenderer) return push('short', parseReelItem(node.reelItemRenderer));
    if (node.gridVideoRenderer) return push('video', parseVideoRenderer(node.gridVideoRenderer));
    if (node.compactVideoRenderer) return push('video', parseVideoRenderer(node.compactVideoRenderer));
    if (node.playlistVideoRenderer) return push('video', parseVideoRenderer(node.playlistVideoRenderer));
    if (node.playlistPanelVideoRenderer) return push('video', parseVideoRenderer(node.playlistPanelVideoRenderer));
    if (node.videoRenderer) return push('video', parseVideoRenderer(node.videoRenderer));
    if (node.continuationItemRenderer) {
      const tok = normalizeContinuation(
        (node.continuationItemRenderer.continuationEndpoint
          && node.continuationItemRenderer.continuationEndpoint.continuationCommand
          && node.continuationItemRenderer.continuationEndpoint.continuationCommand.token)
        || deepFind(node.continuationItemRenderer, 'token', 1)?.[0]
      );
      if (tok) continuation = tok;
      return;
    }
    // 広告・ナッジ系の中身は見ない
    for (const k of Object.keys(node)) {
      if (k === 'adSlotRenderer' || k === 'feedNudgeRenderer' || k === 'statementBannerRenderer'
        || k === 'promotedSparklesWebRenderer' || k === 'richGridRenderer') {
        if (k !== 'richGridRenderer') continue;
      }
      walk(node[k], depth + 1);
    }
  };

  walk(root);
  return { items, continuation };
}

/* ---------------------------------------------------------------- メタ解析 */

function parsePrimaryInfo(contents) {
  const pri = deepFind(contents, 'videoPrimaryInfoRenderer', 1)?.[0] || {};
  const sec = deepFind(contents, 'videoSecondaryInfoRenderer', 1)?.[0] || {};
  const owner = deepFind(sec, 'videoOwnerRenderer', 1)?.[0] || {};

  const blob = JSON.stringify(contents);
  // 高評価数は 「…人が高く評価しました」 の accessibilityText にしか出ないことがある
  let likeText = '';
  const m = blob.match(/"(?:accessibilityText|label)":\s*"([^"]*?)([\d,\.]+)\s*(?:人もこの動画を高く評価|件の高評価|人が高く評価)/);
  if (m) likeText = m[2];

  const description = textOf(sec.attributedDescription && sec.attributedDescription.content)
    || textOf(deepFind(sec, 'descriptionBodyText', 1)?.[0])
    || '';

  return {
    title: textOf(pri.title),
    viewCountText: textOf(pri.viewCount && pri.viewCount.videoViewCountRenderer
      ? pri.viewCount.videoViewCountRenderer.viewCount : pri.viewCount),
    dateText: textOf(pri.dateText),
    likeText,
    description,
    channelId: (owner.navigationEndpoint && owner.navigationEndpoint.browseEndpoint
      && owner.navigationEndpoint.browseEndpoint.browseId)
      || (owner.title && owner.title.runs && owner.title.runs[0]
        && owner.title.runs[0].navigationEndpoint
        && owner.title.runs[0].navigationEndpoint.browseEndpoint
        && owner.title.runs[0].navigationEndpoint.browseEndpoint.browseId) || '',
    channelName: textOf(owner.title),
    channelSubs: textOf(owner.subscriberCountText),
    channelAvatar: bestThumb(owner.thumbnail && owner.thumbnail.thumbnails),
  };
}

function parseCommentPage(res) {
  const entities = new Map();
  const muts = (res.frameworkUpdates && res.frameworkUpdates.entityBatchUpdate
    && res.frameworkUpdates.entityBatchUpdate.mutations) || [];
  for (const m of muts) {
    const p = m && m.payload && m.payload.commentEntityPayload;
    if (p && m.entityKey) entities.set(m.entityKey, p);
  }

  const comments = [];
  let continuation = null;
  let countText = '';

  const toComment = (c) => {
    if (!c) return null;
    const author = c.author || '';
    const text = c.text || '';
    if (!author && !text) return null;
    return {
      author,
      authorThumbnails: c.avatar ? [{ url: c.avatar }] : [],
      authorChannelId: c.authorChannelId || '',
      content: text,
      publishedTimeText: c.published || '',
      likeCount: c.likes || '',
      replyCount: c.replyCount || '',
    };
  };

  const handleThread = (ctr) => {
    const vm = (ctr && (ctr.commentViewModel && ctr.commentViewModel.commentViewModel
      || ctr.commentViewModel)) || {};
    const replies = ctr && ctr.replies && ctr.replies.commentRepliesRenderer;
    const payload = vm.commentKey ? entities.get(vm.commentKey) : null;
    if (payload) {
      return toComment({
        author: payload.author && payload.author.displayName,
        authorChannelId: payload.author && payload.author.channelId,
        avatar: payload.author && payload.author.avatarThumbnailUrl,
        text: payload.properties && payload.properties.content && payload.properties.content.content,
        published: payload.properties && payload.properties.publishedTime,
        likes: String((payload.toolbar && (payload.toolbar.likeCountNotliked || payload.toolbar.likeCountLiked)) || ''),
        replyCount: String((payload.toolbar && payload.toolbar.replyCount) || ''),
      });
    }
    const cr = ctr && ctr.comment && ctr.comment.commentRenderer;
    if (cr) {
      return toComment({
        author: textOf(cr.authorText),
        authorChannelId: cr.authorEndpoint && cr.authorEndpoint.browseEndpoint
          && cr.authorEndpoint.browseEndpoint.browseId,
        avatar: bestThumb(cr.authorThumbnail && cr.authorThumbnail.thumbnails),
        text: textOf(cr.contentText),
        published: textOf(cr.publishedTimeText),
        likes: String(cr.likeCount == null ? '' : cr.likeCount),
        replyCount: textOf(replies && replies.moreText),
      });
    }
    if (vm.commentId || vm.authorName) {
      return toComment({
        author: vm.authorName || '',
        authorChannelId: vm.authorChannelId || '',
        avatar: vm.avatarImageUrl || '',
        text: typeof vm.commentText === 'string' ? vm.commentText : textOf(vm.commentText),
        published: typeof vm.publishedTimeText === 'string' ? vm.publishedTimeText : textOf(vm.publishedTimeText),
        likes: String(vm.likeCount == null ? '' : vm.likeCount),
        replyCount: textOf(replies && replies.moreText),
      });
    }
    return null;
  };

  const eps = res.onResponseReceivedEndpoints || res.onResponseReceivedCommands || [];
  for (const ep of eps) {
    for (const k of ['reloadContinuationItemsCommand', 'appendContinuationItemsCommand', 'appendContinuationItemsAction']) {
      const bag = ep[k] && ep[k].continuationItems;
      if (!bag) continue;
      for (const it of bag) {
        if (it.commentsHeaderRenderer) {
          countText = textOf(it.commentsHeaderRenderer.countText)
            || textOf(it.commentsHeaderRenderer.commentsCount) || countText;
        } else if (it.commentThreadRenderer) {
          const c = handleThread(it.commentThreadRenderer);
          if (c) comments.push(c);
        } else if (it.commentRenderer) {
          const c = handleThread({ comment: { commentRenderer: it.commentRenderer } });
          if (c) comments.push(c);
        } else if (it.continuationItemRenderer) {
          const t = normalizeContinuation(
            (it.continuationItemRenderer.continuationEndpoint
              && it.continuationItemRenderer.continuationEndpoint.continuationCommand
              && it.continuationItemRenderer.continuationEndpoint.continuationCommand.token)
            || deepFind(it.continuationItemRenderer, 'token', 1)?.[0]
          );
          if (isPlausibleContinuation(t)) continuation = t;
        }
      }
    }
  }
  return { comments, continuation, countText };
}

/* ------------------------------------------------------------- クライアント */

class YtMetadata {
  constructor({
    fetchImpl,
    hl = DEFAULTS.hl,
    gl = DEFAULTS.gl,
    timeout = DEFAULTS.timeout,
    hedgeMs = DEFAULTS.hedgeMs,
    ttl = DEFAULTS.ttl,
    commentTtl = DEFAULTS.commentTtl,
    searchTtl = DEFAULTS.searchTtl,
    max = DEFAULTS.max,
    now = () => Date.now(),
    logger = null,
    host = HOST,
    // --- IPブロック環境で無駄な外向き通信を止めるための装置 ---
    circuitThreshold = 3,     // この回数続けて失敗したら一時的に呼び出しを止める
    circuitCooldown = 60000,  // その止める時間（ failures ごとに倍増、最大 circuitMaxCooldown ）
    circuitMaxCooldown = 600000,
    negativeTtl = 30000,      // 失敗したリクエストをこの時間は「即失败」として覚える
    negativeMax = 500,
  } = {}) {
    this.fetchImpl = fetchImpl || globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') {
      throw new TypeError('YtMetadata requires a fetch implementation');
    }
    this.host = String(host || HOST).replace(/\/+$/, '');
    this.hl = hl;
    this.gl = gl;
    this.timeout = timeout;
    this.hedgeMs = Number.isFinite(hedgeMs) ? hedgeMs : DEFAULTS.hedgeMs;
    this.now = now;
    this.logger = logger;
    this.cache = new TtlCache({ max, ttl, now });
    this.visitorCache = new TtlCache({ max: 4, ttl: DEFAULTS.visitorTtl, now });
    this.commentTtl = commentTtl;
    this.searchTtl = searchTtl;
    this.ttl = ttl;
    this.visitorId = undefined;
    this._visitorJob = null;
    this._visitorSetAt = 0;
    this._visitorTryAt = 0;
    // サーキットブレーカー / ネガティブキャッシュ
    this.circuit = {
      threshold: circuitThreshold,
      cooldown: circuitCooldown,
      baseCooldown: circuitCooldown,
      maxCooldown: circuitMaxCooldown,
      failures: 0,
      openUntil: 0,
      opened: 0,
    };
    this.negativeTtl = negativeTtl;
    this.negativeMax = negativeMax;
    this._negatives = new Map();
    this.stats = {
      calls: 0, hedges: 0, errors: 0, cacheHits: 0,
      shortCircuited: 0, byEndpoint: {},
    };
  }

  /** 診断用の状態（/api/meta-stats で返す） */
  state() {
    const now = this.now();
    return {
      host: this.host,
      circuitOpen: now < this.circuit.openUntil,
      circuitOpenFor: Math.max(0, this.circuit.openUntil - now),
      consecutiveFailures: this.circuit.failures,
      circuitOpenedCount: this.circuit.opened,
      cooldownMs: this.circuit.cooldown,
      negativeEntries: this._negatives.size,
      hedging: this.circuit.failures === 0,
      visitorId: !!this.visitorId,
    };
  }

  /** 外向き通信を止めているか */
  get isBlocked() {
    return this.now() < this.circuit.openUntil;
  }

  _negativeKey(endpoint, payload) {
    let body = '';
    try {
      body = JSON.stringify(payload || {});
    } catch (e) {
      body = '';
    }
    return `${endpoint}:${body}`;
  }

  _rememberFailure(key) {
    const c = this.circuit;
    c.failures += 1;
    if (c.failures >= c.threshold) {
      c.openUntil = this.now() + c.cooldown;
      c.cooldown = Math.min(c.cooldown * 2, c.maxCooldown);
      c.opened += 1;
      this._log(`circuit open for ${c.cooldown}ms after ${c.failures} failures`);
    }
    if (this.negativeTtl > 0) {
      if (this._negatives.size >= this.negativeMax) this._sweepNegatives();
      this._negatives.set(key, this.now() + this.negativeTtl);
    }
  }

  _sweepNegatives() {
    const now = this.now();
    for (const [k, expiry] of this._negatives) {
      if (expiry <= now) this._negatives.delete(k);
    }
    if (this._negatives.size >= this.negativeMax) this._negatives.clear();
  }

  _log(msg, extra) {
    if (this.logger) this.logger('[yt-meta] ' + msg, extra);
  }

  /**
   * youtubei へ POST する。
   * まず主クライアントへ即発行し、hedgeMs 以内に決着しなければ予備クライアントも
   * 並走させる（速い方を採用、負けは中断）。
   */
  async callApi(endpoint, payload, { client = 'WEB', hedge = this.hedgeMs } = {}) {
    // (1) ブロッキング検知時は外向き通信自体を止める（無駄な往復をゼロにする）
    const nkey = this._negativeKey(endpoint, payload);
    if (this.isBlocked) {
      this.stats.shortCircuited += 1;
      throw new Error(`${endpoint} circuit-open (skip outbound)`);
    }
    const negativeUntil = this._negatives.get(nkey);
    if (negativeUntil && negativeUntil > this.now()) {
      this.stats.shortCircuited += 1;
      throw new Error(`${endpoint} negative-cached (skip outbound)`);
    }

    // (2) 一度でも失敗していたら予備クライアントを並走させない（往復を1/3に）
    const effectiveHedge = this.circuit.failures > 0 ? 0 : hedge;

    const chain = [CLIENTS[client] ? client : 'WEB'];
    if (effectiveHedge > 0) chain.push('ANDROID', 'IOS');

    this.stats.calls += 1;
    this.stats.byEndpoint[endpoint] = (this.stats.byEndpoint[endpoint] || 0) + 1;

    return new Promise((resolve, reject) => {
      const controllers = [];
      let settled = false;
      const errors = [];

      const startAt = (name, delay) => {
        const timer = delay > 0 ? setTimeout(() => run(name), delay) : null;
        if (timer) controllers.push({ timer });
        else run(name);
      };

      const run = async (name) => {
        const cfg = CLIENTS[name];
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), this.timeout) : null;
        if (controller) controllers.push({ controller, timer });
        try {
          const body = JSON.stringify({
            ...payload,
            context: {
              ...(payload.context || {}),
              client: {
                hl: this.hl,
                gl: this.gl,
                clientName: cfg.clientName,
                clientVersion: cfg.clientVersion,
                ...(cfg.androidSdkVersion ? { androidSdkVersion: cfg.androidSdkVersion } : {}),
                ...(cfg.osName ? { osName: cfg.osName, osVersion: cfg.osVersion } : {}),
                ...(cfg.deviceMake ? { deviceMake: cfg.deviceMake, deviceModel: cfg.deviceModel } : {}),
                ...((payload.context || {}).client || {}),
              },
            },
          });

          const res = await this.fetchImpl(`${this.host}${API_PATH}/${endpoint}?key=${cfg.key}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'User-Agent': cfg.ua,
              'Accept-Language': `${this.hl},en;q=0.9`,
              'X-YouTube-Client-Name': cfg.clientNameHeader,
              'X-YouTube-Client-Version': cfg.clientVersion,
              Origin: this.host,
              Referer: `${this.host}/`,
              ...(this.visitorId ? { 'X-Goog-Visitor-Id': this.visitorId } : {}),
            },
            body,
            ...(controller ? { signal: controller.signal } : {}),
          });

          if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : 'no response'}`);
          const json = await res.json();
          if (!json || typeof json !== 'object') throw new Error('bad json');

          // どの応答からでも visitorData を拾って次回以降に使う（追加往復ゼロ）
          const vd = json.responseContext && json.responseContext.visitorData;
          if (vd && !this.visitorId) this._setVisitor(decodeURIComponent(vd));

          if (settled) return;
          settled = true;
          this._cleanup(controllers);
          // 成功したら遮断状態をリセットして、次は普通に（ヘッジ有りで）叩けるようにする
          this.circuit.failures = 0;
          this.circuit.cooldown = this.circuit.baseCooldown;
          this._negatives.delete(nkey);
          resolve(json);
        } catch (err) {
          if (settled) return;
          errors.push(`${name}: ${err && err.message}`);
          if (errors.length >= chain.length) {
            settled = true;
            this._cleanup(controllers);
            this.stats.errors += 1;
            this._rememberFailure(nkey);
            reject(new Error(`${endpoint} failed (${errors.join(' | ')})`));
          }
        }
      };

      chain.forEach((name, i) => {
        if (i > 0) this.stats.hedges += 1;
        startAt(name, i === 0 ? 0 : effectiveHedge);
      });
    });
  }

  _cleanup(list) {
    for (const item of list) {
      if (!item) continue;
      if (item.timer) clearTimeout(item.timer);
      if (item.controller && !item.controller.signal.aborted) {
        try {
          item.controller.abort();
        } catch (e) { /* noop */ }
      }
    }
  }

  _setVisitor(value) {
    if (!value) return;
    this.visitorId = value;
    this.visitorCache.set('vd', value);
    this._visitorSetAt = this.now();
  }

  /** visitorData を裏で1本だけ取りに行く（呼び出し側は待たない） */
  refreshVisitor() {
    if (this._visitorJob) return this._visitorJob;
    // ブロックされているのに visitorData を取りに行かない（無駄な外向き通信を増やさない）
    if (this.isBlocked) return Promise.resolve();
    this._visitorTryAt = this.now();
    this._visitorJob = (async () => {
      try {
        const res = await this.callApi('search', { query: 'youtube' }, { hedge: 0 });
        const vd = res && res.responseContext && res.responseContext.visitorData;
        if (vd) this._setVisitor(decodeURIComponent(vd));
      } catch (e) {
        /* visitor が無くても大半のエンドポイントは動く */
      } finally {
        this._visitorJob = null;
      }
    })();
    return this._visitorJob;
  }

  /** あれば使う、無ければ裏で取りに行く（初回リクエストを1往復も待たせない） */
  visitorIdFast() {
    const cached = this.visitorCache.get('vd');
    if (cached) {
      this.visitorId = cached;
      // 期限が近づいたら裏で先に取り直す（放置後の復帰で冷たい往復を踏まない）
      if (this.now() - this._visitorSetAt > 16 * 60 * 1000 && !this._visitorJob
        && this.now() - this._visitorTryAt > 2 * 60 * 1000) {
        this.refreshVisitor().catch(() => {});
      }
      return cached;
    }
    this.refreshVisitor().catch(() => {});
    return undefined;
  }

  /* -------------------------------------------------------------- 動画メタ */

  /** next エンドポイント1往復で メタ + 関連動画 + コメントトークン を取る */
  async videoMeta(videoId) {
    if (!isVideoId(videoId)) throw new Error('invalid videoId');
    const key = `meta:${videoId}`;
    const hit = this.cache.get(key);
    if (hit) {
      this.stats.cacheHits += 1;
      return hit;
    }
    return this.cache.wrap(key, this.ttl, async () => {
      const res = await this.callApi('next', {
        videoId,
        contentCheckOk: true,
        racyCheckOk: true,
      });

      const watch = (res.contents && res.contents.twoColumnWatchNextResults) || {};
      const results = (watch.results && watch.results.results && watch.results.results.contents) || [];
      const primary = parsePrimaryInfo(results);

      // コメント欄の継続トークン
      let commentsToken = null;
      let commentsCountText = '';
      const panels = res.engagementPanels || [];
      for (const p of panels) {
        const r = p && p.engagementPanelSectionListRenderer;
        if (r && r.panelIdentifier === 'engagement-panel-comments-section') {
          commentsToken = (deepFind(r, 'continuationCommand', 4) || [])
            .map((x) => normalizeContinuation(x && x.token))
            .find(isPlausibleContinuation) || null;
        }
      }
      const header = deepFind(res, 'commentsEntryPointHeaderRenderer', 1)?.[0];
      if (header) commentsCountText = textOf(header.commentCount) || textOf(header.commentsCount);

      const secondary = (watch.secondaryResults && watch.secondaryResults.secondaryResults
        && watch.secondaryResults.secondaryResults.results) || [];
      const { items: relatedRaw } = extractItems(secondary);

      const isLive = !!(deepFind(results, 'videoPrimaryInfoRenderer', 1)?.[0] || {}).viewCount
        && /人が視聴中|視聴中/.test(textOf(((deepFind(results, 'videoPrimaryInfoRenderer', 1)?.[0]) || {}).viewCount));

      const meta = {
        videoId,
        title: primary.title,
        viewCount: countOf(primary.viewCountText),
        viewCountText: primary.viewCountText,
        dateText: primary.dateText,
        likeCount: countOf(primary.likeText),
        likeCountText: primary.likeText,
        description: primary.description,
        channelId: primary.channelId,
        channelName: primary.channelName,
        channelSubs: primary.channelSubs,
        channelImage: primary.channelAvatar,
        commentsToken,
        commentCount: countOf(commentsCountText),
        commentCountText: commentsCountText,
        related: relatedRaw.map(toCard).filter(Boolean),
        isLive,
      };
      this._log(`meta ${videoId}`, { title: meta.title, related: meta.related.length });
      return meta;
    });
  }

  /**
   * コメント。watch 応答のトークンが渡れば1往復で済む。
   * 取れないときは next{videoId} → next{continuation} の2往復にフォールバック。
   */
  async comments(videoId, tokenIn) {
    if (!isVideoId(videoId)) throw new Error('invalid videoId');
    const key = `cm:${videoId}`;
    const hit = this.cache.get(key);
    if (hit && !tokenIn) {
      this.stats.cacheHits += 1;
      return hit;
    }
    return this.cache.wrap(key, this.commentTtl, async () => {
      let token = (() => {
        const norm = normalizeContinuation(tokenIn);
        return isPlausibleContinuation(norm) ? norm : null;
      })();
      let countText = '';

      if (!token) {
        const meta = await this.videoMeta(videoId);
        token = meta.commentsToken || null;
        countText = meta.commentCountText || '';
      }
      if (!token) {
        return { commentCount: 0, comments: [], continuation: null, disabled: true };
      }

      const page = await this.callApi('next', { continuation: token });
      const parsed = parseCommentPage(page);
      // 同じトークンを指し続けたら「次無し」扱い（無限ループを構造的に防ぐ）
      if (parsed.continuation && parsed.continuation === token) parsed.continuation = null;

      return {
        commentCount: countOf(parsed.countText || countText),
        commentCountText: parsed.countText || countText,
        comments: parsed.comments,
        continuation: parsed.continuation,
        disabled: false,
      };
    });
  }

  /** コメントの続き。壊れたトークンは送らず静かに終端扱いする */
  async commentsNext(continuation) {
    const token = normalizeContinuation(continuation);
    if (!isPlausibleContinuation(token)) {
      return { comments: [], continuation: null, ended: true };
    }
    const key = `cx:${token}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    return this.cache.wrap(key, this.commentTtl, async () => {
      try {
        const page = await this.callApi('next', { continuation: token });
        const parsed = parseCommentPage(page);
        if (parsed.continuation && parsed.continuation === token) parsed.continuation = null;
        return { comments: parsed.comments, continuation: parsed.continuation, ended: !parsed.continuation };
      } catch (err) {
        // 400/404 = トークン失効。UI を赤くするより静かに終端にする
        if (/HTTP (400|404)/.test(String(err && err.message))) {
          this.cache.delete(key);
          return { comments: [], continuation: null, ended: true };
        }
        throw err;
      }
    });
  }

  /* ------------------------------------------------------------ 検索系 */

  async search(query, { page = 0, sp } = {}) {
    const q = String(query || '').trim();
    if (!q) return { items: [], continuation: null };
    const key = `s:${q}:${sp || ''}:${page}`;
    const hit = this.cache.get(key);
    if (hit) {
      this.stats.cacheHits += 1;
      return hit;
    }
    return this.cache.wrap(key, this.searchTtl, async () => {
      const raw = page === 0
        ? await this.callApi('search', sp ? { query: q, params: sp } : { query: q })
        : await this._searchPage(q, sp, page);
      const root = (raw.contents && raw.contents.twoColumnSearchResultsRenderer
        && raw.contents.twoColumnSearchResultsRenderer.primaryContents
        && raw.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer
        && raw.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents)
        || raw;
      const { items, continuation } = extractItems(root);
      const cards = items.map(toCard).filter(Boolean);
      if (continuation) this._setChain(`s:${q}:${sp || ''}`, page, continuation);
      this._log('search', { q, page, items: cards.length });
      return { items: cards, continuation: continuation || null };
    });
  }

  /** page N を辿るための継続トークンを覚えておく（page → token） */
  _setChain(base, page, token) {
    this.cache.set(`${base}:tok:${page + 1}`, token, this.searchTtl);
  }

  async _searchPage(q, sp, page) {
    const base = `s:${q}:${sp || ''}`;
    let token = this.cache.get(`${base}:tok:${page}`);
    if (!token) {
      // 途中が抜けていたら先頭から辿り直す（最大5ページ）
      for (let p = 0; p < Math.min(page, 2); p++) {
        const page0 = await this.search(q, { page: p, sp });
        token = this.cache.get(`${base}:tok:${p + 1}`);
        if (!token) break;
        if (p + 1 === page) return await this.callApi('search', { continuation: token });
        if (!page0) break;
      }
      if (!token) throw new Error('continuation not available');
    }
    return this.callApi('search', { continuation: token });
  }

  /** トレンド（ホーム相当） */
  async trending({ page = 0 } = {}) {
    const key = `tr:${page}`;
    const hit = this.cache.get(key);
    if (hit) {
      this.stats.cacheHits += 1;
      return hit;
    }
    return this.cache.wrap(key, this.searchTtl, async () => {
      const payload = page === 0
        ? { browseId: 'FEwhat_to_watch' }
        : { continuation: await this._trendingToken(page) };
      const res = await this.callApi('browse', payload);

      const tabs = (res.contents && res.contents.twoColumnBrowseResultsRenderer
        && res.contents.twoColumnBrowseResultsRenderer.tabs) || [];
      const selected = tabs.map((t) => t.tabRenderer || t.expandableTabRenderer).find((t) => t && t.selected);
      const { items, continuation } = extractItems((selected && selected.content) || res);
      const cards = items.map(toCard).filter(Boolean);
      if (continuation) this._setChain('tr', page, continuation);
      this._log('trending', { page, items: cards.length });
      return { items: cards, continuation: continuation || null };
    });
  }

  async _trendingToken(page) {
    const token = this.cache.get(`tr:tok:${page}`);
    if (token) return token;
    // 先頭から順に辿り直す
    for (let p = 0; p < Math.min(page, 2); p++) {
      await this.trending({ page: p });
      const next = this.cache.get(`tr:tok:${p + 1}`);
      if (!next) break;
      if (p + 1 === page) return next;
    }
    throw new Error('trending continuation not available');
  }

  /** チャンネル（@ハンドル / UC… どちらでも） */
  async channel(idOrHandle) {
    const requested = String(idOrHandle || '').trim();
    if (!requested) throw new Error('channel required');
    const key = `ch:${requested.toLowerCase()}`;
    const hit = this.cache.get(key);
    if (hit) {
      this.stats.cacheHits += 1;
      return hit;
    }
    return this.cache.wrap(key, this.ttl, async () => {
      const browseId = /^UC[\w-]{20,}$/.test(requested) ? requested : await this.resolveChannelId(requested);
      const res = await this.callApi('browse', { browseId });

      const header = deepFind(res, 'pageHeaderViewModel', 1)?.[0]
        || deepFind(res, 'c4TabbedHeaderRenderer', 1)?.[0]
        || {};
      const metadataRows = deepFind(header, 'metadataRows', 1)?.[0] || [];
      const flat = [];
      for (const row of metadataRows) {
        for (const part of row.metadataParts || []) {
          const t = textOf(part.text);
          if (t) flat.push(t);
        }
      }

      const tabs = (res.contents && res.contents.twoColumnBrowseResultsRenderer
        && res.contents.twoColumnBrowseResultsRenderer.tabs) || [];
      const selected = tabs.map((t) => t.tabRenderer || t.expandableTabRenderer).find((t) => t && t.selected);
      const { items, continuation } = extractItems((selected && selected.content) || res);

      const out = {
        id: browseId,
        channelName: textOf(header.title) || textOf(header.pageTitle) || requested,
        handle: flat.find((t) => t.startsWith('@')) || '',
        subscriberText: flat.find((t) => /登録者/.test(t)) || textOf(header.subscriberCountText),
        videoCountText: flat.find((t) => /本の動画|動画/.test(t) && !/登録者/.test(t)) || textOf(header.videosCountText),
        description: textOf(deepFind(header, 'description', 1)?.[0]),
        channelImage: bestThumb(deepFind(header, 'sources', 1)?.[0])
          || bestThumb(header.avatar && header.avatar.thumbnails),
        banner: bestThumb(deepFind(deepFind(header, 'imageBannerViewModel', 1)?.[0] || {}, 'sources', 1)?.[0])
          || bestThumb(header.banner && header.banner.thumbnails),
        items: items.map(toCard).filter(Boolean),
        continuation: continuation || null,
      };
      this._log('channel', { id: browseId, items: out.items.length });
      return out;
    });
  }

  /** @ハンドル → UC… の解決（チャンネルページの HTML から1発で抜く） */
  async resolveChannelId(handleOrUrl) {
    let handle = String(handleOrUrl || '').trim();
    if (handle.startsWith('@')) handle = handle.slice(1);
    const key = `rh:${handle.toLowerCase()}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    try {
      const res = await this.fetchImpl(`${this.host}/@${encodeURIComponent(handle)}`, {
        headers: { 'User-Agent': CLIENTS.WEB.ua, 'Accept-Language': `${this.hl},en;q=0.9` },
      });
      if (res && res.ok) {
        const html = await res.text();
        const esc = handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const m = html.match(new RegExp(`"browseId":"(UC[\\w-]+)","canonicalBaseUrl":"/@${esc}"`, 'i'))
          || html.match(/"externalId":"(UC[\w-]+)"/)
          || html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]+)"/)
          || html.match(/"ownerUrls":\[[^\]]*"https?:\/\/www\.youtube\.com\/channel\/(UC[\w-]+)"/);
        if (m) {
          this.cache.set(key, m[1], 6 * 60 * 60 * 1000);
          return m[1];
        }
      }
    } catch (e) { /* 下の検索フォールバックへ */ }

    const res = await this.search('@' + handle);
    const ch = res.items.find((i) => (i.channelTitle || '').toLowerCase() === handle.toLowerCase());
    throw new Error(ch ? 'channel id not resolvable' : 'channel not found');
  }

  /* ------------------------------------------------------------------ 雑務 */

  /** 起動時に裏で温める（最初の1回を速くする） */
  warmup() {
    if (this.isBlocked) return Promise.resolve();
    this.refreshVisitor().catch(() => {});
    this.trending({ page: 0 }).catch(() => {});
    return Promise.resolve();
  }

  sweep() {
    this.cache.sweep();
    this.visitorCache.sweep();
  }
}

module.exports = {
  YtMetadata,
  CLIENTS,
  // パース helper（テスト用）
  _internal: {
    deepFind, textOf, bestThumb, thumbOf, countOf, extractItems, toCard,
    parsePrimaryInfo, parseCommentPage, normalizeContinuation, isPlausibleContinuation, isVideoId,
  },
};
