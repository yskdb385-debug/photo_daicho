// 写真台帳自動作成ツール Service Worker
// アプリ本体(HTML/JS/JSON)は network-first で常に最新版を取得しつつ、
// 取得できた分をキャッシュしてオフライン時のフォールバックに使う。
// CDNの外部ライブラリ(Tesseract/ExcelJS/JSZip)はバージョン固定URLのため cache-first。

const APP_CACHE = 'photo-ledger-app-v1';
const LIB_CACHE = 'photo-ledger-libs-v1';

const APP_SHELL = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_CACHE).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== APP_CACHE && k !== LIB_CACHE)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

function isLibRequest(url) {
  return url.hostname === 'cdnjs.cloudflare.com';
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;

  // Claude API等、外部APIへのリクエストはSWを介さずそのまま通す
  if (url.hostname === 'api.anthropic.com') return;

  if (isLibRequest(url)) {
    // cache-first (バージョン固定なので安全)
    event.respondWith(
      caches.open(LIB_CACHE).then((cache) =>
        cache.match(event.request).then((cached) => {
          if (cached) return cached;
          return fetch(event.request).then((resp) => {
            if (resp && resp.status === 200) cache.put(event.request, resp.clone());
            return resp;
          }).catch(() => cached);
        })
      )
    );
    return;
  }

  // アプリ本体は network-first
  event.respondWith(
    fetch(event.request)
      .then((resp) => {
        if (resp && resp.status === 200) {
          const clone = resp.clone();
          caches.open(APP_CACHE).then((cache) => cache.put(event.request, clone));
        }
        return resp;
      })
      .catch(() => caches.match(event.request))
  );
});
