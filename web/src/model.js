// Pure helpers behind the dashboard: validation, replay state, platform view, exports.

export const SEVERITY_ORDER = { critical: 4, high: 3, medium: 2, info: 1 };
export const MODE_NAMES = ['Normal', 'Alert', 'Theft'];
export const LINK_NAMES = ['No link', 'Cellular', 'Fleet relay', 'Satellite'];

export function validateTrips(data) {
  if (!data || data.schemaVersion !== 1 || !Array.isArray(data.trips) || data.trips.length === 0) {
    throw new Error('Invalid file: schemaVersion 1 and a non-empty trips array are required.');
  }
  for (const trip of data.trips) {
    if (!trip.id || !trip.title || !Array.isArray(trip.track) || trip.track.length < 2) {
      throw new Error(`Invalid trip ${trip.id ?? '(no id)'}: id, title and a track are required.`);
    }
    if (!trip.track.every((s, i) => Number.isFinite(s.t) && Number.isFinite(s.la) && Number.isFinite(s.lo) &&
        (i === 0 || s.t >= trip.track[i - 1].t))) {
      throw new Error(`Invalid track in ${trip.id}: timestamps must be increasing and positions numeric.`);
    }
    if (!Array.isArray(trip.events) || !trip.events.every(e => Number.isFinite(e.t) && e.severity in SEVERITY_ORDER)) {
      throw new Error(`Invalid events in ${trip.id}.`);
    }
    if (!trip.plan || !Array.isArray(trip.plan.checkpoints) || !Number.isFinite(trip.plan.plannedEtaMs)) {
      throw new Error(`Invalid plan in ${trip.id}.`);
    }
  }
  return data;
}

// The replay covers the track and any event that happens after the device went quiet.
export function tripWindow(trip) {
  const lastEvent = trip.events.reduce((m, e) => Math.max(m, e.t, e.deliveredMs ?? 0), 0);
  return { start: trip.track[0].t, end: Math.max(trip.track[trip.track.length - 1].t, lastEvent + 60e3) };
}

// Position of the vehicle at time t, interpolated between two samples.
export function interpolateTrack(track, t) {
  if (t <= track[0].t) return { ...track[0], t };
  const last = track[track.length - 1];
  if (t >= last.t) return { ...last, t };
  let lo = 0, hi = track.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (track[mid].t <= t) lo = mid; else hi = mid;
  }
  const a = track[lo], b = track[hi];
  const f = (t - a.t) / (b.t - a.t);
  return { ...a, t, la: a.la + (b.la - a.la) * f, lo: a.lo + (b.lo - a.lo) * f, v: Math.round(a.v + (b.v - a.v) * f) };
}

// What the platform knows at time `now`, as opposed to what the device
// recorded: only delivered messages count. Everything else is still stored
// on the device (or lost with it).
export function platformView(trip, now) {
  const delivered = trip.events.filter(e => e.deliveredMs != null && e.deliveredMs <= now);
  const pending = trip.events.filter(e => e.t <= now && (e.deliveredMs == null || e.deliveredMs > now) &&
    e.via !== 'platform' && e.via !== 'open data' && e.severity !== 'info');
  const reports = trip.reports.filter(r => r.deliveredMs <= now);
  const heard = [...reports.map(r => ({ t: r.deliveredMs, via: r.via, mode: r.mode })),
    ...delivered.filter(e => e.via !== 'platform' && e.via !== 'open data').map(e => ({ t: e.deliveredMs, via: e.via, mode: null }))]
    .sort((a, b) => a.t - b.t);
  const lastHeard = heard[heard.length - 1] ?? null;
  let mode = 0;
  for (const r of [...reports].sort((a, b) => a.deliveredMs - b.deliveredMs)) mode = r.mode;
  for (const e of delivered) if (e.type === 'mode_change') mode = e.value;
  const gasp = trip.gasp?.find(g => g.ok && g.t <= now) ?? null;
  const eta = [...trip.eta].reverse().find(e => e.t <= now) ?? null;
  return {
    events: delivered.sort((a, b) => b.deliveredMs - a.deliveredMs || SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity]),
    pending, reports, lastHeard, mode, gasp, eta,
    silentForMs: lastHeard ? Math.max(0, now - lastHeard.t) : null
  };
}

// Headline status of the trip at time `now`.
export function tripStatus(trip, now) {
  const view = platformView(trip, now);
  if (trip.scenario === 'theft') {
    if (view.events.some(e => e.type === 'silent')) return { label: 'DEVICE LOST', tone: 'critical' };
    if (view.gasp) return { label: 'LAST GASP RECEIVED', tone: 'critical' };
    if (view.mode === 2) return { label: 'THEFT SUSPECTED', tone: 'critical' };
    if (view.mode === 1) return { label: 'ALERT', tone: 'high' };
    return { label: 'ON ROUTE', tone: 'ok' };
  }
  if (trip.arrivedMs && now >= trip.arrivedMs) {
    const late = Math.round((trip.arrivedMs - trip.plan.plannedEtaMs) / 60e3);
    return { label: late > 15 ? `DELIVERED +${late} MIN` : 'DELIVERED ON TIME', tone: late > 15 ? 'high' : 'ok' };
  }
  const late = view.eta ? Math.round((view.eta.eta - trip.plan.plannedEtaMs) / 60e3) : 0;
  return late > 15 ? { label: `DELAYED +${late} MIN`, tone: late > 30 ? 'critical' : 'high' } : { label: 'ON TIME', tone: 'ok' };
}

// Run-length segments of a track field ('m' mode, 'l' link) for the timeline strips.
export function segments(track, key) {
  const out = [];
  for (let i = 0; i < track.length; i++) {
    const next = i + 1 < track.length ? track[i + 1].t : track[i].t;
    const last = out[out.length - 1];
    if (last && last.value === track[i][key]) last.to = next;
    else out.push({ from: track[i].t, to: next, value: track[i][key] });
  }
  return out;
}

export function fmtClock(ms, seconds = false) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), hour12: false
  }).format(new Date(ms));
}

export function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}

export function toCsv(events) {
  const head = ['time_utc', 'delivered_utc', 'via', 'severity', 'type', 'title', 'detail', 'lat', 'lon'];
  const rows = events.map(e => [new Date(e.t).toISOString(), e.deliveredMs ? new Date(e.deliveredMs).toISOString() : '',
    e.via ?? '', e.severity, e.type, e.title, e.detail, e.lat?.toFixed(5) ?? '', e.lon?.toFixed(5) ?? '']);
  return [head, ...rows].map(r => r.map(c => `"${String(c).replaceAll('"', '""')}"`).join(',')).join('\n');
}
