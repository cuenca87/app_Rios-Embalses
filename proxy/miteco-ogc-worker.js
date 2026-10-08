// Cloudflare Worker: proxy CORS de solo lectura para el GeoServer de MITECO.
//
// MITECO dejo de enviar cabeceras CORS, asi que las apps de cuenca87.github.io
// no pueden leer sus respuestas con fetch(). Este worker reenvia las llamadas
// y anade esas cabeceras. Rutas admitidas (relativas a /geoserver/):
//
//   collections/...              -> ogc/features/v1/collections/...  (OGC API Features;
//                                   forma corta usada por app_Rios-Embalses e incendios-2026)
//   ogc/features/v1/...          -> igual, forma completa
//   wms?...request=GetFeatureInfo           -> consultas puntuales WMS
//   gwc/service/wmts?...request=GetFeatureInfo -> consultas puntuales WMTS
//
// Solo GET, solo esas rutas (no es un proxy abierto) y solo desde ALLOWED_ORIGINS.
// Los mosaicos de imagen (GetMap/GetTile) NO pasan por aqui: las imagenes no
// estan sujetas a CORS y se piden directamente a MITECO.

const UPSTREAM = "https://gis.miteco.gob.es/geoserver/";

const ALLOWED_ORIGINS = [
  "https://cuenca87.github.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
];

// Los datos de referencia cambian muy poco: cache de una hora en el borde.
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

// Devuelve la ruta en el GeoServer de MITECO, o null si no esta permitida.
function rutaPermitida(path, params) {
  if (path.startsWith("collections")) return "ogc/features/v1/" + path;
  if (path.startsWith("ogc/features/v1/")) return path;
  const req = (params.get("request") || params.get("REQUEST") || "").toLowerCase();
  if ((path === "wms" || path === "gwc/service/wmts") && req === "getfeatureinfo") return path;
  return null;
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
    const ruta = rutaPermitida(url.pathname.replace(/^\/+/, ""), url.searchParams);
    if (!ruta) {
      return new Response("Ruta no permitida", { status: 404 });
    }
    const target = UPSTREAM + ruta + url.search;

    // Cache en el borde (clave = URL de MITECO, independiente del origen)
    const cache = caches.default;
    const cacheKey = new Request(target, { method: "GET" });
    let upstream = await cache.match(cacheKey);

    if (!upstream) {
      upstream = await fetch(target);
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
