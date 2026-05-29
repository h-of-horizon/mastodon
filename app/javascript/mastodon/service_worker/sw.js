import { ExpirationPlugin } from 'workbox-expiration';
import { registerRoute } from 'workbox-routing';
import { CacheFirst, NetworkFirst } from 'workbox-strategies';

import { handleNotificationClick, handlePush } from './web_push_notifications';

// Cache version — 큰 변경 배포 시 bump 하여 이전 캐시 자동 폐기.
// 추가로 아래 root HTML NetworkFirst 룰이 매 페이지 로드 시 새 HTML fetch 시도하므로
// 자산 변경이 자동 반영됨 → CACHE_VERSION manual bump 필요성 ↓.
const CACHE_VERSION = 'v3';
const CACHE_NAME_PREFIX = `mastodon-${CACHE_VERSION}-`;

function openWebCache() {
  return caches.open(`${CACHE_NAME_PREFIX}web`);
}

function fetchRoot() {
  return fetch('/', { credentials: 'include', redirect: 'manual' });
}


registerRoute(
  /intl\/.*\.js$/,
  new CacheFirst({
    cacheName: `${CACHE_NAME_PREFIX}locales`,
    plugins: [
      new ExpirationPlugin({
        maxAgeSeconds: 30 * 24 * 60 * 60, // 1 month
        maxEntries: 5,
      }),
    ],
  }),
);

registerRoute(
  ({ request }) => request.destination === 'font',
  new CacheFirst({
    cacheName: `${CACHE_NAME_PREFIX}fonts`,
    plugins: [
      new ExpirationPlugin({
        maxAgeSeconds: 30 * 24 * 60 * 60, // 1 month
        maxEntries: 5,
      }),
    ],
  }),
);

registerRoute(
  ({ request }) => request.destination === 'image',
  new CacheFirst({
    cacheName: `m${CACHE_NAME_PREFIX}media`,
    plugins: [
      new ExpirationPlugin({
        maxAgeSeconds: 7 * 24 * 60 * 60, // 1 week
        maxEntries: 256,
      }),
    ],
  }),
);

// Root HTML (navigation 요청) — NetworkFirst 로 자동 갱신.
// 자산이 변경되었을 때 새 HTML (새 manifest 의 새 hashed filename 포함) 을 매번
// network 에서 fetch. network 실패 시에만 cache 사용 — 오프라인 fallback.
// 이로써 CACHE_VERSION manual bump 없이도 자산 변경이 자동으로 사용자에게 반영됨.
registerRoute(
  ({ request }) => request.mode === 'navigate',
  new NetworkFirst({
    cacheName: `${CACHE_NAME_PREFIX}html`,
    networkTimeoutSeconds: 3, // 3초 안에 네트워크 응답 없으면 cache fallback
    plugins: [
      new ExpirationPlugin({
        maxAgeSeconds: 24 * 60 * 60, // 1 day
        maxEntries: 5,
      }),
    ],
  }),
);

// Cause a new version of a registered Service Worker to replace an existing one
// that is already installed, and replace the currently active worker on open pages.
self.addEventListener('install', function(event) {
  // skipWaiting() — install 후 즉시 activate (waiting state 건너뛰기).
  // 사용자가 페이지 reload 시 새 SW 즉시 활성화되어 cache 갱신 빠름.
  self.skipWaiting();
  event.waitUntil(Promise.all([openWebCache(), fetchRoot()]).then(([cache, root]) => cache.put('/', root)));
});

self.addEventListener('activate', function(event) {
  // 이전 버전 cache 폐기 — CACHE_VERSION 이 다른 namespace 정리.
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches.keys().then(names =>
        Promise.all(
          names
            .filter(name => name.startsWith('mastodon-') && !name.startsWith(CACHE_NAME_PREFIX) && !name.startsWith(`m${CACHE_NAME_PREFIX}`))
            .map(name => caches.delete(name)),
        ),
      ),
    ]),
  );
});

self.addEventListener('fetch', function(event) {
  const url = new URL(event.request.url);

  if (url.pathname === '/auth/sign_out') {
    const asyncResponse = fetch(event.request);
    const asyncCache = openWebCache();

    event.respondWith(asyncResponse.then(response => {
      if (response.ok || response.type === 'opaqueredirect') {
        return Promise.all([
          asyncCache.then(cache => cache.delete('/')),
          indexedDB.deleteDatabase('mastodon'),
        ]).then(() => response);
      }

      return response;
    }));
  }
});

self.addEventListener('push', handlePush);
self.addEventListener('notificationclick', handleNotificationClick);
