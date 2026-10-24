#!/usr/bin/env python3
"""Build the frozen PubTrans Minneapolis dataset from OSM-derived extracts.

Default inputs are the compact road/building extracts published by
Osyanne/CitiesSkylines2-osm-toolkit. Run with --download to refresh them, or
supply local files with --roads and --buildings. No third-party Python packages
are required. Browser code never contacts an OSM service.
"""
from __future__ import annotations
import argparse, collections, hashlib, json, math, pathlib, re, time, urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
BBOX = (44.962, -93.287, 44.997, -93.213)  # south, west, north, east
ORIGIN = (44.9795, -93.25)
ROAD_URL = "https://raw.githubusercontent.com/Osyanne/CitiesSkylines2-osm-toolkit/main/visualizer/cities/minneapolis/datos_vial.json"
BUILDING_URL = "https://raw.githubusercontent.com/Osyanne/CitiesSkylines2-osm-toolkit/main/visualizer/cities/minneapolis/datos_zonificacion.json"
ROAD_CLASSES = {"highway": (0, 80), "major": (1, 45), "minor": (2, 35), "local": (3, 25)}
# These are illustrative direction assumptions, not a verified municipal rule set.
ONE_WAY_NAMES = {
    "Marquette Avenue", "2nd Avenue South", "3rd Avenue South", "4th Avenue South",
    "5th Avenue South", "6th Avenue South", "7th Avenue South", "8th Avenue South",
    "9th Avenue South", "10th Avenue South", "11th Avenue South", "Hennepin Avenue",
    "1st Avenue North", "3rd Street North", "4th Street North", "5th Street North",
}
DORM_NAMES = {
    "Frontier Hall", "Territorial Hall", "Centennial Hall", "Pioneer Hall",
    "Sanford Hall", "Middlebrook Hall", "Comstock Hall", "Yudof Hall",
    "17th Avenue Residence Hall", "Bailey Hall",
}
SHOP_PATTERN = re.compile(r"market|store|shop|liquor|food|retail|grocery|surdyk", re.I)
APARTMENT_PATTERN = re.compile(r"apartment|lofts|residence|student housing|the marshall|the bridges|the knoll|the denn|the copham", re.I)
TOWNHOME_PATTERN = re.compile(r"townhome|townhouse", re.I)
PLACES = [
    ("Target Field", 44.9817, -93.2776, "transit"),
    ("Warehouse District", 44.9847, -93.2690, "work"),
    ("Minneapolis City Hall", 44.9773, -93.2652, "work"),
    ("Nicollet & 7th", 44.9769, -93.2740, "home"),
    ("U.S. Bank Stadium", 44.9738, -93.2580, "work"),
    ("West Bank", 44.9722, -93.2440, "campus"),
    ("Riverside Plaza", 44.9729, -93.2408, "home"),
    ("Wilson Library", 44.9750, -93.2385, "campus"),
    ("Northrop", 44.9764, -93.2352, "campus"),
    ("Coffman Memorial Union", 44.9733, -93.2347, "campus"),
    ("Dinkytown", 44.9800, -93.2275, "work"),
    ("University Village", 44.9776, -93.2247, "home"),
    ("Stadium Village", 44.9731, -93.2223, "transit"),
    ("Huntington Bank Stadium", 44.9738, -93.2185, "campus"),
]
WATER = [[
    [-93.290,44.9910],[-93.278,44.9880],[-93.271,44.9848],[-93.263,44.9820],
    [-93.252,44.9783],[-93.247,44.9750],[-93.244,44.9690],[-93.239,44.9630],
    [-93.232,44.9590],[-93.225,44.9610],[-93.219,44.9650],[-93.213,44.9700],
    [-93.207,44.9730],[-93.210,44.9660],[-93.218,44.9580],[-93.229,44.9530],
    [-93.240,44.9560],[-93.250,44.9640],[-93.255,44.9700],[-93.263,44.9740],
    [-93.273,44.9780],[-93.282,44.9810],[-93.290,44.9840]
]]


def download(url: str, path: pathlib.Path) -> None:
    for attempt in range(5):
        try:
            print(f"Downloading {url}")
            with urllib.request.urlopen(url, timeout=120) as response:
                path.write_bytes(response.read())
            return
        except Exception:
            if attempt == 4: raise
            time.sleep(2 ** attempt)


def project(lon: float, lat: float) -> tuple[float, float]:
    lat0 = math.radians(ORIGIN[0])
    return ((lon - ORIGIN[1]) * 111320 * math.cos(lat0), (ORIGIN[0] - lat) * 110574)


def decode_geom(packed: list[int], precision: int) -> list[tuple[float, float]]:
    scale = 10 ** precision
    # Source compact arrays are latitude/longitude, unlike GeoJSON.
    lat, lon = packed[0] / scale, packed[1] / scale
    points = [(lon, lat)]
    for i in range(2, len(packed), 2):
        lat += packed[i] / scale
        lon += packed[i + 1] / scale
        points.append((lon, lat))
    return points


def prop(layer: dict, name: str, index: int, default=None):
    item = layer.get("props", {}).get(name)
    if item is None: return default
    if "values" in item: return item["values"][index]
    return item.get("sparse", {}).get(str(index), item.get("default", default))


def clip_line(points, bbox):
    """Retain continuous runs that intersect the bbox, clipping at segment hits."""
    south, west, north, east = bbox
    def inside(p): return south <= p[1] <= north and west <= p[0] <= east
    def hits(a, b):
        dx, dy = b[0]-a[0], b[1]-a[1]
        ts = [0.0, 1.0]
        for p, q in ((-dx, a[0]-west), (dx, east-a[0]), (-dy, a[1]-south), (dy, north-a[1])):
            if abs(p) < 1e-15:
                if q < 0: return []
            else:
                t = q/p
                if p < 0: ts[0] = max(ts[0], t)
                else: ts[1] = min(ts[1], t)
        return ts if ts[0] <= ts[1] else []
    runs, run = [], []
    for a, b in zip(points, points[1:]):
        ts = hits(a, b)
        if not ts:
            if run: runs.append(run); run = []
            continue
        dx, dy = b[0]-a[0], b[1]-a[1]
        p = (a[0]+dx*ts[0], a[1]+dy*ts[0]); q = (a[0]+dx*ts[1], a[1]+dy*ts[1])
        if run and math.dist(run[-1], p) > 1e-7:
            runs.append(run); run = []
        if not run: run.append(p)
        run.append(q)
    if run: runs.append(run)
    return [r for r in runs if len(r) >= 2 and math.dist(r[0], r[-1]) > 1e-7]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--roads", type=pathlib.Path, default=pathlib.Path("/tmp/mpls-vial.json"))
    parser.add_argument("--buildings", type=pathlib.Path, default=pathlib.Path("/tmp/mpls-buildings.json"))
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--output", type=pathlib.Path, default=ROOT/"data"/"minneapolis.json")
    args = parser.parse_args()
    if args.download:
        download(ROAD_URL, args.roads); download(BUILDING_URL, args.buildings)
    road_raw = json.loads(args.roads.read_text()); building_raw = json.loads(args.buildings.read_text())
    if road_raw.get("format") != "cs2-compact" or building_raw.get("format") != "cs2-compact":
        raise ValueError("Expected cs2-compact source extracts")

    nodes, node_ids, edges, names, name_ids = [], {}, [], [], {}
    def node(lon, lat):
        x, y = project(lon, lat)
        key = (round(x, 1), round(y, 1))
        if key not in node_ids:
            node_ids[key] = len(nodes); nodes.append([key[0], key[1]])
        return node_ids[key]
    def name_index(value):
        value = value or "Unnamed street"
        if value not in name_ids: name_ids[value] = len(names); names.append(value)
        return name_ids[value]

    source_ways = 0
    for category, layer in road_raw["layers"].items():
        if category not in ROAD_CLASSES: continue
        class_id, speed = ROAD_CLASSES[category]
        for i, packed in enumerate(layer["geom"]):
            source_ways += 1
            points = decode_geom(packed, road_raw["precision"])
            street_name = prop(layer, "name", i, "")
            oneway = category == "highway" or street_name in ONE_WAY_NAMES
            for run in clip_line(points, BBOX):
                ids = [node(lon, lat) for lon, lat in run]
                for a, b in zip(ids, ids[1:]):
                    if a == b: continue
                    length = math.dist(nodes[a], nodes[b])
                    edges.append([a, b, round(length, 1), class_id, 1 if oneway else 0,
                                  speed, name_index(street_name)])

    # Keep the largest weakly-connected component for simulation. Render-only
    # fragments are excluded from the frozen graph and reported in metadata.
    adjacency = collections.defaultdict(set)
    for a,b,*_ in edges: adjacency[a].add(b); adjacency[b].add(a)
    unseen, components = set(adjacency), []
    while unseen:
        start = unseen.pop(); component = {start}; stack = [start]
        while stack:
            current = stack.pop()
            for nxt in adjacency[current]:
                if nxt in unseen: unseen.remove(nxt); component.add(nxt); stack.append(nxt)
        components.append(component)
    # Directed routing needs a strongly-connected core: one-way streets and
    # freeway ramps otherwise create reachable-but-unreturnable fragments.
    forward = collections.defaultdict(list); reverse = collections.defaultdict(list)
    for a,b,_,_,direction,*_ in edges:
        forward[a].append(b); reverse[b].append(a)
        if direction == 0: forward[b].append(a); reverse[a].append(b)
    visited, order = set(), []
    for root in adjacency:
        if root in visited: continue
        visited.add(root); stack=[(root,0)]
        while stack:
            current,offset=stack[-1]
            neighbours=forward[current]
            if offset < len(neighbours):
                nxt=neighbours[offset]; stack[-1]=(current,offset+1)
                if nxt not in visited: visited.add(nxt); stack.append((nxt,0))
            else: order.append(current); stack.pop()
    assigned, strong = set(), []
    for root in reversed(order):
        if root in assigned: continue
        component={root}; assigned.add(root); stack=[root]
        while stack:
            current=stack.pop()
            for nxt in reverse[current]:
                if nxt not in assigned: assigned.add(nxt); component.add(nxt); stack.append(nxt)
        strong.append(component)
    largest = max(strong, key=len)
    remap = {old:i for i,old in enumerate(sorted(largest))}
    edges = [[remap[e[0]], remap[e[1]], *e[2:]] for e in edges if e[0] in largest and e[1] in largest]
    nodes = [nodes[i] for i in sorted(largest)]

    buildings, named_buildings = [], 0
    for category, layer in building_raw["layers"].items():
        if category.startswith("prk_"): kind = "parking"
        elif category.startswith("res_"): kind = "home"
        elif category.startswith("com_"): kind = "work"
        elif category.startswith("office_"): kind = "work"
        else: kind = "building"
        for i, packed in enumerate(layer["geom"]):
            points = decode_geom(packed, building_raw["precision"])
            cx = sum(p[0] for p in points)/len(points); cy = sum(p[1] for p in points)/len(points)
            if not (BBOX[1] <= cx <= BBOX[3] and BBOX[0] <= cy <= BBOX[2]): continue
            projected = [project(lon,lat) for lon,lat in points]
            if projected[0] == projected[-1]: projected.pop()
            if len(projected) < 3: continue
            name = prop(layer,"name",i,"")
            if name: named_buildings += 1
            buildings.append({"p": [round(v,1) for point in projected for v in point], "k": kind, "n": name})

    outgoing = collections.defaultdict(list)
    for idx,(a,b,length,*_) in enumerate(edges):
        outgoing[a].append((idx,b,length)); outgoing[b].append((idx,a,length))
    def nearest_node(lon, lat):
        x,y = project(lon,lat)
        return min(range(len(nodes)), key=lambda i:(nodes[i][0]-x)**2+(nodes[i][1]-y)**2)
    def snap_xy(x, y):
        return min(range(len(nodes)), key=lambda i:(nodes[i][0]-x)**2+(nodes[i][1]-y)**2)
    places = []
    for place_name,lat,lon,kind in PLACES:
        idx = nearest_node(lon,lat); x,y = project(lon,lat)
        places.append({"name":place_name,"node":idx,"kind":kind,
                       "distance":round(math.dist((x,y),nodes[idx]),1)})

    # Demand comes from real named buildings, not uniformly random map points.
    # Weights represent relative trip generation/attraction; the browser applies
    # time-of-day multipliers and normalizes the total to the selected rate.
    demand_places = []
    for place in places:
        demand_places.append({**place, "weight": {"home":24,"work":30,"campus":36,"transit":22}[place["kind"]]})
    seen_names = {p["name"].casefold() for p in demand_places}
    for building in buildings:
        name = building.get("n", "")
        if not name or name.casefold() in seen_names: continue
        if name in DORM_NAMES:
            # Large dorms individually generate dozens of hourly requests at
            # maximum demand, unlike a single small townhome or storefront.
            kind, weight = "dorm", 1200
        elif TOWNHOME_PATTERN.search(name):
            kind, weight = "townhome", 9
        elif building["k"] == "home" and APARTMENT_PATTERN.search(name):
            kind, weight = "apartment", 15
        elif building["k"] == "home":
            kind, weight = "home", 8
        elif building["k"] == "work" and SHOP_PATTERN.search(name):
            kind, weight = "shop", 22
        elif building["k"] == "work":
            kind, weight = "work", 18
        else:
            continue
        points = building["p"]
        x = sum(points[::2])/len(points[::2]); y = sum(points[1::2])/len(points[1::2])
        idx = snap_xy(x,y)
        distance = math.dist((x,y),nodes[idx])
        if distance > 300: continue
        demand_places.append({"name":name,"node":idx,"kind":kind,
                              "distance":round(distance,1),"weight":weight})
        seen_names.add(name.casefold())

    data = {
        "schema":"pubtrans-mpls-1", "generatedAt":time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime()),
        "bbox":BBOX, "origin":ORIGIN, "attribution":"© OpenStreetMap contributors, ODbL 1.0",
        "source": {"roads":ROAD_URL,"buildings":BUILDING_URL,
                   "roadExtractDate":road_raw["meta"].get("generated_at"),
                   "buildingExtractDate":building_raw["meta"].get("generated_at")},
        "assumptions": ["Geometry comes from OSM-derived extracts.","Local direction defaults are illustrative; verify one-way rules before planning use.",
                        "Speeds are simulation defaults, not measured traffic.","River polygon is a cartographic approximation."],
        "classNames":["highway","major","minor","local"], "streetNames":names,
        "nodes":nodes, "edges":edges, "buildings":buildings, "places":places,
        "demandPlaces":demand_places,
        "demandModel":{"maxRequestsPerHour":600,"defaultRequestsPerHour":120,
                       "method":"Building-weighted origins and destinations with time-of-day multipliers"},
        "water":[[[round(v,1) for v in project(lon,lat)] for lon,lat in ring] for ring in WATER],
        "labels":[{"text":"DOWNTOWN MINNEAPOLIS","x":project(-93.269,44.978)[0],"y":project(-93.269,44.978)[1]},
                  {"text":"WEST BANK","x":project(-93.244,44.969)[0],"y":project(-93.244,44.969)[1]},
                  {"text":"EAST BANK","x":project(-93.227,44.982)[0],"y":project(-93.227,44.982)[1]}]
    }
    data["stats"] = {"nodes":len(nodes),"directedBaseEdges":len(edges),"sourceRoadWays":source_ways,
                     "components":len(components),"buildings":len(buildings),"namedBuildings":named_buildings,
                     "places":len(places),"demandPlaces":len(demand_places),
                     "dorms":sum(p["kind"]=="dorm" for p in demand_places),
                     "networkKilometers":round(sum(e[2] for e in edges)/1000,1)}
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(data,separators=(",",":"),ensure_ascii=False))
    print(json.dumps(data["stats"],indent=2)); print(f"Wrote {args.output} ({args.output.stat().st_size:,} bytes)")

if __name__ == "__main__": main()
