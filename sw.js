// MIN-Tube-Pro Service Worker
const CACHE_NAME = 'min-wlyt-plus-v3';
const PRECACHE = [
  '/youtube-pro',
  '/manifest.json',
  '/min-img.png',
  '/classroom.192',
  '/classroom.512',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys
        .filter(key => (key === 'min-wlyt-plus' || key.startsWith('min-wlyt-plus-')) && key !== CACHE_NAME)
        .map(key => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

const isNavigation = request =>
  request.mode === 'navigate' ||
  (request.headers.get('accept') || '').includes('text/html');

/**
 * 動画ページ・API・認証ページはキャッシュしてはいけない。
 * 以前は cache-first で保存していたため、
 *   ・失効したストリームURLの動画ページが開く
 *   ・認証(robots)ページが保存されてリロードループに陥る
 * といった「動画ページに遷移できない」不具合が起きていた。
 */
const isAlwaysFresh = url =>
  url.pathname.startsWith('/video/') ||
  url.pathname.startsWith('/api/') ||
  url.pathname === '/' ||
  url.pathname.startsWith('/short-check/') ||
  url.pathname.startsWith('/360/') ||
  url.pathname.startsWith('/sia-dl/') ||
  url.pathname.startsWith('/ai-fetch/') ||
  url.pathname.startsWith('/rapid/');

// サーバーが no-store を付けたレスポンス（動画ページ・API・認証画面）は保存しない
const isCacheable = response =>
  !!response &&
  response.status === 200 &&
  response.type === 'basic' &&
  !(response.headers.get('cache-control') || '').includes('no-store');

// ネットワークが先。キャッシュの読み書きは後回しにして、遷移のクリティカルパスを短くする。
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (isCacheable(response)) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request, { ignoreSearch: false });
    if (cached) return cached;
    throw error;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (isCacheable(response)) {
    await cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // ナビゲーション（HTML）と API は常にネットワーク優先。
  // オフラインのときだけ、同じ URL のキャッシュを返す。
  if (isNavigation(request) || isAlwaysFresh(url)) {
    event.respondWith((async () => {
      try {
        return await networkFirst(request);
      } catch (error) {
        // ハブ画面（/youtube-pro）は PWA の起点なので、その場合だけ precache へ逃がす。
        // 動画ページを勝手にハブへ差し替えると「別のページに飛ばされた」ように見えるためしない。
        if (isNavigation(request) && (url.pathname === '/' || url.pathname === '/youtube-pro')) {
          const cache = await caches.open(CACHE_NAME);
          const fallback = await cache.match('/youtube-pro');
          if (fallback) return fallback;
        }
        throw error;
      }
    })());
    return;
  }

  // 静的アセット（JS/CSS/画像/proxy フロントエンド）はこれまで通りキャッシュ優先
  event.respondWith(cacheFirst(request));
});
