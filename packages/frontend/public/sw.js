// Phase X — Minimal offline-friendly service worker for the StellaX PWA.
//
// Strategy:
//   • Pre-cache the app shell (index.html + main JS chunks via runtime cache).
//   • Network-first for /api/* and Soroban RPC calls (always fresh quotes).
//   • Cache-first for static assets (/images, /assets).
//
// This is intentionally tiny — no Workbox, no build step needed. Vite copies
// it verbatim from /public to the dist root, so it's served from the site
// origin and can claim the full scope.

/* eslint-env serviceworker */
/* global self, caches, fetch */

const CACHE = "stellax-v1";
const APP_SHELL = ["/", "/index.html", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(APP_SHELL)).catch(() => undefined),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Always-fresh paths.
  if (url.pathname.startsWith("/api/") || url.hostname.includes("soroban")) {
    return; // let the network handle it (default behaviour)
  }

  // Cache-first for static.
  if (url.pathname.startsWith("/images/") || url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(req).then((hit) =>
        hit ?? fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        }),
      ),
    );
    return;
  }

  // Stale-while-revalidate for everything else.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      }).catch(() => cached);
      return cached ?? network;
    }),
  );
});
