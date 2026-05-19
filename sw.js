const TILE_CACHE = "esti-tiles-v1";
const TILE_HOSTS = ["tile.openstreetmap.org", "a.tile.openstreetmap.org", "b.tile.openstreetmap.org", "c.tile.openstreetmap.org"];

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (TILE_HOSTS.some((h) => url.hostname === h)) {
    event.respondWith(
      caches.open(TILE_CACHE).then((cache) =>
        cache.match(event.request).then((cached) => {
          if (cached) return cached;
          return fetch(event.request).then((response) => {
            if (response.ok) cache.put(event.request, response.clone());
            return response;
          });
        }),
      ),
    );
  }
});

// Prune tile cache to ~500 MB by evicting oldest entries.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.open(TILE_CACHE).then(async (cache) => {
      const keys = await cache.keys();
      if (keys.length > 8000) {
        await Promise.all(keys.slice(0, keys.length - 8000).map((k) => cache.delete(k)));
      }
    }),
  );
});
