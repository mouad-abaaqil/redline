import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRoute, positionAt, nearestProgress, predictEta, patternFactor, weatherFactor,
  incidentCapMs, observedRatio, haversineM, BREAK_S
} from './eta.js';

// 1 degree of longitude on the equator, in 100 points: about 111 km.
const line = n => Array.from({ length: n }, (_, i) => [0, i / (n - 1)]);
const route = buildRoute(line(101), 72); // 72 km/h = 20 m/s
const MIDDAY = Date.parse('2026-10-06T10:00:00Z'); // Tuesday, off-peak

test('route geometry and positions', () => {
  assert.ok(Math.abs(route.totalM - 111195) < 100);
  const mid = positionAt(route, route.totalM / 2);
  assert.ok(Math.abs(mid[1] - 0.5) < 1e-3);
  assert.ok(Math.abs(nearestProgress(route, [0.01, 0.25]) - route.totalM / 4) < 200);
  assert.ok(haversineM([48.8566, 2.3522], [45.764, 4.8357]) > 390000);
});

test('free flow: a flat route takes distance over speed', () => {
  const { etaMs, breaks } = predictEta({ route, nowMs: MIDDAY, progressM: 0 });
  const hours = (etaMs - MIDDAY) / 3.6e6;
  assert.ok(Math.abs(hours - route.totalM / 20 / 3600) < 0.05, `got ${hours} h`);
  assert.equal(breaks, 0);
});

test('the mandatory 45 min break is inserted once, after 4.5 h of driving', () => {
  const long = buildRoute(line(101).map(p => [0, p[1] * 3]), 72); // about 334 km, 4.6 h
  const withBreak = predictEta({ route: long, nowMs: MIDDAY, progressM: 0 });
  assert.equal(withBreak.breaks, 1);
  const driving = long.totalM / 20;
  assert.ok(Math.abs((withBreak.etaMs - MIDDAY) / 1000 - (driving + BREAK_S)) < 600);
  const rested = predictEta({ route: long, nowMs: MIDDAY, progressM: 0, drivenS: 0 });
  assert.equal(rested.breaks, 1);
  const noBreakNeeded = predictEta({ route, nowMs: MIDDAY, progressM: 0 });
  assert.equal(noBreakNeeded.breaks, 0);
});

test('rush hour near a city slows the estimate, a weekend much less', () => {
  const tuesday8 = Date.parse('2026-10-06T06:00:00Z'); // 08:00 local
  const rush = patternFactor({ t: tuesday8, distM: 1000, totalM: 400000 });
  const calm = patternFactor({ t: MIDDAY, distM: 1000, totalM: 400000 });
  const sunday = patternFactor({ t: Date.parse('2026-10-04T06:00:00Z'), distM: 1000, totalM: 400000 });
  assert.ok(rush < 0.7 && calm > 0.98 && sunday > rush);
  assert.equal(patternFactor({ t: tuesday8, distM: 200000, totalM: 400000 }), 1); // far from both cities
});

test('weather slows the estimate', () => {
  assert.equal(weatherFactor({}), 1);
  assert.ok(weatherFactor({ precipMm: 3 }) < weatherFactor({ precipMm: 0.5 }));
  assert.ok(weatherFactor({ precipMm: 3, visibilityM: 500, windMs: 20 }) >= 0.75);
  const wet = predictEta({ route, nowMs: MIDDAY, progressM: 0, weather: () => ({ precipMm: 3 }) });
  const dry = predictEta({ route, nowMs: MIDDAY, progressM: 0 });
  assert.ok(wet.etaMs > dry.etaMs);
});

test('a traffic situation counts only once it is published', () => {
  const incidents = [{ fromM: 40000, toM: 60000, speedKmh: 18, startMs: MIDDAY, endMs: MIDDAY + 6 * 3.6e6,
    publishedMs: MIDDAY + 3600e3 }];
  assert.equal(incidentCapMs(incidents, 50000, MIDDAY + 1800e3, MIDDAY), Infinity); // not published yet
  assert.equal(incidentCapMs(incidents, 50000, MIDDAY + 1800e3, MIDDAY + 3600e3), 5);
  assert.equal(incidentCapMs(incidents, 70000, MIDDAY + 1800e3, MIDDAY + 3600e3), Infinity); // outside
  const blind = predictEta({ route, nowMs: MIDDAY, progressM: 0, incidents });
  const aware = predictEta({ route, nowMs: MIDDAY + 3600e3, progressM: 0, incidents });
  assert.ok((aware.etaMs - (MIDDAY + 3600e3)) > (blind.etaMs - MIDDAY) + 1000e3);
});

test('what the fleet measured corrects the estimate, with a clamp', () => {
  assert.equal(observedRatio([]), 1);
  assert.equal(observedRatio([{ obsMs: 16, modelMs: 20 }]), 0.8);
  assert.equal(observedRatio([{ obsMs: 1, modelMs: 20 }]), 0.5);
  assert.equal(observedRatio([{ obsMs: 90, modelMs: 20 }]), 1.3);
  const slow = predictEta({ route, nowMs: MIDDAY, progressM: 0, ratio: 0.8 });
  const base = predictEta({ route, nowMs: MIDDAY, progressM: 0 });
  assert.ok(slow.etaMs > base.etaMs);
});

test('a break already in progress delays the arrival by its remaining time', () => {
  const base = predictEta({ route, nowMs: MIDDAY, progressM: 20000 });
  const resting = predictEta({ route, nowMs: MIDDAY, progressM: 20000, restUntilMs: MIDDAY + 20 * 60e3 });
  assert.ok(Math.abs((resting.etaMs - base.etaMs) - 20 * 60e3) < 1000);
});
