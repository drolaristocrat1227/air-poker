/* =============================================================
   エア・ポーカー ─ Service Worker
   ・初回訪問で一式をキャッシュし、以降は圏外でも遊べる
   ・本体は network-first。新しい版が置かれたら次の起動で拾う
   ・その他は cache-first。フォントは取れたぶんだけ貯める
   版番号は build.js が埋め込む
   ============================================================= */
'use strict';

var VERSION = '1.9.0';
var CACHE   = 'air-poker-' + VERSION;
var CORE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      /* 1つでも失敗すると全部落ちるので個別に入れる */
      return Promise.all(CORE.map(function (u) {
        return c.add(new Request(u, { cache: 'reload' }))['catch'](function () {});
      }));
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE && k.indexOf('air-poker-') === 0) return caches['delete'](k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

/* 「今すぐ更新」から呼ばれる。待機中の新しい worker を即座に有効化する */
self.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function fromNetwork(req) {
  return fetch(req).then(function (res) {
    if (res && (res.ok || res.type === 'opaque')) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(req, copy); })['catch'](function () {});
    }
    return res;
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  /* 本体（ページ遷移）は新しい版を優先。取れなければキャッシュ。 */
  if (req.mode === 'navigate') {
    e.respondWith(
      fromNetwork(req)['catch'](function () {
        return caches.match('./index.html').then(function (r) {
          return r || caches.match('./');
        });
      })
    );
    return;
  }

  /* それ以外は手元にあるものを先に返し、無ければ取りに行く */
  e.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fromNetwork(req)['catch'](function () {
        return hit || Response.error();
      });
    })
  );
});
