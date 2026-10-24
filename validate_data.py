#!/usr/bin/env python3
"""Validate the frozen graph without external dependencies."""
import collections, heapq, json, pathlib, unittest

DATA = json.loads((pathlib.Path(__file__).resolve().parents[1]/"data"/"minneapolis.json").read_text())

class MinneapolisDataTests(unittest.TestCase):
    def setUp(self):
        self.adj = collections.defaultdict(list)
        for i,(a,b,length,kind,direction,speed,name) in enumerate(DATA["edges"]):
            self.adj[a].append((b,length)); 
            if direction == 0: self.adj[b].append((a,length))

    def test_schema_and_counts(self):
        self.assertEqual(DATA["schema"], "pubtrans-mpls-1")
        self.assertGreater(DATA["stats"]["networkKilometers"], 100)
        self.assertGreater(len(DATA["buildings"]), 1000)
        self.assertEqual(len(DATA["places"]), 14)
        self.assertGreaterEqual(len(DATA["demandPlaces"]), 100)
        self.assertEqual(DATA["demandModel"]["maxRequestsPerHour"], 600)

    def test_edges_reference_valid_distinct_nodes(self):
        for a,b,length,kind,direction,speed,name in DATA["edges"]:
            self.assertNotEqual(a,b); self.assertIn(a,range(len(DATA["nodes"])))
            self.assertIn(b,range(len(DATA["nodes"]))); self.assertGreater(length,0)
            self.assertGreater(speed,0); self.assertIn(direction,(0,1))

    def test_all_destinations_are_snapped_nearby_and_connected(self):
        for place in DATA["places"]:
            self.assertLess(place["distance"], 250, place["name"])
            self.assertIn(place["node"],self.adj,place["name"])
        for source in DATA["places"]:
            distances = self.route(source["node"])
            for target in DATA["places"]:
                self.assertIn(target["node"],distances,f'{source["name"]} → {target["name"]}')
                self.assertLess(distances[target["node"]],30000)

    def test_building_demand_is_connected_and_dorms_are_high_volume(self):
        demand = DATA["demandPlaces"]
        kinds = {p["kind"] for p in demand}
        self.assertTrue({"apartment","townhome","shop","dorm","work"}.issubset(kinds))
        total_weight = sum(p["weight"] for p in demand)
        for place in demand:
            self.assertLess(place["distance"], 301, place["name"])
            self.assertIn(place["node"], self.adj, place["name"])
            self.assertGreater(place["weight"], 0)
        dorms = [p for p in demand if p["kind"] == "dorm"]
        self.assertIn("Frontier Hall", {p["name"] for p in dorms})
        for dorm in dorms:
            neutral_requests_per_hour = 600 * dorm["weight"] / total_weight
            self.assertGreaterEqual(neutral_requests_per_hour, 24, dorm["name"])

    def test_cross_bank_route_has_sensible_distance(self):
        west = next(p for p in DATA["places"] if p["name"]=="West Bank")
        east = next(p for p in DATA["places"] if p["name"]=="Northrop")
        distance = self.route(west["node"])[east["node"]]
        self.assertGreater(distance,500); self.assertLess(distance,6000)

    def route(self,start):
        dist = {start:0}; queue=[(0,start)]
        while queue:
            cost,node=heapq.heappop(queue)
            if cost != dist[node]: continue
            for nxt,length in self.adj[node]:
                candidate=cost+length
                if candidate < dist.get(nxt,float("inf")):
                    dist[nxt]=candidate;heapq.heappush(queue,(candidate,nxt))
        return dist

if __name__ == "__main__": unittest.main(verbosity=2)
