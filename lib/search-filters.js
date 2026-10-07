'use strict';

/**
 * 検索の絞り込み（InnerTube の sp パラメータ）
 *
 * YouTube の検索は `params`（URLでは sp）に protobuf を渡すと絞り込める。
 * 形はこうなっている:
 *
 *   message {
 *     1: varint sort          // 1=評価 2=投稿日 3=再生数（0/省略=関連度）
 *     2: message filter {     // ここがいわゆる「フィルタ」
 *       1: varint upload_date // 1=1時間以内 2=今日 3=今週 4=今月 5=今年
 *       2: varint type        // 1=動画 2=チャンネル 3=プレイリスト 4=映画
 *       3: varint duration    // 1=短い(4分未満) 2=長い(20分以上)
 *     }
 *   }
 *
 * 依存を増やさないため protobuf のエンコードも自前で書く（varint を並べるだけ）。
 */

const SORT = { relevance: 0, rating: 1, date: 2, views: 3 };
const UPLOAD_DATE = { lastHour: 1, today: 2, thisWeek: 3, thisMonth: 4, thisYear: 5 };
const TYPE = { video: 1, channel: 2, playlist: 3, movie: 4 };
const DURATION = { short: 1, long: 2 };

/** フロントに出す一覧（日本語ラベル付き）。サーバ側の検証にも使う。 */
const CHOICES = {
  sort: [
    { value: 'relevance', label: '関連度' },
    { value: 'date', label: '投稿日' },
    { value: 'views', label: '再生数' },
    { value: 'rating', label: '評価' },
  ],
  uploadDate: [
    { value: '', label: '期間指定なし' },
    { value: 'lastHour', label: '1時間以内' },
    { value: 'today', label: '今日' },
    { value: 'thisWeek', label: '今週' },
    { value: 'thisMonth', label: '今月' },
    { value: 'thisYear', label: '今年' },
  ],
  type: [
    { value: '', label: 'すべて' },
    { value: 'video', label: '動画' },
    { value: 'channel', label: 'チャンネル' },
    { value: 'playlist', label: 'プレイリスト' },
  ],
  duration: [
    { value: '', label: '長さ指定なし' },
    { value: 'short', label: '4分未満' },
    { value: 'long', label: '20分以上' },
  ],
};

function varint(value) {
  let n = Math.max(0, Math.floor(value) || 0);
  const out = [];
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n > 0) byte |= 0x80;
    out.push(byte);
  } while (n > 0);
  return Buffer.from(out);
}

/** フィールド番号とワイヤタイプ(0=varint, 2=length-delimited)のタグ */
function tag(field, wireType) {
  return varint((field << 3) | wireType);
}

function varintField(field, value) {
  return Buffer.concat([tag(field, 0), varint(value)]);
}

function messageField(field, body) {
  return Buffer.concat([tag(field, 2), varint(body.length), body]);
}

/** 数値の値だけ取り出す（不正な値は 0 = 指定なし） */
function pick(map, name) {
  const v = map[String(name || '').trim()];
  return typeof v === 'number' ? v : 0;
}

/**
 * 絞り込み条件を sp にする。何も指定がなければ ''（＝通常の検索）。
 * 未知の値は無視するので、フロントから変な値が来ても壊れない。
 */
function buildSearchParams(opts = {}) {
  const sort = pick(SORT, opts.sort);
  const uploadDate = pick(UPLOAD_DATE, opts.uploadDate);
  const type = pick(TYPE, opts.type);
  const duration = pick(DURATION, opts.duration);

  const parts = [];
  if (uploadDate) parts.push(varintField(1, uploadDate));
  if (type) parts.push(varintField(2, type));
  if (duration) parts.push(varintField(3, duration));

  const out = [];
  if (sort) out.push(varintField(1, sort));
  if (parts.length) out.push(messageField(2, Buffer.concat(parts)));

  return out.length ? Buffer.concat(out).toString('base64') : '';
}

/** sp → 条件（テストとデバッグ用） */
function parseSearchParams(sp) {
  const buf = Buffer.from(String(sp || ''), 'base64');
  const result = { sort: 'relevance', uploadDate: '', type: '', duration: '' };
  const nameOf = (map, n) => Object.keys(map).find((k) => map[k] === n) || '';

  let i = 0;
  const readVarint = () => {
    let shift = 0;
    let value = 0;
    for (;;) {
      const byte = buf[i++];
      if (byte === undefined) throw new Error('truncated');
      value |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
      if (shift > 63) throw new Error('varint too long');
    }
    return value;
  };

  try {
    while (i < buf.length) {
      const key = readVarint();
      const field = key >>> 3;
      const wire = key & 0x07;
      if (wire === 0) {
        const value = readVarint();
        if (field === 1) result.sort = nameOf(SORT, value) || result.sort;
      } else if (wire === 2) {
        const len = readVarint();
        const body = buf.slice(i, i + len);
        i += len;
        if (field !== 2) continue;
        let j = 0;
        while (j < body.length) {
          const k2 = body[j++];
          const f2 = k2 >>> 3;
          if ((k2 & 0x07) !== 0) break;
          let shift = 0;
          let value = 0;
          for (;;) {
            const byte = body[j++];
            if (byte === undefined) break;
            value |= (byte & 0x7f) << shift;
            if ((byte & 0x80) === 0) break;
            shift += 7;
          }
          if (f2 === 1) result.uploadDate = nameOf(UPLOAD_DATE, value);
          else if (f2 === 2) result.type = nameOf(TYPE, value);
          else if (f2 === 3) result.duration = nameOf(DURATION, value);
        }
      } else {
        break; // 想定外のワイヤタイプ
      }
    }
  } catch (e) {
    return { sort: 'relevance', uploadDate: '', type: '', duration: '', broken: true };
  }
  return result;
}

/** リクエストのクエリから絞り込み条件だけ取り出す（未入力は ''） */
function filtersFromQuery(query = {}) {
  const one = (v) => String(v == null ? '' : v).trim();
  return {
    sort: one(query.sort) || 'relevance',
    uploadDate: one(query.date),
    type: one(query.type),
    duration: one(query.duration),
  };
}

module.exports = {
  buildSearchParams,
  parseSearchParams,
  filtersFromQuery,
  SORT,
  UPLOAD_DATE,
  TYPE,
  DURATION,
  CHOICES,
};
