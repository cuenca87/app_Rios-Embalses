"""Descarga los atributos de todas las subcuencas Pfafstetter de MITECO
(agua:subcuencas_pfaf_cx) y escribe una tabla por grupo de codigos.

La app (index.html) lee estas tablas para sacar al instante las subcuencas que
hay aguas arriba de un punto; solo pide a MITECO la geometria. Hay que volver a
generarlas si MITECO actualiza las subcuencas (y cambiar CUENCAS_VER en index.html).

Uso: python build_tabla.py <carpeta_salida>      (tarda unos minutos)
Formato de cada <grupo>.json, una fila por unidad ordenada por codigo:
  c  codigo Pfafstetter (cod_pfafcuen)      r  indice en rios
  a  superficie propia, km2 (area_ctr_km2)  zx/zm  cota maxima / media, m
  b  caja: 4 enteros por unidad en milesimas de grado: esquina SO como
     diferencia con la de la unidad anterior, ancho y alto
  rios  [cod_pfafrio, nom_rio, area_cu_km2]
"""
import json, math, os, pickle, sys, time, urllib.parse, urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor

OUT = sys.argv[1]
CRUDO = os.path.join(OUT, "_atributos.pkl")   # cache de la descarga (borrar para regenerar)
B = "https://gis.miteco.gob.es/geoserver/agua/wfs?"
ATRIB = "cod_pfafcuen,cod_pfafrio,nom_rio,area_ctr_km2,area_cu_km2,cota_max,cota_med"


def grupo(c):
    return c[:4] if c[:3] in ("100", "200") else c[:3]


def bajar(g):
    p = {"service": "WFS", "version": "1.0.0", "request": "GetFeature", "typeName": "agua:subcuencas_pfaf_cx",
         "outputFormat": "application/json", "srsName": "EPSG:4326", "propertyName": ATRIB,
         "CQL_FILTER": f"cod_pfafcuen BETWEEN '{g}' AND '{g}9999999999999999999'"}
    for intento in range(4):
        try:
            d = json.load(urllib.request.urlopen(B + urllib.parse.urlencode(p), timeout=600))
            return g, [(f["properties"], f.get("bbox")) for f in d["features"]]
        except Exception as e:
            print("  reintento", g, e, flush=True)
            time.sleep(5 * (intento + 1))
    raise RuntimeError(g)


if os.path.exists(CRUDO):
    datos = pickle.load(open(CRUDO, "rb"))
else:
    codigos = []
    for pre in "12":
        p = {"service": "WFS", "version": "1.0.0", "request": "GetFeature", "typeName": "agua:subcuencas_pfaf_cx",
             "outputFormat": "application/json", "propertyName": "cod_pfafcuen", "CQL_FILTER": f"cod_pfafcuen LIKE '{pre}%'"}
        d = json.load(urllib.request.urlopen(B + urllib.parse.urlencode(p), timeout=900))
        codigos += [f["properties"]["cod_pfafcuen"] for f in d["features"]]
    grupos = sorted({grupo(c) for c in codigos})
    print(len(grupos), "grupos", flush=True)
    datos = {}
    with ThreadPoolExecutor(4) as ex:
        for g, filas in ex.map(bajar, grupos):
            datos[g] = filas
            print(g, len(filas), flush=True)
    pickle.dump(datos, open(CRUDO, "wb"))

os.makedirs(OUT, exist_ok=True)
total = 0
sin_bbox = 0
for g, filas in sorted(datos.items()):
    filas = [f for f in filas if grupo(f[0]["cod_pfafcuen"]) == g]
    filas.sort(key=lambda f: f[0]["cod_pfafcuen"])
    rios, idx = [], {}
    col = defaultdict(list)
    prev = (0, 0)
    for p, bb in filas:
        r = p["cod_pfafrio"]
        if r not in idx:
            idx[r] = len(rios)
            rios.append([r, (p["nom_rio"] or "").strip(), 0])
        ri = idx[r]
        rios[ri][2] = max(rios[ri][2], round(float(p["area_cu_km2"] or 0), 2))
        col["c"].append(p["cod_pfafcuen"])
        col["r"].append(ri)
        col["a"].append(round(float(p["area_ctr_km2"] or 0), 3))
        col["zx"].append(None if p["cota_max"] is None else round(float(p["cota_max"])))
        col["zm"].append(None if p["cota_med"] is None else round(float(p["cota_med"])))
        if not bb:
            sin_bbox += 1
            bb = [None] * 4
        # caja en milesimas de grado (~100 m), redondeada hacia fuera; se guarda
        # la esquina SO como diferencia con la de la unidad anterior, y el ancho y alto
        x0, y0 = math.floor(bb[0] * 1000), math.floor(bb[1] * 1000)
        col["b"].extend([x0 - prev[0], y0 - prev[1], math.ceil(bb[2] * 1000) - x0, math.ceil(bb[3] * 1000) - y0])
        prev = (x0, y0)
    total += len(filas)
    with open(os.path.join(OUT, g + ".json"), "w", encoding="utf8") as f:
        json.dump({"grupo": g, "rios": rios, **col}, f, ensure_ascii=False, separators=(",", ":"))
print("unidades", total, "sin bbox", sin_bbox)
