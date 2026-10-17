// Proxy de reserva en Vercel para cuando no se llega a los Workers de Cloudflare
// (*.workers.dev). Los dias de partido las operadoras espanolas bloquean IPs de
// Cloudflare por orden de LaLiga; Vercel usa otras IPs.
//
// Junta los dos Workers, con las mismas reglas:
//   /argos/...   -> https://observatorio-dga.argos-hydro.com/...   (argos-proxy-worker)
//                   solo /api/... y /geoserver/..., GET y POST
//   /miteco/...  -> https://gis.miteco.gob.es/geoserver/...        (proxy/miteco-ogc-worker.js)
//                   solo las rutas de consulta de ese Worker, y
//   /miteco/opera/AAAA/MM/DD/OPERA/COMP/OPERA@...@ACRR.tiff -> almacen S3 de OPERA (con Range)
// Solo desde ALLOWED_ORIGINS. La app solo lo usa si el Worker no responde.

export const config = { matcher: "/(.*)" };

const ARGOS = "https://observatorio-dga.argos-hydro.com/";
const MITECO = "https://gis.miteco.gob.es/geoserver/";
const OPERA_S3 = "https://s3.waw3-1.cloudferro.com/openradar-24h/";
const OPERA_RUTA = /^opera\/(\d{4}\/\d{2}\/\d{2}\/OPERA\/COMP\/OPERA@\d{8}T\d{4}@0@ACRR\.tiff)$/;

const ALLOWED_ORIGINS = [
  "https://cuenca87.github.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
];

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, Range, Authorization",
    "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

// Rutas de MITECO permitidas (las mismas que el Worker)
function rutaMiteco(path, params) {
  if (path.startsWith("collections")) return "ogc/features/v1/" + path;
  if (path.startsWith("ogc/features/v1/")) return path;
  const req = (params.get("request") || params.get("REQUEST") || "").toLowerCase();
  if ((path === "wms" || path === "gwc/service/wmts") && req === "getfeatureinfo") return path;
  if (path === "agua/wfs" && req === "getfeature") return path;
  if (path === "agua/wms" && req === "getmap") return path;
  return null;
}

export default async function middleware(request) {
  const origin = request.headers.get("Origin") || "";
  const allowed = ALLOWED_ORIGINS.includes(origin);
  if (request.method === "OPTIONS") {
    return new Response(null, { status: allowed ? 204 : 403, headers: allowed ? cors(origin) : {} });
  }
  if (origin && !allowed) return new Response("Origen no permitido", { status: 403 });

  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/+/, "");
  let target = null;
  const headers = {};

  if (path.startsWith("argos/")) {
    const resto = path.slice(6);
    if (!/^(api|geoserver)\//.test(resto)) return new Response("Ruta no permitida", { status: 404 });
    if (!["GET", "POST"].includes(request.method)) return new Response("Metodo no permitido", { status: 405 });
    target = ARGOS + resto + url.search;
    for (const h of ["Content-Type", "Authorization", "Accept"]) {
      const v = request.headers.get(h);
      if (v) headers[h] = v;
    }
  } else if (path.startsWith("miteco/")) {
    if (request.method !== "GET") return new Response("Metodo no permitido", { status: 405 });
    const resto = path.slice(7), opera = resto.match(OPERA_RUTA);
    if (opera) {
      target = OPERA_S3 + opera[1];
      const range = request.headers.get("Range");
      if (range) headers.Range = range;
    } else {
      const ruta = rutaMiteco(resto, url.searchParams);
      if (!ruta) return new Response("Ruta no permitida", { status: 404 });
      target = MITECO + ruta + url.search;
    }
  } else {
    return new Response("Proxy de reserva de app_Rios-Embalses", { status: 404 });
  }

  let resp;
  try {
    resp = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "POST" ? await request.arrayBuffer() : undefined,
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: "proxy_error", message: String(e) }), {
      status: 502,
      headers: { ...(allowed ? cors(origin) : {}), "Content-Type": "application/json" },
    });
  }
  const out = new Headers(resp.headers);
  out.delete("content-encoding");
  out.delete("content-length");
  if (allowed) for (const [k, v] of Object.entries(cors(origin))) out.set(k, v);
  return new Response(resp.body, { status: resp.status, headers: out });
}
