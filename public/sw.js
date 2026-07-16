// sw.js — DESIGN.md 3.7
// 路徑一律相對 self.location 解析，支援 GitHub Pages 子路徑部署。

const CACHE_NAME = "chan7-20260716T1250000500";
const BASE = new URL(".", self.location).pathname; // 例如 "/chan7-app/"

const PRECACHE_URLS = [
  BASE,
  BASE + "index.html",
  BASE + "manifest.webmanifest",
  BASE + "assets/css/app.css",
  BASE + "assets/js/app.js",
  BASE + "assets/js/resolve.js",
  BASE + "assets/js/pin-gate.js",
  BASE + "assets/js/firebase-config.js",
  BASE + "assets/js/firestore-sync.js",
  BASE + "assets/vendor/alpine.min.js",
  BASE + "assets/icon-180.png",
  BASE + "assets/icon-192.png",
  BASE + "assets/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        Promise.all(
          PRECACHE_URLS.map((url) =>
            cache.add(url).catch((err) => {
              // 個別資源（例如尚未由另一 worker 建立的 firestore-sync.js）precache 失敗不應中止整個 SW 安裝
              console.warn("[sw] precache 失敗，略過：", url, err);
            })
          )
        )
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isScheduleData(url) {
  return url.pathname === BASE + "data/schedule.json";
}

function isRetreatIcs(url) {
  return url.pathname === BASE + "retreat.ics";
}

function isGstaticFirebase(url) {
  return url.hostname === "www.gstatic.com" && url.pathname.startsWith("/firebasejs/");
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) {
      cache.put(request, fresh.clone());
    }
    return fresh;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirstImmutable(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const fresh = await fetch(request);
  if (fresh && fresh.ok) {
    cache.put(request, fresh.clone());
  }
  return fresh;
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then((fresh) => {
      if (fresh && fresh.ok) {
        cache.put(request, fresh.clone());
      }
      return fresh;
    })
    .catch(() => undefined);

  return cached || (await networkPromise) || Response.error();
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // retreat.ics 不快取
  if (isRetreatIcs(url)) {
    event.respondWith(fetch(req));
    return;
  }

  // data/schedule.json → network-first + cache fallback
  if (isScheduleData(url)) {
    event.respondWith(networkFirst(req));
    return;
  }

  // gstatic firebasejs（版本化 URL，可視為 immutable）→ cache-first
  if (isGstaticFirebase(url)) {
    event.respondWith(cacheFirstImmutable(req));
    return;
  }

  // 同源其他資源 → cache-first + 背景更新（stale-while-revalidate）
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  // 其他跨源請求：不介入，交回瀏覽器預設行為
});
