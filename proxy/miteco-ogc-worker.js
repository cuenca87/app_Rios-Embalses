// Cloudflare Worker: proxy CORS de solo lectura para la OGC API Features de MITECO.
//
// Uso desde la app:
//   https://<worker>.workers.dev/collections/agua:rios_comp_pfaf/items?f=json&limit=1
//   -> https://gis.miteco.gob.es/geoserver/ogc/features/v1/collections/agua:rios_comp_pfaf/items?f=json&limit=1
//
// Solo reenvia peticiones GET a esa API (no es un proxy abierto) y solo
// acepta llamadas desde los origenes de ALLOWED_ORIGINS.

const UPSTREAM = "https://gis.miteco.gob.es/geoserver/ogc/features/v1/";

const ALLOWED_ORIGINS = [
  "https://cuenca87.github.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
];

// Los datos de referencia (rios, ARPSI, demarcaciones) cambian muy poco:
// cachear una hora en el borde de Cloudflare aligera mucho las busquedas.
const CACHE_SECONDS = 3600;

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const allowed = ALLOWED_ORIGINS.includes(origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: allowed ? 204 : 403, headers: allowed ? corsHeaders(origin) : {} });
    }
    if (request.method !== "GET") {
      return new Response("Metodo no permitido", { status: 405 });
    }
    if (origin && !allowed) {
      return new Response("Origen no permitido", { status: 403 });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/+/, "");
    if (!path.startsWith("collections")) {
      return new Response("Ruta no permitida", { status: 404 });
    }
    const target = UPSTREAM + path + url.search;

    // Cache en el borde (clave = URL de MITECO, independiente del origen)
    const cache = caches.default;
    const cacheKey = new Request(target, { method: "GET" });
    let upstream = await cache.match(cacheKey);

    if (!upstream) {
      upstream = await fetch(target, { headers: { Accept: "application/json" } });
      if (upstream.ok) {
        const toCache = new Response(upstream.body, upstream);
        toCache.headers.set("Cache-Control", `public, max-age=${CACHE_SECONDS}`);
        ctx.waitUntil(cache.put(cacheKey, toCache.clone()));
        upstream = toCache;
      }
    }

    const resp = new Response(upstream.body, upstream);
    if (allowed) {
      for (const [k, v] of Object.entries(corsHeaders(origin))) resp.headers.set(k, v);
    }
    return resp;
  },
};
