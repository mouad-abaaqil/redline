import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  validateTrips, interpolateTrack, platformView, tripStatus, segments, toCsv, fmtDuration, tripWindow
} from './model.js';

const data = JSON.parse(readFileSync(new URL('./demo-trips.json', import.meta.url), 'utf8'));
const [delay, theft] = data.trips;

test('demo data validates and rejects broken files', () => {
  assert.equal(validateTrips(structuredClone(data)).trips.length, 2);
  assert.throws(() => validateTrips({ schemaVersion: 2, trips: [] }), /Invalid file/);
  const broken = structuredClone(data);
  broken.trips[0].track[3].t = 0;
  assert.throws(() => validateTrips(broken), /timestamps must be increasing/);
});

test('interpolation stays between samples and clamps at the ends', () => {
  const a = delay.track[10], b = delay.track[11];
  const mid = interpolateTrack(delay.track, (a.t + b.t) / 2);
  assert.ok(mid.la >= Math.min(a.la, b.la) - 1e-9 && mid.la <= Math.max(a.la, b.la) + 1e-9);
  assert.equal(interpolateTrack(delay.track, 0).la, delay.track[0].la);
  assert.equal(interpolateTrack(delay.track, 9e15).la, delay.track.at(-1).la);
});

test('the platform only knows what was delivered', () => {
  const stop = theft.events.find(e => e.type === 'unauthorized_stop');
  assert.ok(stop.deliveredMs > stop.t, 'the alert waited for a fleet relay');
  const before = platformView(theft, stop.t + 1000);
  assert.ok(!before.events.some(e => e.type === 'unauthorized_stop'));
  assert.ok(before.pending.some(e => e.type === 'unauthorized_stop'));
  const after = platformView(theft, stop.deliveredMs + 1000);
  assert.ok(after.events.some(e => e.type === 'unauthorized_stop'));
  assert.ok(!after.pending.some(e => e.type === 'unauthorized_stop'));
});

test('the theft trip ends with a last gasp over the fleet relay and a silent device', () => {
  const gasp = theft.gasp.find(g => g.ok);
  assert.equal(gasp.ch, 'mesh');
  const end = tripWindow(theft).end + 3600e3;
  const view = platformView(theft, end);
  assert.ok(view.gasp);
  assert.equal(tripStatus(theft, end).label, 'DEVICE LOST');
  assert.equal(tripStatus(theft, theft.departMs + 60e3).label, 'ON ROUTE');
});

test('the delayed trip goes from on time to delayed to delivered late', () => {
  assert.equal(tripStatus(delay, delay.departMs + 3600e3).label, 'ON TIME');
  const slip = delay.events.find(e => e.type === 'eta_slip' && e.value === 30);
  assert.match(tripStatus(delay, slip.t + 60e3).label, /^DELAYED \+\d+ MIN$/);
  assert.match(tripStatus(delay, delay.arrivedMs + 1).label, /^DELIVERED \+\d+ MIN$/);
});

test('live estimate converges on the actual arrival', () => {
  const err = e => Math.abs(e.eta - delay.arrivedMs);
  const late = delay.eta.filter(e => delay.arrivedMs - e.t < 30 * 60e3);
  assert.ok(late.length > 0 && late.every(e => err(e) < 15 * 60e3));
  assert.ok(Math.abs(delay.plan.plannedEtaMs - delay.arrivedMs) > 30 * 60e3, 'the static plan was off');
});

test('timeline segments cover the whole track without gaps', () => {
  const seg = segments(theft.track, 'l');
  assert.equal(seg[0].from, theft.track[0].t);
  assert.equal(seg.at(-1).to, theft.track.at(-1).t);
  for (let i = 1; i < seg.length; i++) assert.equal(seg[i].from, seg[i - 1].to);
  assert.ok(seg.some(s => s.value === 0) && seg.some(s => s.value === 1) && seg.some(s => s.value === 2));
});

test('CSV escapes quotes and keeps one row per event', () => {
  const events = structuredClone(theft.events).slice(0, 3);
  events[0].title = 'He said "stop"';
  const csv = toCsv(events);
  assert.match(csv, /"He said ""stop"""/);
  assert.equal(csv.split('\n').length, 4);
  assert.equal(fmtDuration(45e3), '45 s');
  assert.equal(fmtDuration(125 * 60e3), '2 h 05');
});
