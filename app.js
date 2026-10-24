/* PubTrans Minneapolis — dependency-free geographic simulation.
   Road graph: [from,to,meters,class,oneway,km/h,nameIndex]. */
'use strict';

const $ = (id) => document.getElementById(id);
const canvas = $('map');
const ctx = canvas.getContext('2d', { alpha: false });
const queueCanvas = $('queue-chart');
const queueCtx = queueCanvas.getContext('2d');
const SPEEDS = [8, 32, 96];
const TYPE = [
  { name: 'Sedan', cap: 4, color: '#22d3ee', width: 6 },
  { name: 'Shuttle', cap: 8, color: '#fbbf24', width: 8 },
  { name: 'Bus', cap: 20, color: '#e879f9', width: 10 }
];
const ROAD_COLORS = ['#455066', '#465872', '#35465d', '#29394e'];
let data, adjacency, edgeLookup, vehicles = [], requests = [];
let queueHistory = [], maxQueued = 0, lastQueueSample = -5;
let running = true, speedIndex = 0, demand = 120, simTime = 0;
let fleetCounts = [20, 6, 4], nextVehicleId = 1;
let humans = [], humanRate = 20, humanAccumulator = 0, nextHumanId = 1;
let signalNodes = new Set(), boundaryNodes = [], humanErrands = [];
let fleetYieldCount = 0, humanExits = 0, trafficGrid = new Map();
let intersectionReservations = new Map(), recoveredVehicles = 0;
let completed = 0, rideTotal = 0, waitTotal = 0, demandAccumulator = 0;
let accumulator = 0, lastFrame = 0, lastUI = 0, selectedVehicle = null;
let following = false, congestionRouting = true, toastTimer;
let pressure = new Float32Array(0), visibleRoads = 0;
const layers = { roads: true, buildings: true, labels: true, water: true, traffic: true, requests: true, humans: true, signals: true };
const camera = { x: 0, y: 0, scale: 0.1, fit: 0.1, width: 1, height: 1 };
const pointers = new Map();
let pinchStart = null, dragged = false;

function notify(message) {
  $('toast').textContent = message;
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 2800);
}

function logActivity(message) {
  const li = document.createElement('li');
  const time = document.createElement('time');
  time.textContent = formatTime(simTime).slice(0, 5);
  const text = document.createElement('span');
  text.textContent = message;
  li.append(time, text);
  $('activity-log').prepend(li);
  while ($('activity-log').children.length > 6) $('activity-log').lastChild.remove();
}

function formatTime(seconds) {
  const total = (7 * 3600 + Math.floor(seconds)) % 86400;
  return [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60]
    .map(n => String(n).padStart(2, '0')).join(':');
}

class MinHeap {
  constructor() { this.items = []; }
  push(node, cost) {
    const a = this.items; let i = a.length;
    a.push([cost, node]);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= cost) break;
      a[i] = a[p]; i = p;
    }
    a[i] = [cost, node];
  }
  pop() {
    const a = this.items;
    if (!a.length) return null;
    const root = a[0], tail = a.pop();
    if (a.length) {
      let i = 0;
      while (i * 2 + 1 < a.length) {
        let child = i * 2 + 1;
        if (child + 1 < a.length && a[child + 1][0] < a[child][0]) child++;
        if (a[child][0] >= tail[0]) break;
        a[i] = a[child]; i = child;
      }
      a[i] = tail;
    }
    return root;
  }
  get length() { return this.items.length; }
}

function findRoute(start, end, useCongestion = congestionRouting) {
  if (start === end) return { nodes: [start], links: [], distance: 0, duration: 0 };
  const count = data.nodes.length;
  const dist = new Float64Array(count); dist.fill(Infinity);
  const previous = new Int32Array(count); previous.fill(-1);
  const previousEdge = new Int32Array(count); previousEdge.fill(-1);
  const closed = new Uint8Array(count);
  const heap = new MinHeap();
  dist[start] = 0; heap.push(start, 0);
  while (heap.length) {
    const [cost, node] = heap.pop();
    if (closed[node] || cost !== dist[node]) continue;
    if (node === end) break;
    closed[node] = 1;
    for (let k = 0; k < adjacency[node].length; k++) {
      const edgeIndex = adjacency[node][k];
      const link = edgeLookup[edgeIndex];
      const next = link[0];
      if (closed[next]) continue;
      const load = useCongestion ? Math.min(pressure[link[4]] || 0, 5) : 0;
      const nextCost = cost + link[1] * (1 + load * 0.35);
      if (nextCost < dist[next]) {
        dist[next] = nextCost;
        previous[next] = node; previousEdge[next] = edgeIndex;
        heap.push(next, nextCost);
      }
    }
  }
  if (!Number.isFinite(dist[end])) return null;
  const nodes = [], links = [];
  let at = end;
  while (at !== start) {
    nodes.push(at);
    const link = edgeLookup[previousEdge[at]];
    links.push(link); at = previous[at];
  }
  nodes.push(start); nodes.reverse(); links.reverse();
  const distance = links.reduce((sum, link) => sum + link[1], 0);
  const duration = links.reduce((sum, link) => sum + link[1] / (link[2] / 3.6), 0);
  return { nodes, links, distance, duration };
}

function demandWeight(place, isOrigin) {
  const hour = (7 + simTime / 3600) % 24;
  const residential = ['home', 'apartment', 'townhome', 'dorm'].includes(place.kind);
  const employment = ['work', 'campus'].includes(place.kind);
  let multiplier = 1;
  if (hour >= 6.5 && hour < 10) {
    if (isOrigin) multiplier = residential ? 2.4 : employment ? 0.65 : 0.9;
    else multiplier = employment ? 2.1 : place.kind === 'shop' ? 1.5 : residential ? 0.5 : 1;
  } else if (hour >= 15 && hour < 19) {
    if (isOrigin) multiplier = residential ? 0.75 : employment ? 1.8 : place.kind === 'shop' ? 1.7 : 1;
    else multiplier = residential ? 2.2 : employment ? 0.65 : place.kind === 'shop' ? 1.3 : 1;
  } else if (place.kind === 'shop') multiplier = 1.5;
  else if (place.kind === 'campus') multiplier = 1.25;
  return place.weight * multiplier;
}

function weightedDemandPlace(isOrigin, other = null) {
  let fallback = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    let total = 0;
    for (const place of data.demandPlaces) total += demandWeight(place, isOrigin);
    let choice = Math.random() * total, selected = data.demandPlaces[0];
    for (const place of data.demandPlaces) {
      choice -= demandWeight(place, isOrigin);
      if (choice <= 0) { selected = place; break; }
    }
    fallback = selected;
    if (!other || (selected.node !== other.node && Math.hypot(
      data.nodes[selected.node][0] - data.nodes[other.node][0],
      data.nodes[selected.node][1] - data.nodes[other.node][1]) > 150)) return selected;
  }
  return fallback;
}

function createRequest() {
  const originPlace = weightedDemandPlace(true);
  const destinationPlace = weightedDemandPlace(false, originPlace);
  if (!originPlace || !destinationPlace || originPlace.node === destinationPlace.node) return null;
  const request = {
    id: Date.now() + Math.random(),
    originName: originPlace.name, destinationName: destinationPlace.name,
    originKind: originPlace.kind, destinationKind: destinationPlace.kind,
    origin: originPlace.node, destination: destinationPlace.node,
    created: simTime, pickup: null, party: 1 + Math.floor(Math.random() * 4)
  };
  requests.push(request);
  maxQueued = Math.max(maxQueued, requests.length);
  return request;
}

function transitHub() {
  return data.places.find(place => place.name === 'Nicollet & 7th');
}

function newVehicle(type) {
  const node = transitHub().node;
  return {
    id: nextVehicleId++, type, node, x: data.nodes[node][0], y: data.nodes[node][1],
    route: [], links: [], state: 'idle', request: null, onboard: 0,
    segmentDistance: 0, edgeIndex: -1, distance: 0
  };
}

function resetSimulation() {
  nextVehicleId = 1;
  vehicles = fleetCounts.flatMap((count, type) => Array.from({ length: count }, () => newVehicle(type)));
  document.querySelectorAll('[data-fleet-type]').forEach(input => {
    const value = fleetCounts[Number(input.dataset.fleetType)];
    input.value = value; $(input.id + '-output').value = value;
  });
  requests = []; queueHistory = []; maxQueued = 0; lastQueueSample = -5;
  pressure = new Float32Array(edgeLookup.length);
  simTime = 0; completed = 0; rideTotal = 0; waitTotal = 0;
  humans = []; humanAccumulator = 0; nextHumanId = 1; fleetYieldCount = 0; humanExits = 0;
  intersectionReservations = new Map(); recoveredVehicles = 0;
  demandAccumulator = 0; accumulator = 0; selectedVehicle = null; following = false;
  $('vehicle-card').hidden = true;
  $('activity-log').replaceChildren();
  for (let i = 0; i < Math.max(0, Math.min(Math.ceil(vehicles.length * 0.8), vehicles.length - 1)); i++) createRequest();
  dispatchRequests();
  sampleQueue(true);
  logActivity(`Service day initialized across ${data.demandPlaces.length} demand buildings`);
  updateUI();
}

function returnToHub(vehicle) {
  const hubNode = transitHub().node;
  if (vehicle.node === hubNode && !vehicle.route.length) {
    vehicle.state = 'idle'; vehicle.request = null; vehicle.onboard = 0;
    return;
  }
  const route = findRoute(vehicle.node, hubNode);
  if (!route) return;
  vehicle.state = 'returning'; vehicle.request = null; vehicle.onboard = 0;
  vehicle.route = route.nodes.slice(1); vehicle.links = route.links;
}

function beginRide(vehicle) {
  vehicle.state = 'riding'; vehicle.onboard = vehicle.request.party;
  vehicle.request.pickup = simTime; waitTotal += simTime - vehicle.request.created;
  const passengerLabel = vehicle.onboard === 1 ? 'passenger' : 'passengers';
  logActivity(`${TYPE[vehicle.type].name} ${vehicle.id} picked up ${vehicle.onboard} ${passengerLabel} → ${vehicle.request.destinationName}`);
}

function dispatchRequests() {
  for (const vehicle of vehicles) {
    if (vehicle.state !== 'idle' || !requests.length) continue;
    let requestIndex = requests.findIndex(r => r.party <= TYPE[vehicle.type].cap);
    if (requestIndex < 0) continue;
    const request = requests.splice(requestIndex, 1)[0];
    const pickup = findRoute(vehicle.node, request.origin);
    const ride = findRoute(request.origin, request.destination);
    if (!pickup || !ride) { requests.unshift(request); continue; }
    vehicle.request = request;
    vehicle.state = 'pickup';
    vehicle.route = pickup.nodes.slice(1).concat(ride.nodes.slice(1));
    vehicle.links = pickup.links.concat(ride.links);
    vehicle.pickupRemaining = pickup.nodes.length - 1;
    if (vehicle.pickupRemaining === 0) beginRide(vehicle);
  }
  for (const vehicle of vehicles) {
    if (vehicle.state === 'idle' && !vehicle.request) returnToHub(vehicle);
  }
}

function arriveAtNext(vehicle) {
  vehicle.node = vehicle.route.shift();
  vehicle.links.shift();
  vehicle.x = data.nodes[vehicle.node][0]; vehicle.y = data.nodes[vehicle.node][1];
  vehicle.segmentDistance = 0; vehicle.edgeIndex = -1;
  if (vehicle.state === 'pickup' && vehicle.pickupRemaining > 0) {
    vehicle.pickupRemaining--;
    if (vehicle.pickupRemaining === 0) beginRide(vehicle);
  }
  if (vehicle.route.length) return;
  if (vehicle.state === 'riding') {
    completed++; rideTotal += simTime - vehicle.request.pickup;
    const place = vehicle.request.destinationName;
    if (completed % 5 === 0) logActivity(`${TYPE[vehicle.type].name} ${vehicle.id} arrived at ${place}`);
    vehicle.request = null; vehicle.onboard = 0; vehicle.state = 'idle';
  } else if (vehicle.state === 'returning') {
    vehicle.state = 'idle';
  }
}

function sampleQueue(force = false) {
  maxQueued = Math.max(maxQueued, requests.length);
  if (!force && simTime - lastQueueSample < 5) return;
  queueHistory.push({ time: simTime, value: requests.length });
  lastQueueSample = simTime;
  const cutoff = Math.max(0, simTime - 1800);
  while (queueHistory.length > 2 && queueHistory[1].time < cutoff) queueHistory.shift();
}

function prepareTrafficModel() {
  signalNodes = new Set();
  adjacency.forEach((links, node) => {
    const unique = new Set(links.map(index => edgeLookup[index][0]));
    if (unique.size >= 4 && links.some(index => edgeLookup[index][3] <= 2)) signalNodes.add(node);
  });
  const bounds = dataBounds(), margin = 170;
  boundaryNodes = data.nodes.map((point, node) => ({ point, node })).filter(({ point, node }) =>
    adjacency[node].length && (Math.abs(point[0] - bounds.minX) < margin || Math.abs(point[0] - bounds.maxX) < margin ||
    Math.abs(point[1] - bounds.minY) < margin || Math.abs(point[1] - bounds.maxY) < margin)).map(item => item.node);
  humanErrands = data.demandPlaces.filter(place => place.kind === 'shop' || place.kind === 'work');
  $('signal-count').textContent = signalNodes.size;
}

function signalIsRed(agent, nextNode, remaining) {
  if (!signalNodes.has(nextNode) || remaining > 7) return false;
  const a = data.nodes[agent.node], b = data.nodes[nextNode];
  const northSouth = Math.abs(b[1] - a[1]) >= Math.abs(b[0] - a[0]);
  const phase = Math.floor((simTime + (nextNode * 7) % 32) / 26) % 2;
  return (phase === 0 && !northSouth) || (phase === 1 && northSouth);
}

function lanePosition(agent) {
  if (!agent.links.length || !agent.route.length) return [agent.x, agent.y];
  const next = data.nodes[agent.route[0]], dx = next[0] - agent.x, dy = next[1] - agent.y;
  const length = Math.hypot(dx, dy) || 1;
  const offset = 3.2;
  return [agent.x - dy / length * offset, agent.y + dx / length * offset];
}

function agentKey(agent) { return `${agent.human ? 'H' : 'F'}${agent.id}`; }

function releaseIntersection(agent) {
  if (agent.reservedNode === undefined || agent.reservedNode === null) return;
  if (intersectionReservations.get(agent.reservedNode) === agentKey(agent)) intersectionReservations.delete(agent.reservedNode);
  agent.reservedNode = null;
}

function buildTrafficGrid() {
  trafficGrid = new Map();
  for (const agent of [...vehicles, ...humans]) {
    if (!agent.route.length || !agent.links.length) continue;
    const lane = agent.links[0][5];
    if (!trafficGrid.has(lane)) trafficGrid.set(lane, []);
    trafficGrid.get(lane).push(agent);
  }
}

function avoidanceFactor(agent, isHuman) {
  if (!agent.route.length || (agent.recoveryUntil || 0) > simTime) return 1;
  const next = data.nodes[agent.route[0]], dx = next[0] - agent.x, dy = next[1] - agent.y;
  const length = Math.hypot(dx, dy) || 1, fx = dx / length, fy = dy / length;
  const [ax, ay] = lanePosition(agent);
  let nearest = 70;
  // Only cars in this exact directed lane can block this agent. Opposing and
  // crossing streams are handled by lane offsets and intersection reservations.
  for (const other of trafficGrid.get(agent.links[0][5]) || []) {
    if (other === agent || !other.links.length || !other.route.length) continue;
    const [ox, oy] = lanePosition(other);
    const rx = ox - ax, ry = oy - ay;
    const ahead = rx * fx + ry * fy, lateral = Math.abs(rx * fy - ry * fx);
    if (ahead > 0 && ahead < nearest && lateral < 4.5) nearest = ahead;
  }
  const yielding = nearest < 65;
  if (!isHuman) {
    if (yielding && !agent.yielding) fleetYieldCount++;
    agent.yielding = yielding;
  }
  return nearest < 10 ? 0 : nearest < 65 ? Math.max(0.12, (nearest - 10) / 55) : 1;
}

function createHumanDriver() {
  if (!boundaryNodes.length || !humanErrands.length) return null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const entry = boundaryNodes[Math.floor(Math.random() * boundaryNodes.length)];
    const errand = humanErrands[Math.floor(Math.random() * humanErrands.length)];
    let exit = boundaryNodes[Math.floor(Math.random() * boundaryNodes.length)];
    if (entry === errand.node || exit === errand.node) continue;
    const inbound = findRoute(entry, errand.node), outbound = findRoute(errand.node, exit);
    if (!inbound || !outbound || !inbound.links.length || !outbound.links.length) continue;
    const human = {
      id: nextHumanId++, human: true, node: entry, x: data.nodes[entry][0], y: data.nodes[entry][1],
      route: inbound.nodes.slice(1).concat(outbound.nodes.slice(1)),
      links: inbound.links.concat(outbound.links), errandRemaining: inbound.nodes.length - 1,
      state: 'toErrand', errandName: errand.name, dwell: 0, distance: 0, edgeIndex: -1, exited: false
    };
    humans.push(human); return human;
  }
  return null;
}

function arriveHumanNext(human) {
  human.node = human.route.shift(); human.links.shift();
  human.x = data.nodes[human.node][0]; human.y = data.nodes[human.node][1]; human.edgeIndex = -1;
  if (human.state === 'toErrand' && human.errandRemaining > 0) {
    human.errandRemaining--;
    if (human.errandRemaining === 0) { human.state = 'errand'; human.dwell = 120 + Math.random() * 240; }
  }
  if (!human.route.length && human.state === 'exiting') human.exited = true;
}

function recoverRoadAgent(agent, isHuman) {
  releaseIntersection(agent);
  const goal = agent.route[agent.route.length - 1];
  if (goal !== undefined) {
    const route = findRoute(agent.node, goal, false);
    if (route && route.links.length) {
      agent.route = route.nodes.slice(1); agent.links = route.links;
      if (!isHuman && agent.state === 'pickup') {
        const pickup = findRoute(agent.node, agent.request.origin, false);
        const ride = findRoute(agent.request.origin, agent.request.destination, false);
        if (pickup && ride) {
          agent.route = pickup.nodes.slice(1).concat(ride.nodes.slice(1));
          agent.links = pickup.links.concat(ride.links); agent.pickupRemaining = pickup.nodes.length - 1;
        }
      }
    }
  }
  agent.recoveryUntil = simTime + 15; agent.stuckTime = 0; recoveredVehicles++;
}

function advanceRoadAgent(agent, dt, isHuman = false) {
  if (!agent.route.length) { releaseIntersection(agent); return; }
  if (agent.reservedNode !== undefined && agent.reservedNode !== null) {
    const held = data.nodes[agent.reservedNode];
    if (Math.hypot(agent.x - held[0], agent.y - held[1]) > 16) releaseIntersection(agent);
  }
  const next = data.nodes[agent.route[0]];
  const remaining = Math.hypot(next[0] - agent.x, next[1] - agent.y);
  let rightOfWayFactor = 1;
  if (signalNodes.has(next) && remaining < 14 && (agent.recoveryUntil || 0) <= simTime) {
    const holder = intersectionReservations.get(next);
    if (!holder || holder === agentKey(agent)) { intersectionReservations.set(next, agentKey(agent)); agent.reservedNode = next; }
    else rightOfWayFactor = 0;
  }
  const signalFactor = signalIsRed(agent, next, remaining) ? 0 : 1;
  const avoidFactor = avoidanceFactor(agent, isHuman);
  let travel = dt * agent.links[0][2] / 3.6 * (isHuman ? 0.82 : 1) * signalFactor * avoidFactor * rightOfWayFactor;
  if (travel < 0.005) agent.stuckTime = (agent.stuckTime || 0) + dt;
  else agent.stuckTime = 0;
  if (agent.stuckTime > (isHuman ? 35 : 28)) recoverRoadAgent(agent, isHuman);
  let guard = 0;
  while (travel > 0 && agent.route.length && guard++ < 100) {
    const target = data.nodes[agent.route[0]];
    const dx = target[0] - agent.x, dy = target[1] - agent.y;
    const left = Math.hypot(dx, dy);
    if (left < 0.01) {
      if (isHuman) arriveHumanNext(agent); else arriveAtNext(agent);
      continue;
    }
    if (travel >= left) {
      agent.distance += left; travel -= left;
      if (isHuman) arriveHumanNext(agent); else arriveAtNext(agent);
    } else {
      agent.x += dx / left * travel; agent.y += dy / left * travel;
      agent.distance += travel; agent.edgeIndex = agent.links[0][5]; travel = 0;
    }
  }
}

function stepSimulation(dt) {
  simTime += dt;
  demandAccumulator += dt * demand / 3600;
  while (demandAccumulator >= 1) { createRequest(); demandAccumulator--; }
  humanAccumulator += dt * humanRate / 3600;
  while (humanAccumulator >= 1) { createHumanDriver(); humanAccumulator--; }
  dispatchRequests(); sampleQueue(); buildTrafficGrid();
  for (const vehicle of vehicles) advanceRoadAgent(vehicle, dt, false);
  for (const human of humans) {
    if (human.state === 'errand') {
      human.dwell -= dt;
      if (human.dwell <= 0) human.state = 'exiting';
    } else advanceRoadAgent(human, dt, true);
  }
  const activeHumans = humans.filter(human => !human.exited);
  humanExits += humans.length - activeHumans.length; humans = activeHumans;
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const oldWidth = camera.width, oldHeight = camera.height;
  camera.width = Math.max(1, rect.width); camera.height = Math.max(1, rect.height);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(camera.width * dpr); canvas.height = Math.round(camera.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (data && (oldWidth <= 1 || oldHeight <= 1)) fitMap();
  else if (data) {
    const zoomRatio = camera.scale / camera.fit;
    const bounds = dataBounds();
    const padding = camera.width < 600 ? 22 : 45;
    camera.fit = Math.min((camera.width - padding * 2) / (bounds.maxX - bounds.minX),
                          (camera.height - padding * 2) / (bounds.maxY - bounds.minY));
    camera.scale = camera.fit * zoomRatio;
    updateZoomLabel();
  }
}

function worldToScreen(x, y) {
  return [(x - camera.x) * camera.scale + camera.width / 2,
          (y - camera.y) * camera.scale + camera.height / 2];
}
function screenToWorld(x, y) {
  return [(x - camera.width / 2) / camera.scale + camera.x,
          (y - camera.height / 2) / camera.scale + camera.y];
}
function fitMap() {
  if (!data) return;
  const bounds = dataBounds();
  const padding = camera.width < 600 ? 22 : 45;
  camera.fit = Math.min((camera.width - padding * 2) / (bounds.maxX - bounds.minX),
                        (camera.height - padding * 2) / (bounds.maxY - bounds.minY));
  camera.scale = camera.fit;
  camera.x = (bounds.minX + bounds.maxX) / 2;
  camera.y = (bounds.minY + bounds.maxY) / 2;
  following = false;
  setActiveView('all');
  updateZoomLabel();
}
let cachedBounds;
function dataBounds() {
  if (cachedBounds) return cachedBounds;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of data.nodes) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  return cachedBounds = { minX, minY, maxX, maxY };
}
function zoomAt(factor, sx = camera.width / 2, sy = camera.height / 2) {
  if (!data) return;
  const before = screenToWorld(sx, sy);
  camera.scale = Math.max(camera.fit * 0.45, Math.min(4, camera.scale * factor));
  const after = screenToWorld(sx, sy);
  camera.x += before[0] - after[0]; camera.y += before[1] - after[1];
  following = false; updateZoomLabel();
}
function updateZoomLabel() { $('zoom-level').textContent = `${Math.round(camera.scale / camera.fit * 100)}%`; }
function setActiveView(name) {
  document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  const labels = { all: 'DOWNTOWN + BOTH CAMPUS BANKS', downtown: 'DOWNTOWN MINNEAPOLIS', west: 'UNIVERSITY · WEST BANK', east: 'UNIVERSITY · EAST BANK' };
  $('view-label').textContent = labels[name] || 'CUSTOM STREET VIEW';
}
function goToView(name) {
  if (name === 'all') { fitMap(); return; }
  const placeNames = { downtown: 'Minneapolis City Hall', west: 'West Bank', east: 'Coffman Memorial Union' };
  const place = data.places.find(p => p.name === placeNames[name]);
  camera.x = data.nodes[place.node][0]; camera.y = data.nodes[place.node][1];
  camera.scale = camera.fit * 3.6; following = false; setActiveView(name); updateZoomLabel();
}

function pathPolygon(points) {
  ctx.beginPath();
  for (let i = 0; i < points.length; i += 2) {
    const [sx, sy] = worldToScreen(points[i], points[i + 1]);
    if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
  }
  ctx.closePath();
}
function renderMap() {
  ctx.fillStyle = '#080d16'; ctx.fillRect(0, 0, camera.width, camera.height);
  if (!data) return;
  const topLeft = screenToWorld(-80, -80), bottomRight = screenToWorld(camera.width + 80, camera.height + 80);
  const zoomRatio = camera.scale / camera.fit;
  if (layers.water) {
    ctx.fillStyle = '#0d2535'; ctx.strokeStyle = '#174156'; ctx.lineWidth = 1;
    for (const polygon of data.water) {
      const flat = polygon.flat(); pathPolygon(flat); ctx.fill(); ctx.stroke();
    }
  }
  if (layers.buildings && zoomRatio > 0.65) {
    ctx.fillStyle = zoomRatio > 2 ? '#182335' : '#111c2b';
    ctx.strokeStyle = '#223149'; ctx.lineWidth = 0.55;
    for (const building of data.buildings) {
      const p = building.p;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (let i = 0; i < p.length; i += 2) {
        minX = Math.min(minX, p[i]); maxX = Math.max(maxX, p[i]);
        minY = Math.min(minY, p[i + 1]); maxY = Math.max(maxY, p[i + 1]);
      }
      if (maxX < topLeft[0] || minX > bottomRight[0] || maxY < topLeft[1] || minY > bottomRight[1]) continue;
      pathPolygon(p); ctx.fill(); if (zoomRatio > 2.3) ctx.stroke();
    }
  }
  if (layers.roads) {
    visibleRoads = 0;
    const traffic = layers.traffic && zoomRatio > 0.85;
    for (let i = 0; i < data.edges.length; i++) {
      const edge = data.edges[i], a = data.nodes[edge[0]], b = data.nodes[edge[1]];
      if (Math.max(a[0], b[0]) < topLeft[0] || Math.min(a[0], b[0]) > bottomRight[0] ||
          Math.max(a[1], b[1]) < topLeft[1] || Math.min(a[1], b[1]) > bottomRight[1]) continue;
      if (zoomRatio < 1.25 && edge[3] === 3) continue;
      const p1 = worldToScreen(a[0], a[1]), p2 = worldToScreen(b[0], b[1]);
      ctx.beginPath(); ctx.moveTo(...p1); ctx.lineTo(...p2);
      ctx.strokeStyle = ROAD_COLORS[edge[3]];
      ctx.lineWidth = Math.max(0.55, [2.2, 1.8, 1.25, 0.8][edge[3]] * Math.min(zoomRatio, 3));
      ctx.stroke(); visibleRoads++;
      if (traffic) {
        const load = Math.min(5, pressure[i] + pressure[i + data.edges.length]);
        if (load > 0) {
          ctx.strokeStyle = load > 2.5 ? '#f87171' : load > 1 ? '#fbbf24' : '#22d3ee';
          ctx.globalAlpha = 0.28 + load * 0.1;
          ctx.lineWidth = 2 + Math.min(load, 3); ctx.stroke(); ctx.globalAlpha = 1;
        }
      }
    }
  }
  drawRequests(zoomRatio);
  drawPlaces(zoomRatio);
  if (layers.labels && zoomRatio > 1.8) drawBuildingLabels(zoomRatio);
  drawTransitHub(zoomRatio);
  if (layers.labels && zoomRatio > 2.4) drawStreetLabels();
  if (layers.signals && zoomRatio > 2.1) drawTrafficSignals();
  if (layers.humans) drawHumanDrivers(zoomRatio);
  drawVehicles(zoomRatio);
  $('render-stats').textContent = `${visibleRoads.toLocaleString()} SEGMENTS · ${Math.round(camera.scale * 100) / 100} px/m`;
  updateScale();
}
let buildingLabelCache = null;
function prepareBuildingLabels() {
  const dorms = new Set(data.demandPlaces.filter(place => place.kind === 'dorm').map(place => place.name));
  const demandByName = new Map(data.demandPlaces.map(place => [place.name, place]));
  buildingLabelCache = data.buildings.filter(building => building.n).map(building => {
    const p = building.p;
    const cx = p.filter((_, i) => i % 2 === 0).reduce((a, b) => a + b, 0) / (p.length / 2);
    const cy = p.filter((_, i) => i % 2 !== 0).reduce((a, b) => a + b, 0) / (p.length / 2);
    const demand = demandByName.get(building.n);
    const dorm = dorms.has(building.n);
    return {
      name: building.n, x: cx, y: cy,
      kind: dorm ? 'dorm' : demand ? demand.kind : building.k,
      priority: dorm ? 0 : ['campus', 'work', 'shop', 'apartment', 'townhome'].includes(demand?.kind) ? 1 : 2
    };
  }).sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
}
function drawBuildingLabels(zoomRatio) {
  const occupied = [];
  let drawn = 0;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const building of buildingLabelCache) {
    if (zoomRatio < 2.8 && building.priority === 2) continue;
    if (zoomRatio < 4.2 && building.priority === 1 && drawn > 20) continue;
    if (drawn >= 48) break;
    const p = worldToScreen(building.x, building.y);
    if (p[0] < 40 || p[1] < 40 || p[0] > camera.width - 40 || p[1] > camera.height - 40) continue;
    const name = building.name.toUpperCase();
    const fontSize = building.kind === 'dorm' ? 11 : 9;
    ctx.font = `${building.kind === 'dorm' ? '600 ' : ''}${fontSize}px IBM Plex Mono, monospace`;
    const words = name.split(' '), lines = [];
    let line = '';
    for (const word of words) {
      if (line && ctx.measureText(line + ' ' + word).width > 150) { lines.push(line); line = word; }
      else line = line ? line + ' ' + word : word;
    }
    if (line) lines.push(line);
    if (lines.length > 2) { lines[1] = lines.slice(1).join(' '); lines.length = 2; }
    const width = Math.max(...lines.map(text => ctx.measureText(text).width)) + 10;
    const height = lines.length * (fontSize + 2) + 6;
    const box = { x: p[0] - width / 2, y: p[1] - height / 2, w: width, h: height };
    if (occupied.some(other => box.x < other.x + other.w + 4 && box.x + box.w + 4 > other.x && box.y < other.y + other.h + 4 && box.y + box.h + 4 > other.y)) continue;
    occupied.push(box);
    ctx.fillStyle = building.kind === 'dorm' ? '#111c24ed' : '#08101cdd';
    ctx.fillRect(box.x, box.y, box.w, box.h);
    if (building.kind === 'dorm') { ctx.strokeStyle = '#fbbf2466'; ctx.lineWidth = 1; ctx.strokeRect(box.x, box.y, box.w, box.h); }
    ctx.fillStyle = building.kind === 'dorm' ? '#fde68a' : ['apartment', 'townhome', 'home'].includes(building.kind) ? '#b9c9d9' : '#91a9bf';
    lines.forEach((text, index) => ctx.fillText(text, p[0], p[1] + (index - (lines.length - 1) / 2) * (fontSize + 2)));
    drawn++;
  }
}
function drawTransitHub(zoomRatio) {
  const hub = transitHub(), p = worldToScreen(...data.nodes[hub.node]);
  if (p[0] < -60 || p[1] < -60 || p[0] > camera.width + 60 || p[1] > camera.height + 60) return;
  ctx.beginPath(); ctx.arc(p[0], p[1], zoomRatio > 2 ? 11 : 8, 0, Math.PI * 2);
  ctx.fillStyle = '#07101c'; ctx.fill(); ctx.strokeStyle = '#22d3ee'; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.fillStyle = '#22d3ee'; ctx.font = '600 9px IBM Plex Mono, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('H', p[0], p[1]);
  if (layers.labels && zoomRatio > 1.15) {
    ctx.font = '600 9px IBM Plex Mono, monospace'; ctx.textBaseline = 'top';
    ctx.fillStyle = '#07101c'; ctx.fillText('CENTRAL TRANSIT HUB', p[0] + 1, p[1] + 15);
    ctx.fillStyle = '#a5f3fc'; ctx.fillText('CENTRAL TRANSIT HUB', p[0], p[1] + 14);
  }
}
function drawRequests(zoomRatio) {
  if (!layers.requests) return;
  let drawn = 0;
  for (const request of requests) {
    if (drawn >= 300) break;
    const p = worldToScreen(...data.nodes[request.origin]);
    if (p[0] < -15 || p[1] < -15 || p[0] > camera.width + 15 || p[1] > camera.height + 15) continue;
    const pulse = 3 + ((simTime - request.created) % 12) / 12 * 5;
    ctx.beginPath(); ctx.arc(p[0], p[1], pulse, 0, Math.PI * 2);
    ctx.strokeStyle = '#fbbf24'; ctx.globalAlpha = Math.max(0.2, 1 - (pulse - 3) / 7);
    ctx.lineWidth = 1.4; ctx.stroke();
    ctx.beginPath(); ctx.arc(p[0], p[1], 2.2, 0, Math.PI * 2);
    ctx.fillStyle = '#fbbf24'; ctx.globalAlpha = 1; ctx.fill(); drawn++;
  }
  ctx.globalAlpha = 1;
}
function drawPlaces(zoomRatio) {
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (const place of data.places) {
    if (place.name === 'Nicollet & 7th') continue;
    const p = worldToScreen(...data.nodes[place.node]);
    if (p[0] < -30 || p[1] < -30 || p[0] > camera.width + 30 || p[1] > camera.height + 30) continue;
    const color = place.kind === 'campus' ? '#fbbf24' : place.kind === 'home' ? '#34d399' : '#22d3ee';
    ctx.beginPath(); ctx.arc(p[0], p[1], zoomRatio > 2 ? 5 : 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#07101c'; ctx.fill(); ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
    if (layers.labels && (zoomRatio > 1.25 || ['Target Field', 'Minneapolis City Hall', 'West Bank', 'Northrop', 'Huntington Bank Stadium'].includes(place.name))) {
      ctx.font = `${zoomRatio > 2 ? 11 : 9}px IBM Plex Mono, monospace`;
      ctx.fillStyle = '#07101c'; ctx.fillText(place.name.toUpperCase(), p[0] + 1, p[1] + 9);
      ctx.fillStyle = '#d6e0ee'; ctx.fillText(place.name.toUpperCase(), p[0], p[1] + 8);
    }
  }
  if (layers.labels && zoomRatio < 2.4) {
    ctx.font = '600 12px IBM Plex Mono, monospace'; ctx.fillStyle = '#64748b'; ctx.textBaseline = 'middle';
    for (const label of data.labels) {
      const p = worldToScreen(label.x, label.y);
      ctx.fillText(label.text, p[0], p[1]);
    }
  }
}
function drawStreetLabels() {
  const drawn = new Set();
  ctx.font = '9px IBM Plex Mono, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let i = 0; i < data.edges.length; i += 9) {
    const e = data.edges[i];
    if (e[6] < 0 || e[2] < 100 || drawn.has(e[6])) continue;
    const a = data.nodes[e[0]], b = data.nodes[e[1]];
    const mid = worldToScreen((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
    if (mid[0] < 50 || mid[1] < 50 || mid[0] > camera.width - 50 || mid[1] > camera.height - 50) continue;
    drawn.add(e[6]);
    const name = data.streetNames[e[6]].toUpperCase();
    ctx.save(); ctx.translate(...mid);
    let angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
    if (angle > Math.PI / 2 || angle < -Math.PI / 2) angle += Math.PI;
    ctx.rotate(angle); ctx.fillStyle = '#07101c'; ctx.fillText(name, 1, 1);
    ctx.fillStyle = '#91a0b7'; ctx.fillText(name, 0, 0); ctx.restore();
    if (drawn.size > 24) break;
  }
}
function drawTrafficSignals() {
  for (const node of signalNodes) {
    const p = worldToScreen(...data.nodes[node]);
    if (p[0] < 5 || p[1] < 5 || p[0] > camera.width - 5 || p[1] > camera.height - 5) continue;
    const phase = Math.floor((simTime + (node * 7) % 32) / 26) % 2;
    ctx.fillStyle = '#07101c'; ctx.fillRect(p[0] - 3, p[1] - 3, 6, 6);
    ctx.fillStyle = phase === 0 ? '#34d399' : '#f87171'; ctx.fillRect(p[0] - 1.5, p[1] - 1.5, 3, 3);
  }
}
function drawHumanDrivers(zoomRatio) {
  for (const human of humans) {
    const p = worldToScreen(...lanePosition(human));
    if (p[0] < -20 || p[1] < -20 || p[0] > camera.width + 20 || p[1] > camera.height + 20) continue;
    const size = 6 * Math.min(1.4, Math.max(0.8, zoomRatio / 2));
    ctx.save(); ctx.translate(...p);
    if (human.route.length && human.state !== 'errand') {
      const next = data.nodes[human.route[0]]; ctx.rotate(Math.atan2(next[1] - human.y, next[0] - human.x));
    }
    ctx.fillStyle = '#f97316'; ctx.fillRect(-size / 2, -size * 0.35, size, size * 0.7);
    ctx.fillStyle = '#fff7ed'; ctx.fillRect(-size * 0.2, -size * 0.23, size * 0.25, size * 0.46);
    if (human.state === 'errand') { ctx.strokeStyle = '#fed7aa'; ctx.lineWidth = 1; ctx.strokeRect(-size, -size, size * 2, size * 2); }
    ctx.restore();
  }
}
function drawVehicles(zoomRatio) {
  for (const vehicle of vehicles) {
    const p = worldToScreen(...lanePosition(vehicle));
    if (p[0] < -20 || p[1] < -20 || p[0] > camera.width + 20 || p[1] > camera.height + 20) continue;
    const type = TYPE[vehicle.type], size = type.width * Math.min(1.3, Math.max(0.65, zoomRatio / 2));
    ctx.save(); ctx.translate(...p);
    if (vehicle.route.length) {
      const next = data.nodes[vehicle.route[0]];
      ctx.rotate(Math.atan2(next[1] - vehicle.y, next[0] - vehicle.x));
    }
    if (vehicle.id === selectedVehicle) {
      ctx.beginPath(); ctx.arc(0, 0, size + 6, 0, Math.PI * 2); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke();
    }
    ctx.fillStyle = vehicle.state === 'idle' ? '#718198' : type.color;
    ctx.fillRect(-size / 2, -size * 0.32, size, size * 0.64);
    ctx.fillStyle = '#06101a'; ctx.fillRect(size * 0.1, -size * 0.22, size * 0.2, size * 0.44);
    ctx.restore();
  }
}
function updateScale() {
  const meters = camera.width < 600 ? 500 : 1000;
  $('scale-label').textContent = `${meters >= 1000 ? meters / 1000 + ' km' : meters + ' m'} · ${Math.round(meters * camera.scale)} px`;
}

function resizeQueueChart() {
  const rect = queueCanvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  queueCanvas.width = Math.max(1, Math.round(rect.width * dpr));
  queueCanvas.height = Math.max(1, Math.round(rect.height * dpr));
  queueCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawQueueChart() {
  const width = queueCanvas.clientWidth, height = queueCanvas.clientHeight;
  if (!width || !height) return;
  queueCtx.clearRect(0, 0, width, height);
  queueCtx.fillStyle = '#080e18'; queueCtx.fillRect(0, 0, width, height);
  const left = 28, right = 8, top = 18, bottom = 16;
  const plotWidth = Math.max(1, width - left - right), plotHeight = Math.max(1, height - top - bottom);
  const yMax = Math.max(10, Math.ceil(Math.max(maxQueued, 1) / 10) * 10);
  const start = Math.max(0, simTime - 1800), end = Math.max(start + 60, simTime);
  const x = time => left + (time - start) / (end - start) * plotWidth;
  const y = value => top + (1 - value / yMax) * plotHeight;
  queueCtx.font = '8px IBM Plex Mono, monospace'; queueCtx.textBaseline = 'middle';
  for (const fraction of [0, 0.5, 1]) {
    const value = Math.round(yMax * fraction), py = y(value);
    queueCtx.beginPath(); queueCtx.moveTo(left, py); queueCtx.lineTo(width - right, py);
    queueCtx.strokeStyle = '#19263a'; queueCtx.lineWidth = 1; queueCtx.stroke();
    queueCtx.fillStyle = '#718098'; queueCtx.textAlign = 'right'; queueCtx.fillText(String(value), left - 5, py);
  }
  const points = queueHistory.filter(point => point.time >= start);
  if (points.length) {
    queueCtx.beginPath(); queueCtx.moveTo(x(start), y(0));
    for (const point of points) queueCtx.lineTo(x(point.time), y(point.value));
    queueCtx.lineTo(x(points[points.length - 1].time), y(0)); queueCtx.closePath();
    queueCtx.fillStyle = '#22d3ee18'; queueCtx.fill();
    queueCtx.beginPath();
    points.forEach((point, index) => { if (!index) queueCtx.moveTo(x(point.time), y(point.value)); else queueCtx.lineTo(x(point.time), y(point.value)); });
    queueCtx.strokeStyle = '#22d3ee'; queueCtx.lineWidth = 1.8; queueCtx.lineJoin = 'round'; queueCtx.stroke();
    const last = points[points.length - 1];
    queueCtx.beginPath(); queueCtx.arc(x(last.time), y(last.value), 3, 0, Math.PI * 2);
    queueCtx.fillStyle = '#22d3ee'; queueCtx.fill();
  }
  const peakY = y(maxQueued);
  queueCtx.beginPath(); queueCtx.moveTo(left, peakY); queueCtx.lineTo(width - right, peakY);
  queueCtx.setLineDash([5, 4]); queueCtx.strokeStyle = '#fbbf24'; queueCtx.lineWidth = 1.2; queueCtx.stroke(); queueCtx.setLineDash([]);
  queueCtx.fillStyle = '#fbbf24'; queueCtx.textAlign = 'right'; queueCtx.textBaseline = 'bottom';
  queueCtx.fillText(`RUN PEAK ${maxQueued}`, width - right, Math.max(9, peakY - 3));
  $('queue-start-time').textContent = formatTime(start).slice(0, 5);
  $('queue-end-time').textContent = formatTime(simTime).slice(0, 5);
}

function updatePressure() {
  pressure.fill(0);
  for (const vehicle of vehicles) if (vehicle.edgeIndex >= 0) pressure[vehicle.edgeIndex[5]] += 1;
  for (const human of humans) if (human.edgeIndex >= 0) pressure[human.edgeIndex[5]] += 1;
}
function updateUI() {
  updatePressure();
  $('sim-time').textContent = formatTime(simTime);
  $('run-status').textContent = running ? 'LIVE' : 'PAUSED';
  $('run-status').style.color = running ? '#34d399' : '#fbbf24';
  $('vehicle-count').textContent = `${vehicles.length} vehicles`;
  $('fleet-output').textContent = `${vehicles.length} vehicles`;
  $('fleet-total-legend').textContent = `${vehicles.length} VEHICLES`;
  for (let type = 0; type < TYPE.length; type++) {
    const id = ['sedan', 'shuttle', 'bus'][type];
    $(id + '-count').textContent = vehicles.filter(vehicle => vehicle.type === type).length;
  }
  $('hub-count').textContent = vehicles.filter(vehicle => vehicle.state === 'idle' && vehicle.node === transitHub().node).length;
  $('completed').textContent = completed;
  $('human-active').textContent = humans.length;
  $('human-layer-count').textContent = humans.length;
  $('fleet-yields').textContent = fleetYieldCount;
  $('queued').textContent = requests.length;
  $('queue-current').textContent = requests.length;
  $('queue-peak').textContent = maxQueued;
  $('avg-ride').textContent = completed ? (rideTotal / completed / 60).toFixed(1) : '—';
  const picked = vehicles.filter(v => v.request && v.request.pickup !== null).length + completed;
  $('avg-wait').textContent = picked ? (waitTotal / picked / 60).toFixed(1) : '—';
  const activePressure = Array.from(pressure).reduce((a, b) => a + b, 0);
  const ratio = vehicles.length ? activePressure / vehicles.length : 0;
  $('pressure-value').textContent = ratio.toFixed(2);
  $('pressure-bar').style.width = `${Math.min(100, ratio * 100)}%`;
  $('pressure-bar').style.background = ratio > 0.5 ? '#f87171' : ratio > 0.25 ? '#fbbf24' : '#22d3ee';
  if (selectedVehicle) {
    const v = vehicles.find(item => item.id === selectedVehicle);
    if (!v) { selectedVehicle = null; $('vehicle-card').hidden = true; }
    else {
      const type = TYPE[v.type];
      $('vehicle-name').textContent = `${type.name} ${String(v.id).padStart(2, '0')}`;
      const destination = v.request ? (v.state === 'pickup' ? v.request.originName : v.request.destinationName) : 'Available';
      $('vehicle-detail').textContent = `${v.yielding ? 'FOLLOWING LANE TRAFFIC · ' : ''}${v.state.toUpperCase()} · ${v.onboard}/${type.cap} riders · ${destination} · ${(v.distance / 1000).toFixed(1)} km`;
      $('follow-vehicle').textContent = following ? 'Stop following' : 'Follow vehicle';
    }
  }
}

function frame(timestamp) {
  const realDt = Math.min(0.1, (timestamp - lastFrame) / 1000 || 0); lastFrame = timestamp;
  if (data && running) {
    accumulator += realDt * SPEEDS[speedIndex];
    let guard = 0;
    while (accumulator >= 0.25 && guard++ < 100) { stepSimulation(0.25); accumulator -= 0.25; }
  }
  if (following && selectedVehicle) {
    const v = vehicles.find(item => item.id === selectedVehicle);
    if (v) { camera.x = v.x; camera.y = v.y; }
  }
  renderMap();
  if (timestamp - lastUI > 200) { if (data) { updateUI(); drawQueueChart(); } lastUI = timestamp; }
  requestAnimationFrame(frame);
}

function populatePlaces() {
  renderPlaceList('');
}
function renderPlaceList(filter) {
  const fragment = document.createDocumentFragment();
  data.places.forEach(place => {
    if (!place.name.toLowerCase().includes(filter.toLowerCase())) return;
    const button = document.createElement('button');
    button.className = 'place-button'; button.dataset.kind = place.kind;
    const dot = document.createElement('i'), name = document.createElement('span'), kind = document.createElement('small');
    name.textContent = place.name; kind.textContent = place.kind.toUpperCase();
    button.append(dot, name, kind);
    button.addEventListener('click', () => {
      const node = data.nodes[place.node]; camera.x = node[0]; camera.y = node[1];
      camera.scale = Math.max(camera.scale, camera.fit * 2.5); following = false; updateZoomLabel();
      if (camera.width < 600) $('map-shell').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    fragment.append(button);
  });
  $('place-list').replaceChildren(fragment);
}

function bindEvents() {
  $('open-guide').addEventListener('click', () => $('guide').showModal());
  $('close-guide').addEventListener('click', () => $('guide').close());
  $('guide').addEventListener('click', e => { if (e.target === $('guide')) $('guide').close(); });
  $('zoom-in').addEventListener('click', () => zoomAt(1.35));
  $('zoom-out').addEventListener('click', () => zoomAt(1 / 1.35));
  $('fit-map').addEventListener('click', fitMap);
  document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => goToView(b.dataset.view)));
  document.querySelectorAll('[data-layer]').forEach(input => input.addEventListener('change', () => { layers[input.dataset.layer] = input.checked; }));
  $('place-search').addEventListener('input', e => renderPlaceList(e.target.value));
  $('pause').addEventListener('click', () => { running = !running; $('pause').textContent = running ? 'Pause' : 'Resume'; updateUI(); });
  $('reset').addEventListener('click', () => { resetSimulation(); fitMap(); notify('Service day reset. Camera fitted to the full area.'); });
  $('speed').addEventListener('input', e => {
    speedIndex = Number(e.target.value); const label = [1, 4, 12][speedIndex] + '×';
    $('speed-output').value = label; $('speed-readout').textContent = label;
  });
  document.querySelectorAll('[data-fleet-type]').forEach(input => {
    input.addEventListener('input', () => { $(input.id + '-output').value = input.value; });
    input.addEventListener('change', () => {
      const type = Number(input.dataset.fleetType), next = Number(input.value);
      const current = vehicles.filter(vehicle => vehicle.type === type);
      if (next > current.length) {
        for (let i = current.length; i < next; i++) vehicles.push(newVehicle(type));
      } else if (next < current.length) {
        const removeIds = new Set(current.slice(next).map(vehicle => vehicle.id));
        const removed = vehicles.filter(vehicle => removeIds.has(vehicle.id));
        vehicles = vehicles.filter(vehicle => !removeIds.has(vehicle.id));
        for (const vehicle of removed) if (vehicle.request) requests.push(vehicle.request);
      }
      fleetCounts[type] = next;
      if (selectedVehicle && !vehicles.some(vehicle => vehicle.id === selectedVehicle)) {
        selectedVehicle = null; following = false; $('vehicle-card').hidden = true;
      }
      sampleQueue(true);
      logActivity(`${TYPE[type].name} fleet adjusted to ${next}; ${vehicles.length} vehicles total`);
      updateUI();
    });
  });
  $('demand').addEventListener('input', e => { demand = Number(e.target.value); $('demand-output').value = `${demand} trips/h`; });
  $('human-rate').addEventListener('input', e => { humanRate = Number(e.target.value); $('human-rate-output').value = `${humanRate} cars/h`; });
  $('congestion-routing').addEventListener('change', e => { congestionRouting = e.target.checked; });
  $('clear-log').addEventListener('click', () => $('activity-log').replaceChildren());
  $('close-vehicle').addEventListener('click', () => { selectedVehicle = null; following = false; $('vehicle-card').hidden = true; });
  $('follow-vehicle').addEventListener('click', () => { following = !following; if (following) camera.scale = Math.max(camera.scale, camera.fit * 3); updateUI(); });

  canvas.addEventListener('wheel', e => {
    e.preventDefault(); const rect = canvas.getBoundingClientRect();
    zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false });
  canvas.addEventListener('pointerdown', e => {
    canvas.setPointerCapture(e.pointerId); pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); dragged = false;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()]; pinchStart = { distance: Math.hypot(a.x - b.x, a.y - b.y), scale: camera.scale };
    }
  });
  canvas.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId)) return;
    const previous = pointers.get(e.pointerId); pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2 && pinchStart) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const rect = canvas.getBoundingClientRect();
      zoomAt(pinchStart.scale * distance / pinchStart.distance / camera.scale,
        (a.x + b.x) / 2 - rect.left, (a.y + b.y) / 2 - rect.top); dragged = true;
    } else if (pointers.size === 1) {
      const dx = e.clientX - previous.x, dy = e.clientY - previous.y;
      if (Math.abs(dx) + Math.abs(dy) > 1) dragged = true;
      camera.x -= dx / camera.scale; camera.y -= dy / camera.scale; following = false;
    }
  });
  const release = e => {
    pointers.delete(e.pointerId); if (pointers.size < 2) pinchStart = null;
    if (!dragged && e.type === 'pointerup') selectVehicleAt(e);
  };
  canvas.addEventListener('pointerup', release); canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('keydown', e => {
    if (e.key === '+' || e.key === '=') zoomAt(1.3);
    else if (e.key === '-') zoomAt(1 / 1.3);
    else if (e.key === '0') fitMap();
    else if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault(); const delta = 80 / camera.scale;
      if (e.key === 'ArrowUp') camera.y -= delta; if (e.key === 'ArrowDown') camera.y += delta;
      if (e.key === 'ArrowLeft') camera.x -= delta; if (e.key === 'ArrowRight') camera.x += delta;
    }
  });
  new ResizeObserver(resizeCanvas).observe(canvas);
  new ResizeObserver(resizeQueueChart).observe(queueCanvas);
}
function selectVehicleAt(e) {
  const rect = canvas.getBoundingClientRect(), x = e.clientX - rect.left, y = e.clientY - rect.top;
  let closest = null, best = 18;
  for (const vehicle of vehicles) {
    const p = worldToScreen(vehicle.x, vehicle.y), distance = Math.hypot(p[0] - x, p[1] - y);
    if (distance < best) { closest = vehicle; best = distance; }
  }
  if (closest) { selectedVehicle = closest.id; $('vehicle-card').hidden = false; updateUI(); }
}

async function init() {
  bindEvents(); resizeCanvas(); resizeQueueChart(); requestAnimationFrame(frame);
  try {
    const response = await fetch('data/minneapolis.json');
    if (!response.ok) throw new Error(`Dataset HTTP ${response.status}`);
    data = await response.json();
    adjacency = Array.from({ length: data.nodes.length }, () => []);
    edgeLookup = [];
    data.edges.forEach((e, i) => {
      const forward = [e[1], e[2], e[5], e[3], i, i];
      edgeLookup.push(forward); adjacency[e[0]].push(edgeLookup.length - 1);
      if (!e[4]) {
        const reverse = [e[0], e[2], e[5], e[3], i + data.edges.length, i + data.edges.length];
        edgeLookup.push(reverse); adjacency[e[1]].push(edgeLookup.length - 1);
      }
    });
    pressure = new Float32Array(edgeLookup.length);
    $('network-size').textContent = `${(data.stats.networkKilometers).toFixed(0)} km`;
    $('road-count').textContent = data.edges.length.toLocaleString();
    $('building-count').textContent = data.buildings.length.toLocaleString();
    $('place-count').textContent = data.places.length;
    $('demand-site-total').textContent = data.demandPlaces.length;
    populatePlaces(); prepareBuildingLabels(); prepareTrafficModel(); fitMap(); resetSimulation();
    $('map-empty').hidden = true;
    logActivity(`${data.stats.networkKilometers.toFixed(0)} km directed street network loaded`);
  } catch (error) {
    console.error(error);
    $('map-empty').innerHTML = '<strong>Unable to load the street dataset</strong><span>Serve this folder over HTTP and reload.</span>';
    $('run-status').textContent = 'DATA ERROR'; $('run-status').style.color = '#f87171';
  }
}
init();
