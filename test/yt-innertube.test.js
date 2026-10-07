'use strict';

/**
 * lib/yt-innertube.js のテスト
 *
 * サンドボックスからは YouTube へ到達できない（curl exit 35）ため、
 * fetch 実装を差し替えて InnerTube の応答形を再現して検証する。
 */
const test = require('node:test');
const assert = require('node:assert');
const { YtMetadata, _internal } = require('../lib/yt-innertube');
const { deepFind, textOf, extractItems, normalizeContinuation, isPlausibleContinuation } = _internal;

/* ------------------------------------------------------------------ 便利 */

function jsonRes(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const DELAY = (ms) => new Promise((r) => setTimeout(r, ms));

/** 呼び出しを記録しつつ、エンドポイントごとに応答を返すモック fetch */
function makeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const endpoint = u.pathname.split('/').pop();
    const clientName = (init && init.headers && init.headers['X-YouTube-Client-Name']) || '';
    const body = init && init.body ? JSON.parse(init.body) : {};
    const record = { url, endpoint, clientName, body, at: Date.now() };
    calls.push(record);
    const out = await handler(record);
    if (out === undefined) throw new Error(`no handler for ${endpoint}`);
    return out;
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

/* ------------------------------------------------------------- フィクスチャ */

const videoRenderer = (id, title, extra = {}) => ({
  videoRenderer: Object.assign({
    videoId: id,
    title: { runs: [{ text: title }], simpleText: title },
    ownerText: { runs: [{ text: 'Ch ' + id }] },
    viewCountText: { simpleText: '1,234 回視聴' },
    publishedTimeText: { simpleText: '3 日前' },
    lengthText: { simpleText: '10:31' },
    thumbnail: { thumbnails: [{ url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` }] },
  }, extra),
});

const gridVideoRenderer = (id, title) => ({ gridVideoRenderer: videoRenderer(id, title).videoRenderer });

const reelItem = (id, title) => ({
  reelItemRenderer: {
    videoId: id,
    headline: { simpleText: title },
    viewCountText: { simpleText: '12万回視聴' },
    thumbnail: { thumbnails: [{ url: `https://i.ytimg.com/vi/${id}/o.jpg` }] },
  },
});

const lockup = (id, title, rows) => ({
  lockupViewModel: {
    contentId: id,
    contentType: 'VIDEO',
    metadata: {
      lockupMetadataViewModel: {
        title: { content: title },
        metadata: {
          contentMetadataViewModel: {
            metadataRows: rows.map((parts) => ({
              metadataParts: parts.map((t) => ({ text: { content: t } })),
            })),
          },
        },
      },
    },
    contentImage: {
      thumbnailViewModel: { image: { sources: [{ url: `https://i.ytimg.com/vi/${id}/l.jpg` }] } },
    },
  },
});

const adSlot = { adSlotRenderer: { adVideoId: 'nope' } };

const searchResponse = (items, continuation) => ({
  contents: {
    twoColumnSearchResultsRenderer: {
      primaryContents: {
        sectionListRenderer: {
          contents: [
            { itemSectionRenderer: { contents: items } },
            continuation
              ? {
                continuationItemRenderer: {
                  continuationEndpoint: { continuationCommand: { token: continuation } },
                },
              }
              : null,
          ].filter(Boolean),
        },
      },
    },
  },
});

/** "tokenN" を base64 風にして長さ 32 以上にする */
const TOKEN = (n) => ('C' + String(n) + '_' + 'A'.repeat(40) + '==');
const TOKEN2 = TOKEN(2);
const TOKEN2_ENC = encodeURIComponent(TOKEN2);
const TOKEN2_DOUBLE = encodeURIComponent(TOKEN2_ENC);

const nextResponse = ({ videoId = 'aaaaaaaaaaa', withComments = true } = {}) => ({
  responseContext: { visitorData: 'CgtVbV95b3V0dWJlIQ%3D%3D' },
  contents: {
    twoColumnWatchNextResults: {
      results: {
        results: {
          contents: [
            {
              videoPrimaryInfoRenderer: {
                title: { runs: [{ text: 'テスト動画 <script>x</script>' }] },
                viewCount: {
                  videoViewCountRenderer: { viewCount: { simpleText: '98,765 回視聴' } },
                },
                dateText: { simpleText: '2024/01/02' },
                videoActions: {
                  menuRenderer: {
                    topLevelButtons: [
                      {
                        toggleButtonRenderer: {
                          accessibility: { label: '1,111 人が高く評価しました' },
                        },
                      },
                    ],
                  },
                },
              },
            },
            {
              videoSecondaryInfoRenderer: {
                videoOwnerRenderer: {
                  title: { runs: [{ text: 'テストチャンネル' }] },
                  subscriberCountText: { simpleText: '12.3万人' },
                  thumbnail: { thumbnails: [{ url: 'https://yt3.ggpht.com/av.png' }] },
                },
                attributedDescription: { content: '説明文です & エスケープ確認' },
              },
            },
          ],
        },
      },
      secondaryResults: {
        secondaryResults: {
          results: [gridVideoRenderer('bbbbbbbbbbb', '関連1'), reelItem('ccccccccccc', 'short1')],
        },
      },
    },
  },
  engagementPanels: withComments
    ? [
      {
        engagementPanelSectionListRenderer: {
          panelIdentifier: 'engagement-panel-comments-section',
          content: {
            sectionListRenderer: {
              contents: [
                {
                  itemSectionRenderer: {
                    contents: [
                      {
                        continuationItemRenderer: {
                          continuationEndpoint: { continuationCommand: { token: TOKEN(1) } },
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
    ]
    : [],
});

function commentResponse({ comments = [], continuation = null, countText = null } = {}) {
  const items = [];
  if (countText) items.push({ commentsHeaderRenderer: { countText: { simpleText: countText } } });
  items.push(...comments.map((c) => ({ commentThreadRenderer: c })));
  if (continuation) {
    items.push({
      continuationItemRenderer: {
        continuationEndpoint: { continuationCommand: { token: continuation } },
      },
    });
  }
  return {
    onResponseReceivedEndpoints: [{ reloadContinuationItemsCommand: { continuationItems: items } }],
  };
}

const legacyComment = (author, text, likes = 5) => ({
  comment: {
    commentRenderer: {
      authorText: { simpleText: author },
      contentText: { runs: [{ text }] },
      publishedTimeText: { simpleText: '2 日前' },
      likeCount: String(likes),
      authorThumbnail: { thumbnails: [{ url: 'https://yt3.ggpht.com/u.png' }] },
    },
  },
});

/* -------------------------------------------------------------------- テスト */

test('extractItems: 新旧レンダラをまとめて拾い、広告は拾わない', () => {
  const root = [
    { itemSectionRenderer: { contents: [videoRenderer('aaaaaaaaaaa', 'legacy'), adSlot] } },
    gridVideoRenderer('bbbbbbbbbbb', 'grid'),
    reelItem('ccccccccccc', 'reel'),
    lockup('ddddddddddd', 'lockup', [['Ch D', '5,000 回視聴', '1 日前']]),
    {
      shortsLockupViewModel: {
        entityId: 'eeeeeeeeeee',
        overlayMetadata: { primaryText: { content: 'short lockup' } },
      },
    },
    { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: TOKEN2 } } } },
  ];
  const { items, continuation } = extractItems(root);
  const ids = items.map((i) => i.id);
  assert.deepStrictEqual(ids, [
    'aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc', 'ddddddddddd', 'eeeeeeeeeee',
  ]);
  assert.ok(!ids.includes('adVideoId'), 'adSlotRenderer の中身は拾わない');
  assert.strictEqual(continuation, normalizeContinuation(TOKEN2));
});

test('deepFind / textOf: 形が違っても値を取り出せる', () => {
  assert.strictEqual(deepFind({ a: { b: { c: 1 } } }, 'c', 1)[0], 1);
  assert.strictEqual(deepFind({ x: [{ y: [{ z: 2 }] }] }, 'z', 1)[0], 2);
  assert.strictEqual(deepFind({}, 'nope'), null);
  assert.strictEqual(textOf({ simpleText: 'a' }), 'a');
  assert.strictEqual(textOf({ runs: [{ text: 'x' }, { text: 'y' }] }), 'xy');
  assert.strictEqual(textOf(null), '');
});

test('継続トークン: 二重エンコードを剥がし、壊れたトークンは弾く', () => {
  assert.strictEqual(normalizeContinuation(TOKEN2_DOUBLE), TOKEN2);
  assert.strictEqual(normalizeContinuation(TOKEN2_ENC), TOKEN2);
  assert.ok(isPlausibleContinuation(TOKEN2));
  assert.ok(!isPlausibleContinuation('x'));
  assert.ok(!isPlausibleContinuation('AB CD!@#'));
  assert.strictEqual(normalizeContinuation(null), '');
});

test('videoMeta: 1往復で メタ＋関連＋コメントトークン、2回目はキャッシュ', async () => {
  const fetchImpl = makeFetch(async ({ endpoint }) => {
    if (endpoint === 'next') return jsonRes(nextResponse());
    throw new Error('unexpected ' + endpoint);
  });
  const yt = new YtMetadata({ fetchImpl, now: () => Date.now() });

  const meta = await yt.videoMeta('aaaaaaaaaaa');
  assert.strictEqual(fetchImpl.calls.length, 1, 'next は1往復');
  assert.strictEqual(meta.title, 'テスト動画 <script>x</script>');
  assert.strictEqual(meta.viewCount, 98765);
  assert.strictEqual(meta.likeCount, 1111);
  assert.strictEqual(meta.channelName, 'テストチャンネル');
  assert.strictEqual(meta.channelImage, 'https://yt3.ggpht.com/av.png');
  assert.strictEqual(meta.description, '説明文です & エスケープ確認');
  assert.strictEqual(meta.commentsToken, normalizeContinuation(TOKEN(1)));
  assert.strictEqual(meta.related.length, 2);
  assert.strictEqual(meta.related[0].title, '関連1');
  assert.strictEqual(meta.related[1].type, 'short');
  assert.strictEqual(meta.related[0].id, 'bbbbbbbbbbb');

  await yt.videoMeta('aaaaaaaaaaa');
  assert.strictEqual(fetchImpl.calls.length, 1, '2回目はキャッシュヒットで往復ゼロ');
  assert.strictEqual(yt.stats.cacheHits, 1);
});

test('videoMeta は visitorData を待たず、応答から回収する', async () => {
  const fetchImpl = makeFetch(async () => jsonRes(nextResponse()));
  const yt = new YtMetadata({ fetchImpl, hedgeMs: 0 });
  await yt.videoMeta('aaaaaaaaaaa');
  // search(visitor 取得) が先に走っていない
  assert.ok(!fetchImpl.calls.some((c) => c.body && c.body.query === 'youtube'),
    '初回リクエストを visitorData 取得でブロックしない');
  assert.ok(yt.visitorId, '応答の visitorData は回収して次回以降に使う');
});

test('comments: 壊れたトークンは送らず、400 は静かに終端扱い', async () => {
  const fetchImpl = makeFetch(async ({ body, clientName }) => {
    if (body && body.continuation === TOKEN2) return jsonRes({}, 400);
    if (body && body.continuation) return jsonRes(commentResponse({
      comments: [legacyComment('user1', 'こんにちは')],
      continuation: TOKEN2,
      countText: '100 件のコメント',
    }));
    return jsonRes(nextResponse());
  });
  const yt = new YtMetadata({ fetchImpl, hedgeMs: 0 });

  // 不正トークンを渡しても落ちない（next から取り直す）
  const page = await yt.comments('aaaaaaaaaaa', 'garbage!!');
  assert.strictEqual(page.comments.length, 1);
  assert.strictEqual(page.comments[0].content, 'こんにちは');
  assert.strictEqual(page.commentCount, 100);
  assert.ok(!fetchImpl.calls.some((c) => c.body && c.body.continuation === 'garbage!!'),
    'implausible なトークンは上流へ送らない');

  // 400 は例外にせず「終わり」
  const next2 = await yt.commentsNext(TOKEN2_DOUBLE);
  assert.deepStrictEqual(next2, { comments: [], continuation: null, ended: true });

  // 短いトークンは往復せずに終端
  const before = fetchImpl.calls.length;
  assert.deepStrictEqual(await yt.commentsNext('zz'), { comments: [], continuation: null, ended: true });
  assert.strictEqual(fetchImpl.calls.length, before, '壊れたトークンで無駄な往復をしない');
});

test('search: ページ0は1往復、継続トークンは正規化して保持', async () => {
  const fetchImpl = makeFetch(async ({ body }) => {
    if (body && body.continuation) {
      return jsonRes(searchResponse([gridVideoRenderer('fffffffffff', '2ページ目')], null));
    }
    return jsonRes(searchResponse([videoRenderer('aaaaaaaaaaa', '1ページ目')], TOKEN2_ENC));
  });
  const yt = new YtMetadata({ fetchImpl, hedgeMs: 0 });

  const p0 = await yt.search('テスト');
  assert.strictEqual(p0.items.length, 1);
  assert.strictEqual(p0.items[0].title, '1ページ目');

  const p1 = await yt.search('テスト', { page: 1 });
  assert.strictEqual(p1.items.length, 1);
  assert.strictEqual(p1.items[0].title, '2ページ目');
  const contCall = fetchImpl.calls.find((c) => c.body && c.body.continuation);
  assert.strictEqual(contCall.body.continuation, TOKEN2, 'エンコード済みトークンを剥がして送る');
});

test('trending: browse の選択タブからアイテムを取り出す', async () => {
  const fetchImpl = makeFetch(async ({ body }) => {
    assert.strictEqual(body.browseId, 'FEwhat_to_watch');
    return jsonRes({
      contents: {
        twoColumnBrowseResultsRenderer: {
          tabs: [
            {
              tabRenderer: {
                selected: true,
                content: {
                  richGridRenderer: {
                    contents: [gridVideoRenderer('aaaaaaaaaaa', 'トレンド1'), { adSlotRenderer: {} }],
                  },
                },
              },
            },
          ],
        },
      },
    });
  });
  const yt = new YtMetadata({ fetchImpl, hedgeMs: 0 });
  const res = await yt.trending();
  assert.strictEqual(res.items.length, 1);
  assert.strictEqual(res.items[0].title, 'トレンド1');
});

test('並列ヘッジ: 主クライアントが遅ければ予備クライアントで解決する', async () => {
  const fetchImpl = makeFetch(async ({ clientName }) => {
    if (clientName === '1') {
      // WEB は遅い
      await DELAY(200);
      return jsonRes(nextResponse());
    }
    return jsonRes(nextResponse());
  });
  const yt = new YtMetadata({ fetchImpl, hedgeMs: 20, timeout: 3000 });
  const t0 = Date.now();
  const meta = await yt.videoMeta('aaaaaaaaaaa');
  const ms = Date.now() - t0;
  assert.ok(ms < 150, `hedge が効いて早く解決する (実測 ${ms}ms)`);
  assert.strictEqual(meta.title, 'テスト動画 <script>x</script>');
  assert.ok(fetchImpl.calls.length >= 2, '予備クライアントも並走している');
  assert.strictEqual(yt.stats.hedges, 2);
});

test('全経路失敗なら reject する', async () => {
  const fetchImpl = makeFetch(async () => jsonRes({}, 500));
  const yt = new YtMetadata({ fetchImpl, hedgeMs: 0 });
  await assert.rejects(() => yt.videoMeta('aaaaaaaaaaa'), /next failed/);
  assert.strictEqual(yt.stats.errors, 1);
});

test('不正な videoId は往復せずに弾く', async () => {
  const fetchImpl = makeFetch(async () => jsonRes(nextResponse()));
  const yt = new YtMetadata({ fetchImpl });
  await assert.rejects(() => yt.videoMeta("'; DROP TABLE"), /invalid videoId/);
  assert.strictEqual(fetchImpl.calls.length, 0);
});
