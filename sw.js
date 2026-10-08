const CACHE_NAME = "rios-visor-v5";
const ASSETS = [
  "./index.html",
  "./icon.svg",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
  "https://unpkg.com/@turf/turf@7/turf.min.js"
];

// Servicios de datos y mapas: siempre a red, nunca desde cache.
const LIVE_HOSTS = [
  "miteco.gob.es",
  "mapama.gob.es",
  "idee.es",
  "ign.es",
  "workers.dev",
  "tile.openstreetmap.org"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (LIVE_HOSTS.some((h) => url.hostname.endsWith(h))) {
    e.respondWith(fetch(req));
    return;
  }

  // HTML: red primero (para que los cambios publicados lleguen siempre),
  // con la copia en cache solo como respaldo sin conexion.
  if (req.mode === "navigate" || url.pathname.endsWith(".html")) {
    e.respondWith(
      fetch(req)
        .then((resp) => {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy));
          return resp;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match("./index.html")))
    );
    return;
  }

  // Librerias e iconos: cache primero.
  e.respondWith(caches.match(req).then((cached) => cached || fetch(req)));
});
