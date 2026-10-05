import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './style.css';
import raw from './demo-trips.json';
import {
  validateTrips, tripWindow, interpolateTrack, platformView, tripStatus, segments, fmtClock, fmtDuration, toCsv, MODE_NAMES
} from './model.js';

const clean = v => String(v ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const asset = f => `${import.meta.env.BASE_URL}brand/${f}`;
const SEV = { critical: '#ff2a2a', high: '#ff8a3d', medium: '#f5c542', info: '#8d8d95' };
const LINK_COLORS = ['#2a2a2e', '#f2f2f3', '#ff2a2a', '#ff8a3d'];
const MODE_COLORS = ['#3a3a40', '#ff8a3d', '#ff2a2a'];
const LINK_LABELS = ['No link', 'Cellular', 'Fleet relay (mesh)', 'Satellite'];

const icons = {
  route: '<path d="M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/><path d="M8 17h5a3 3 0 0 0 0-6h-2a3 3 0 0 1 0-6h5"/>',
  alert: '<path d="m12 2 10 18H2L12 2z"/><path d="M12 9v4m0 4h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  box: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>',
  signal: '<path d="M2 20h.01M7 20v-4M12 20V10M17 20V4M22 20V8"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M4 17v4h16v-4"/>',
  play: '<path d="M7 4v16l13-8z"/>',
  pause: '<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>',
  grid: '<path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"/>'
};
const icon = (n, s = 18) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[n]}</svg>`;

let data = validateTrips(raw);
const params = new URLSearchParams(location.search);
let tripIdx = Math.min(Number(params.get('trip') ?? 0) || 0, data.trips.length - 1);
let now = 0;
let playing = false;
let timer = null;
let selectedEvent = null;
let map, staticLayer, dynLayer, corridorLine;

const trip = () => data.trips[tripIdx];

function shell() {
  document.querySelector('#app').innerHTML = `
  <div class="shell">
    <aside class="sidebar">
      <img class="logo" src="${asset('redline-logo-dark.svg')}" alt="Redline: Track, Predict, Survive" />
      <div class="side-label">SHIPMENTS</div>
      <div id="trip-list" class="trip-list"></div>
      <div class="side-label">VIEWS</div>
      <nav>
        <a href="#overview">${icon('grid')} Overview</a>
        <a href="#map-panel">${icon('route')} Map</a>
        <a href="#alerts-panel">${icon('alert')} Alerts</a>
        <a href="#comms-panel">${icon('signal')} Links and ETA</a>
        <a href="#blackbox-panel">${icon('box')} Black box</a>
      </nav>
      <div class="side-foot"><span class="stripe"></span>Open source · MIT firmware and software · CERN-OHL-P hardware</div>
    </aside>
    <main class="main" id="overview">
      <header class="topbar">
        <div class="crumb">REDLINE <i>/</i> CONTROL CENTER <i>/</i> <b id="crumb-trip"></b></div>
        <div class="top-actions"><span class="sim-pill"><i></i> SIMULATED SHIPMENTS</span><button id="export" class="btn">${icon('download', 16)} Export incident log</button></div>
      </header>
      <div class="content">
        <section class="hero">
          <div class="eyebrow"><span></span> TRACK · PREDICT · SURVIVE</div>
          <h1>Know where it is.<br />Know when it lands.<br /><em>Know what happened.</em></h1>
        </section>
        <section class="notice" role="note"><b>Simulation.</b> Route (OpenStreetMap) and weather (Open-Meteo) are real open data. Vehicles, the accident, the jammer, the thief and the fleet relays are simulated. Every device decision comes from the real firmware core.</section>
        <section id="trip-head" class="trip-head"></section>
        <section id="kpis" class="kpis"></section>
        <div class="grid">
          <section id="map-panel" class="panel map-panel">
            <div class="panel-head"><div><span class="kicker">LIVE MAP</span><h2>Position, corridor and relays</h2></div><div id="map-legend" class="legend"></div></div>
            <div id="map" role="img" aria-label="Map of the route, planned corridor, track and alerts"></div>
            <div class="map-foot" id="map-foot"></div>
          </section>
          <section id="alerts-panel" class="panel alerts-panel">
            <div class="panel-head"><div><span class="kicker">PLATFORM FEED</span><h2>Alerts <span id="alert-count" class="count"></span></h2></div></div>
            <div id="alerts" class="alerts"></div>
          </section>
        </div>
        <section class="panel replay">
          <div class="replay-row">
            <button id="play" class="play" aria-label="Play or pause the replay"></button>
            <div class="slider"><div id="ticks" class="ticks"></div><input id="time" type="range" min="0" max="1000" value="0" aria-label="Replay time" /></div>
            <div class="clock"><b id="clock"></b><small id="clock-sub"></small></div>
          </div>
        </section>
        <section id="comms-panel" class="panel comms"></section>
        <section id="blackbox-panel" class="panel blackbox"></section>
        <footer><span>REDLINE · TRACK · PREDICT · SURVIVE</span><span>OPEN SOURCE · NOT A PRODUCTION SYSTEM</span></footer>
      </div>
    </main>
  </div>`;
  document.querySelector('#export').addEventListener('click', exportLog);
  document.querySelector('#play').addEventListener('click', togglePlay);
  document.querySelector('#time').addEventListener('input', e => {
    const { start, end } = tripWindow(trip());
    now = start + (end - start) * Number(e.target.value) / 1000;
    render();
  });
}

function initMap() {
  map = L.map('map', { zoomControl: false, scrollWheelZoom: false, attributionControl: true });
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', maxZoom: 18
  }).addTo(map);
  staticLayer = L.layerGroup().addTo(map);
  dynLayer = L.layerGroup().addTo(map);
  map.on('zoomend', updateCorridorWeight);
}

function updateCorridorWeight() {
  if (!corridorLine) return;
  const mpp = 156543.03392 * Math.cos(47 * Math.PI / 180) / 2 ** map.getZoom();
  corridorLine.setStyle({ weight: Math.max(4, trip().plan.corridorM * 2 / mpp) });
}

function drawStatic() {
  const t = trip();
  staticLayer.clearLayers();
  corridorLine = L.polyline(t.route, { color: '#ff2a2a', weight: 8, opacity: 0.16, lineCap: 'round' }).addTo(staticLayer);
  L.polyline(t.route, { color: '#f2f2f3', weight: 2, opacity: 0.8, dashArray: '2 6' }).addTo(staticLayer);
  if (t.detour) L.polyline(t.detour, { color: '#ff8a3d', weight: 2, opacity: 0.35, dashArray: '4 6' }).addTo(staticLayer);
  for (const z of t.plan.zones) {
    L.circle([z.lat, z.lon], { radius: z.radiusM, color: '#3ddc84', weight: 1, fillOpacity: 0.12 }).bindTooltip(z.name).addTo(staticLayer);
  }
  for (const c of t.plan.checkpoints) {
    L.circleMarker([c.lat, c.lon], { radius: 5, color: '#f2f2f3', weight: 2, fillColor: '#0a0a0b', fillOpacity: 1 })
      .bindTooltip(`${c.name} · planned ${fmtClock(c.plannedMs)}`).addTo(staticLayer);
  }
  for (const i of t.incidents ?? []) {
    L.circleMarker([i.lat, i.lon], { radius: 14, color: '#f5c542', weight: 2, fillColor: '#f5c542', fillOpacity: 0.25 })
      .bindTooltip('Traffic situation: 20 km/h over 20 km (simulated)').addTo(staticLayer);
  }
  if (t.site) {
    L.circle([t.site.lat, t.site.lon], { radius: t.meshRangeM ?? 2000, color: '#ff2a2a', weight: 1, dashArray: '3 5', fillOpacity: 0.04 })
      .bindTooltip('Assumed fleet-relay range (to be measured)').addTo(staticLayer);
  }
  map.fitBounds(L.polyline(t.route).getBounds().pad(0.1));
  updateCorridorWeight();
}

function eventIcon(e, pending) {
  const color = SEV[e.severity];
  return L.divIcon({ className: `evt ${pending ? 'pending' : ''}`, html: `<span style="--c:${color}">!</span>`, iconSize: [26, 26], iconAnchor: [13, 13] });
}

function drawDynamic(view) {
  const t = trip();
  dynLayer.clearLayers();
  // Ground truth (simulation): grey, dashed where the GNSS fix was lost.
  const upto = t.track.filter(s => s.t <= now);
  let run = [];
  let runG = true;
  const flush = () => {
    if (run.length > 1) L.polyline(run, { color: runG ? '#8d8d95' : '#ff8a3d', weight: 2, opacity: 0.9, dashArray: runG ? null : '3 5' }).addTo(dynLayer);
  };
  for (const s of upto) {
    if (run.length && (s.g === 1) !== runG) { run.push([s.la, s.lo]); flush(); run = [[s.la, s.lo]]; runG = s.g === 1; }
    else { if (!run.length) runG = s.g === 1; run.push([s.la, s.lo]); }
  }
  flush();
  // What the platform knows: delivered reports, red.
  const pts = [...view.reports.map(r => [r.createdMs, r.lat, r.lon]),
    ...view.events.filter(e => e.via !== 'platform' && e.via !== 'open data').map(e => [e.t, e.lat, e.lon])].sort((a, b) => a[0] - b[0]);
  if (pts.length > 1) L.polyline(pts.map(p => [p[1], p[2]]), { color: '#ff2a2a', weight: 3, opacity: 0.95 }).addTo(dynLayer);
  for (const r of view.reports) L.circleMarker([r.lat, r.lon], { radius: 2.5, color: '#ff2a2a', weight: 0, fillColor: '#ff2a2a', fillOpacity: 1 }).addTo(dynLayer);

  for (const e of view.events) {
    if (e.severity === 'info' || !Number.isFinite(e.lat) || e.type === 'eta_slip' || e.type === 'silent') continue;
    const m = L.marker([e.lat, e.lon], { icon: eventIcon(e, false), zIndexOffset: 500 }).addTo(dynLayer);
    m.bindTooltip(`${fmtClock(e.t, true)} · ${e.title}`);
    m.on('click', () => selectEvent(e));
  }
  for (const e of view.pending) {
    L.marker([e.lat, e.lon], { icon: eventIcon(e, true) }).bindTooltip(`${e.title}: stored on the device, not delivered yet`).addTo(dynLayer);
  }

  // Fleet peers and the relay link while one is in range.
  const here = interpolateTrack(t.track, now);
  for (const p of t.peers ?? []) {
    if (now >= p.path[0][0]) L.polyline(p.path.map(q => [q[1], q[2]]), { color: '#f2f2f3', weight: 1.5, opacity: 0.35, dashArray: '2 5' }).addTo(dynLayer);
    if (now < p.path[0][0] || now > p.path[p.path.length - 1][0]) continue;
    let i = p.path.findIndex(q => q[0] >= now);
    i = Math.max(1, i < 0 ? p.path.length - 1 : i);
    const a = p.path[i - 1], b = p.path[i];
    const f = (now - a[0]) / (b[0] - a[0] || 1);
    const pos = [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
    L.circleMarker(pos, { radius: 7, color: '#f2f2f3', weight: 2, fillColor: '#0a0a0b', fillOpacity: 1 }).bindTooltip(`${p.label} (fleet truck)`).addTo(dynLayer);
    if (here.l === 2) L.polyline([[here.la, here.lo], pos], { color: '#ff2a2a', weight: 2, dashArray: '5 5' }).addTo(dynLayer);
  }
  // The vehicle itself.
  const dead = view.gasp || t.events.some(e => e.type === 'power_loss' && e.t <= now);
  L.marker([here.la, here.lo], {
    icon: L.divIcon({ className: 'veh', html: dead ? '<span class="dead">✕</span>' : `<span class="pulse ${here.m === 2 ? 'theft' : ''}"></span>`, iconSize: [28, 28], iconAnchor: [14, 14] }),
    zIndexOffset: 1000
  }).addTo(dynLayer);
}

function selectEvent(e) {
  selectedEvent = e;
  if (Number.isFinite(e.lat)) map.flyTo([e.lat, e.lon], Math.max(map.getZoom(), 9), { duration: 0.6 });
  render();
}

function legend() {
  return `<span><i style="background:#ff2a2a"></i>What the platform knows</span><span><i style="background:#8d8d95"></i>Vehicle (simulated truth)</span><span><i class="ring"></i>Planned corridor</span><span><i style="background:#ff8a3d"></i>No GNSS fix</span>`;
}

function renderTripList() {
  document.querySelector('#trip-list').innerHTML = data.trips.map((t, i) => {
    const st = tripStatus(t, i === tripIdx ? now : tripWindow(t).start + 1);
    return `<button class="trip-card ${i === tripIdx ? 'active' : ''}" data-i="${i}"><span class="trip-id">${clean(t.id)}</span><strong>${clean(t.title)}</strong><small>${clean(t.vehicle)} · ${clean(t.cargo)}</small><span class="chip ${st.tone}">${clean(st.label)}</span></button>`;
  }).join('');
  document.querySelectorAll('.trip-card').forEach(b => b.addEventListener('click', () => switchTrip(Number(b.dataset.i))));
}

function renderHead(view, status) {
  const t = trip();
  document.querySelector('#crumb-trip').textContent = t.id;
  const planned = t.plan.plannedEtaMs;
  document.querySelector('#trip-head').innerHTML = `
    <div class="th-main"><span class="kicker">SHIPMENT ${clean(t.id)} · DEVICE ${clean(t.device)}</span><h2>${clean(t.title)}</h2>
      <p>${clean(t.cargo)} · ${clean(t.vehicle)}</p>
      <div class="route-line"><b>${clean(t.origin)}</b><span><i></i><i></i></span><b>${clean(t.destination)}</b></div></div>
    <div class="th-side"><span class="chip big ${status.tone}">${clean(status.label)}</span>
      <dl><div><dt>Departure</dt><dd>${fmtClock(t.departMs)}</dd></div><div><dt>Planned arrival</dt><dd>${fmtClock(planned)}</dd></div>
      <div><dt>Distance</dt><dd>${t.stats?.distanceKm ?? 466} km</dd></div></dl></div>`;
}

function renderKpis(view, status) {
  const t = trip();
  const here = interpolateTrack(t.track, now);
  const planned = t.plan.plannedEtaMs;
  let k1;
  if (t.scenario === 'delay') {
    const done = t.arrivedMs && now >= t.arrivedMs;
    const eta = done ? t.arrivedMs : view.eta?.eta ?? planned;
    const late = Math.round((eta - planned) / 60e3);
    k1 = [done ? 'ARRIVED' : 'ESTIMATED ARRIVAL', fmtClock(eta), `${late >= 0 ? '+' : ''}${late} min vs plan (${fmtClock(planned)})`, late > 15 ? 'high' : ''];
  } else {
    const off = view.events.some(e => e.type === 'deviation_start');
    k1 = ['PLANNED ARRIVAL', fmtClock(planned), off ? 'Cannot be confirmed: cargo left the route' : 'On the planned route', off ? 'critical' : ''];
  }
  const rem = view.eta ? (view.eta.rem / 1000).toFixed(0) : null;
  const modeNow = view.mode;
  const lastHeard = view.lastHeard;
  const silent = view.silentForMs;
  const kp = [
    k1,
    ['DEVICE MODE (PLATFORM VIEW)', MODE_NAMES[modeNow].toUpperCase(), modeNow === 2 ? 'Reporting every 10 s on every channel' : modeNow === 1 ? 'Reporting every 60 s' : 'Reporting every 15 min', ['', 'high', 'critical'][modeNow]],
    ['LAST CONTACT', lastHeard ? fmtDuration(silent) + ' ago' : '—', lastHeard ? `via ${lastHeard.via === 'mesh' ? 'fleet relay' : lastHeard.via}` : 'nothing received yet', silent > 20 * 60e3 ? 'critical' : ''],
    t.scenario === 'delay'
      ? ['SPEED NOW', `${here.v} km/h`, rem ? `${rem} km left on ${t.stats.distanceKm} km` : '', '']
      : ['MESSAGES VIA FLEET RELAY', String(view.reports.filter(r => r.via === 'mesh').length + view.events.filter(e => e.via === 'mesh').length), `cellular ${here.l === 1 ? 'up' : 'down'} · GNSS ${here.g ? 'ok' : 'lost'}`, '']
  ];
  document.querySelector('#kpis').innerHTML = kp.map(([l, v, s, tone]) => `<article class="kpi ${tone}"><span>${l}</span><strong>${clean(v)}</strong><small>${clean(s)}</small></article>`).join('');
}

function renderAlerts(view) {
  const rows = view.events.filter(e => e.severity !== 'info' || ['checkpoint'].includes(e.type)).slice(0, 40);
  document.querySelector('#alert-count').textContent = view.events.filter(e => e.severity !== 'info').length;
  const pending = view.pending.slice(0, 4).map(e => `
    <div class="alert pending-card"><i class="dot" style="--c:${SEV[e.severity]}"></i><div><div class="a-top"><strong>${clean(e.title)}</strong><time>${fmtClock(e.t, true)}</time></div>
    <span>${e.type === 'power_loss' ? 'The device died before it could send this. The last gasp carries the news.' : 'Stored on the device. Waiting for a link.'}</span><div class="badges"><span class="badge wait">NOT DELIVERED</span></div></div></div>`).join('');
  const body = rows.map(e => {
    const lag = e.deliveredMs && e.via !== 'platform' && e.via !== 'open data' ? e.deliveredMs - e.t : 0;
    const via = e.via === 'mesh' ? `FLEET RELAY${e.peer != null ? ` · RL-PEER-${String(e.peer).padStart(2, '0')}` : ''}` : (e.via ?? '').toUpperCase();
    return `<button class="alert ${selectedEvent === e ? 'selected' : ''}" data-t="${e.t}" data-type="${e.type}"><i class="dot" style="--c:${SEV[e.severity]}"></i>
      <div><div class="a-top"><strong>${clean(e.title)}</strong><time>${fmtClock(e.t, true)}</time></div>
      <span>${clean(e.detail)}</span>
      <div class="badges"><span class="badge sev-${e.severity}">${e.severity.toUpperCase()}</span><span class="badge">${clean(via)}</span>${lag > 90e3 ? `<span class="badge wait">DELIVERED ${fmtDuration(lag)} LATER</span>` : ''}</div></div></button>`;
  }).join('');
  document.querySelector('#alerts').innerHTML = pending + (body || '<div class="empty">No alert yet. Move the replay forward.</div>');
  document.querySelectorAll('#alerts .alert[data-t]').forEach(el => el.addEventListener('click', () => {
    const e = trip().events.find(x => String(x.t) === el.dataset.t && x.type === el.dataset.type);
    if (e) selectEvent(e);
  }));
}

function strip(track, key, colors, labels, w, start, end, y, h) {
  const x = ms => ((ms - start) / (end - start)) * w;
  return segments(track, key).map(s => `<rect x="${x(s.from).toFixed(1)}" y="${y}" width="${Math.max(1, x(s.to) - x(s.from)).toFixed(1)}" height="${h}" fill="${colors[s.value]}"><title>${labels[s.value]}</title></rect>`).join('');
}

function renderComms() {
  const t = trip();
  const { start, end } = tripWindow(t);
  const w = 900;
  const cx = ((now - start) / (end - start)) * w;
  const one = (label, key, colors, names) => `<div class="strip-label">${label}</div><svg class="strips" viewBox="0 0 ${w} 34" preserveAspectRatio="none" role="img" aria-label="${label} timeline">
    ${strip(t.track, key, colors, names, w, start, end, 2, 30)}
    <line x1="${cx.toFixed(1)}" x2="${cx.toFixed(1)}" y1="0" y2="34" stroke="#fff" stroke-width="2"/></svg>`;
  const strips = one('LINK', 'l', LINK_COLORS, LINK_LABELS) + one('DEVICE MODE', 'm', MODE_COLORS, MODE_NAMES);
  const lk = `<div class="key"><span><i style="background:#f2f2f3"></i>Cellular</span><span><i style="background:#ff2a2a"></i>Fleet relay</span><span><i style="background:#2a2a2e;border:1px solid #444"></i>No link</span></div>
    <div class="key"><span><i style="background:#3a3a40"></i>Normal</span><span><i style="background:#ff8a3d"></i>Alert</span><span><i style="background:#ff2a2a"></i>Theft</span></div>`;
  let side;
  if (t.scenario === 'delay') {
    const h = 280, pad = 78;
    const etas = t.eta;
    const lo = Math.min(...etas.map(e => e.eta), t.plan.plannedEtaMs) - 10 * 60e3, hi = Math.max(...etas.map(e => e.eta), t.arrivedMs) + 10 * 60e3;
    const px = ms => pad + ((ms - start) / (end - start)) * (w - pad - 8);
    const py = ms => h - 24 - ((ms - lo) / (hi - lo)) * (h - 44);
    const live = etas.filter(e => e.t <= now).map(e => `${px(e.t).toFixed(1)},${py(e.eta).toFixed(1)}`).join(' ');
    const ticks = [lo, (lo + hi) / 2, hi].map(v => `<text x="2" y="${py(v).toFixed(0)}" class="ax">${fmtClock(v)}</text>`).join('');
    side = `<div class="eta-chart"><div class="panel-head slim"><div><span class="kicker">ESTIMATED ARRIVAL</span><h3>Plan versus live estimate</h3></div></div>
      <svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Estimated arrival over time">
        ${ticks}
        <line x1="${pad}" x2="${w - 8}" y1="${py(t.plan.plannedEtaMs).toFixed(1)}" y2="${py(t.plan.plannedEtaMs).toFixed(1)}" stroke="#8d8d95" stroke-dasharray="6 5"/>
        <text x="${w - 8}" y="${(py(t.plan.plannedEtaMs) - 6).toFixed(1)}" class="ax" text-anchor="end">planned ${fmtClock(t.plan.plannedEtaMs)}</text>
        <line x1="${pad}" x2="${w - 8}" y1="${py(t.arrivedMs).toFixed(1)}" y2="${py(t.arrivedMs).toFixed(1)}" stroke="#f2f2f3" stroke-dasharray="2 4"/>
        <text x="${w - 8}" y="${(py(t.arrivedMs) - 6).toFixed(1)}" class="ax" text-anchor="end">actual arrival ${fmtClock(t.arrivedMs)}</text>
        <polyline points="${live}" fill="none" stroke="#ff2a2a" stroke-width="3"/>
        <line x1="${px(now).toFixed(1)}" x2="${px(now).toFixed(1)}" y1="6" y2="${h - 24}" stroke="#fff" stroke-width="1.5"/>
      </svg>
      <p class="fine">The plan is a single estimate made at departure (${fmtClock(t.departMs)}). The live estimate also reads the weather, the traffic situations published as open data and the speeds the vehicle actually measures. Before the accident is observed nobody could know it: both estimates are wrong by about the same amount. After that the live one converges. Error one hour before arrival: <b>${t.stats.liveEtaError60MinBefore} min</b> against <b>${t.stats.staticEtaErrorMin} min</b> for the plan (synthetic traffic, see docs/ETA.md).</p></div>`;
  } else {
    const g = t.gasp ?? [];
    const rows = g.filter(x => x.t <= now).map(x => `<li class="${x.ok ? 'ok' : 'ko'}"><b>${fmtClock(x.t, true)}</b> ${x.ch === 'mesh' ? 'Fleet relay' : x.ch} ${x.ok ? 'acknowledged' : 'failed'}${x.peer >= 0 ? ` via RL-PEER-${String(x.peer).padStart(2, '0')}` : ''} · energy left ${x.remaining.toFixed(1)} units</li>`).join('');
    side = `<div class="eta-chart"><div class="panel-head slim"><div><span class="kicker">LAST GASP</span><h3>The final message</h3></div></div>
      <p class="fine">When power is cut or the device is torn off, a hold-up capacitor leaves a small energy budget. The firmware picks the best channel that budget allows: cellular first, then a fleet relay, then satellite if enabled.</p>
      <ul class="gasp">${rows || '<li class="wait">Armed. Waiting for a power cut or a crash.</li>'}</ul>
      <p class="fine">Stats from this simulation: detour flagged ${t.stats.detourAlertDelayS} s after leaving the planned corridor, tamper alert delivered in ${t.stats.tamperAlertDelayS} s over the relay, last gasp delivered in ${t.stats.lastGaspDelayS} s via ${t.stats.lastGaspChannel === 'mesh' ? 'a fleet relay' : t.stats.lastGaspChannel} while cellular was down. The ${t.stats.meshRangeAssumedM} m relay range is an assumption to measure.</p></div>`;
  }
  document.querySelector('#comms-panel').innerHTML = `
    <div class="panel-head"><div><span class="kicker">NEVER SILENT</span><h2>Links, modes and ${t.scenario === 'delay' ? 'arrival estimate' : 'last gasp'}</h2></div></div>
    <div class="comms-grid"><div>${strips}${lk}
      <p class="fine">${fmtClock(start)} → ${fmtClock(end)} (Paris time). A message that finds no link waits on the device and leaves as soon as any channel appears: cellular, or any fleet vehicle within relay range.</p></div>${side}</div>`;
}

function renderBlackbox() {
  const t = trip();
  const b = t.blackbox;
  document.querySelector('#blackbox-panel').innerHTML = `
    <div class="panel-head"><div><span class="kicker">BLACK BOX</span><h2>It records everything, and keeps what matters</h2></div></div>
    <div class="bb-grid">
      <div class="bb-stat"><strong>${b.bbTotal}</strong><span>records written in this trip</span></div>
      <div class="bb-stat"><strong>${b.bbCount}</strong><span>slots in the demo ring buffer</span></div>
      <div class="bb-stat red"><strong>${b.bbProtected}</strong><span>protected around incidents</span></div>
      <div class="bb-stat"><strong>${b.bbOverwrittenProtected}</strong><span>protected records lost</span></div>
    </div>
    <p class="fine">Each incident protects the 20 records before it and the 20 after it: normal recording cannot overwrite them, and recording never stops. A record is 24 bytes (time, position, speed, shock, flags). With an 8 MB flash that is about 349,000 records, roughly 97 hours at one per second (arithmetic, not a measurement). Records are signed and encrypted on the device. After recovery they are read back through the programming pads, or uploaded over LTE-M when a link exists.</p>`;
}

function renderTicks() {
  const t = trip();
  const { start, end } = tripWindow(t);
  document.querySelector('#ticks').innerHTML = t.events.filter(e => ['critical', 'high'].includes(e.severity)).map(e =>
    `<i style="left:${((e.t - start) / (end - start) * 100).toFixed(2)}%;background:${SEV[e.severity]}" title="${clean(e.title)}"></i>`).join('');
}

function renderClock() {
  const t = trip();
  const { start, end } = tripWindow(t);
  document.querySelector('#time').value = Math.round((now - start) / (end - start) * 1000);
  document.querySelector('#clock').textContent = fmtClock(now, true);
  document.querySelector('#clock-sub').textContent = `${fmtDuration(now - t.departMs > 0 ? now - t.departMs : 0)} since departure`;
  document.querySelector('#play').innerHTML = icon(playing ? 'pause' : 'play', 20);
}

function render() {
  const view = platformView(trip(), now);
  const status = tripStatus(trip(), now);
  renderTripList();
  renderHead(view, status);
  renderKpis(view, status);
  renderAlerts(view);
  renderComms();
  renderClock();
  drawDynamic(view);
}

function switchTrip(i) {
  tripIdx = i;
  selectedEvent = null;
  stop();
  const { start, end } = tripWindow(trip());
  now = start + (end - start) * 0.02;
  document.querySelector('#map-legend').innerHTML = legend();
  drawStatic();
  renderTicks();
  renderBlackbox();
  render();
}

function togglePlay() { playing ? stop() : start(); }
function start() {
  const { end } = tripWindow(trip());
  if (now >= end) now = tripWindow(trip()).start;
  playing = true;
  timer = setInterval(() => {
    const w = tripWindow(trip());
    now = Math.min(w.end, now + (w.end - w.start) / 900);
    if (now >= w.end) stop();
    render();
  }, 66);
  renderClock();
}
function stop() { playing = false; clearInterval(timer); renderClock(); }

function exportLog() {
  const t = trip();
  const blob = new Blob(['﻿' + toCsv(t.events)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${t.id}-incident-log.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

shell();
initMap();
switchTrip(tripIdx);
const at = params.get('at');
const atTime = params.get('t');
if (params.get('focus') === 'site' && trip().site) map.setView([trip().site.lat, trip().site.lon], 12);
if (atTime !== null) {
  now = Date.parse(atTime);
  render();
} else if (at !== null) {
  const { start, end } = tripWindow(trip());
  now = start + (end - start) * Math.min(1, Math.max(0, Number(at)));
  render();
}
