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
//   agua/wfs?...request=GetFeature           -> consultas WFS del workspace agua
//                                   (permite pedir solo atributos con propertyName;
//                                   lo usa la cuenca vertiente de app_Rios-Embalses)
//   agua/wms?...request=GetMap               -> imagen de las subcuencas que la cuenca
//                                   vertiente lee pixel a pixel para sacar el contorno
//                                   (un canvas no puede leer imagenes sin CORS)
//   opera/AAAA/MM/DD/OPERA/COMP/OPERA@AAAAMMDDTHHMM@0@ACRR.tiff
//                                 -> compuesto europeo de lluvia acumulada en 1 h
//                                   (EUMETNET OPERA, CC BY 4.0) del almacen S3 abierto
//                                   de OPERA, que no envia cabeceras CORS. Se reenvia
//                                   la cabecera Range: la app lee solo las teselas
//                                   del GeoTIFF que cubren la cuenca.
//
// Solo GET, solo esas rutas (no es un proxy abierto) y solo desde ALLOWED_ORIGINS.
// Los mosaicos de imagen para ver en el mapa (GetMap/GetTile) NO pasan por aqui:
// las imagenes no estan sujetas a CORS y se piden directamente a MITECO.

const UPSTREAM = "https://gis.miteco.gob.es/geoserver/";

const ALLOWED_ORIGINS = [
  "https://cuenca87.github.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
];

// Los datos de referencia cambian muy poco: cache de una hora en el borde.
const CACHE_SECONDS = 3600;

const OPERA_S3 = "https://s3.waw3-1.cloudferro.com/openradar-24h/";
const OPERA_RUTA = /^opera\/(\d{4}\/\d{2}\/\d{2}\/OPERA\/COMP\/OPERA@\d{8}T\d{4}@0@ACRR\.tiff)$/;

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, Range",
    "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

// Ficheros de OPERA: no cambian una vez publicados. Cloudflare guarda el fichero
// entero en cache y sirve los rangos desde ahi. Los que aun no existen (404) no se
// guardan, para que aparezcan en cuanto OPERA los publique.
async function operaFichero(clave, request, origin, allowed) {
  const init = { cf: { cacheEverything: true, cacheTtlByStatus: { "200-299": 86400, "404": 0, "500-599": 0 } } };
  const range = request.headers.get("Range");
  if (range) init.headers = { Range: range };
  const upstream = await fetch(OPERA_S3 + clave, init);
  const resp = new Response(upstream.body, upstream);
  if (allowed) {
    for (const [k, v] of Object.entries(corsHeaders(origin))) resp.headers.set(k, v);
  }
  return resp;
}

// Devuelve la ruta en el GeoServer de MITECO, o null si no esta permitida.
function rutaPermitida(path, params) {
  if (path.startsWith("collections")) return "ogc/features/v1/" + path;
  if (path.startsWith("ogc/features/v1/")) return path;
  const req = (params.get("request") || params.get("REQUEST") || "").toLowerCase();
  if ((path === "wms" || path === "gwc/service/wmts") && req === "getfeatureinfo") return path;
  if (path === "agua/wfs" && req === "getfeature") return path;
  if (path === "agua/wms" && req === "getmap") return path;
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
    const opera = url.pathname.replace(/^\/+/, "").match(OPERA_RUTA);
    if (opera) return operaFichero(opera[1], request, origin, allowed);
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
