#include "../firmware/RedlineCore.h"

#include <assert.h>
#include <stdint.h>
#include <stdio.h>

using namespace redline;

// Test route: along the equator from lon 0 to lon 1 (about 111 km).
static void makePlan(Plan& plan) {
  plan.addRoutePoint(0.0, 0.0);
  plan.addRoutePoint(0.0, 0.5);
  plan.addRoutePoint(0.0, 1.0);
}

static Sample at(uint32_t t, double lat, double lon, double speed = 80.0) {
  Sample s;
  s.t = t;
  s.p.lat = lat;
  s.p.lon = lon;
  s.speedKmh = speed;
  s.gnssValid = true;
  s.cellOk = true;
  s.motion = true;
  s.tamperMount = false;
  s.tamperCover = false;
  s.powerOk = true;
  s.shockG = 0.0;
  s.armed = false;
  return s;
}

static int count(const Event* ev, uint8_t n, EventType type) {
  int c = 0;
  for (uint8_t i = 0; i < n; ++i)
    if (ev[i].type == type) ++c;
  return c;
}

static uint8_t feed(Tracker& tr, const Sample& s, Event* ev) { return tr.update(s, ev, 8); }

static void geometry() {
  Point paris = {48.8566, 2.3522}, lyon = {45.764, 4.8357};
  const double d = distanceM(paris, lyon);
  assert(d > 390000.0 && d < 394000.0);  // about 392 km as the crow flies

  Point a = {0.0, 0.0}, b = {0.0, 1.0}, p = {0.01, 0.5};
  const double side = segmentDistanceM(p, a, b);
  assert(side > 1100.0 && side < 1125.0);  // 0.01 deg of latitude
  Point beyond = {0.0, 1.01};
  const double end = segmentDistanceM(beyond, a, b);
  assert(end > 1100.0 && end < 1125.0);  // clamps to the end point
}

static void deviation() {
  Plan plan;
  makePlan(plan);
  Tracker tr;
  tr.begin(&plan, Config());
  Event ev[8];
  // 5.5 km off the route: no event before the 120 s confirmation.
  assert(count(ev, feed(tr, at(0, 0.05, 0.25), ev), kDeviationStart) == 0);
  assert(count(ev, feed(tr, at(119, 0.05, 0.25), ev), kDeviationStart) == 0);
  uint8_t n = feed(tr, at(120, 0.05, 0.25), ev);
  assert(count(ev, n, kDeviationStart) == 1);
  assert(count(ev, n, kModeChange) == 1 && tr.mode() == kAlert);
  assert(tr.reportIntervalS() == 60);
  // Back to 2.8 km: inside the corridor but not yet inside the 80 % hysteresis band (2.4 km).
  assert(count(ev, feed(tr, at(180, 0.025, 0.25), ev), kDeviationEnd) == 0);
  n = feed(tr, at(240, 0.01, 0.25), ev);
  assert(count(ev, n, kDeviationEnd) == 1 && tr.mode() == kNormal);
  assert(tr.reportIntervalS() == 900);

  // A short excursion never alerts.
  Tracker t2;
  Plan plan2;
  makePlan(plan2);
  t2.begin(&plan2, Config());
  assert(feed(t2, at(0, 0.05, 0.25), ev) == 0);
  assert(feed(t2, at(60, 0.0, 0.25), ev) == 0);
  assert(feed(t2, at(130, 0.05, 0.25), ev) == 0);  // the timer restarted
}

static void stops() {
  Plan plan;
  makePlan(plan);
  Tracker tr;
  tr.begin(&plan, Config());
  Event ev[8];
  assert(feed(tr, at(0, 0.0, 0.25, 0.0), ev) == 0);
  assert(feed(tr, at(599, 0.0, 0.25, 0.0), ev) == 0);
  uint8_t n = feed(tr, at(600, 0.0, 0.25, 0.0), ev);
  assert(count(ev, n, kUnauthorizedStop) == 1);
  assert(tr.mode() == kNormal);  // a stop alone (30) stays below the alert level
  n = feed(tr, at(660, 0.0, 0.2501, 60.0), ev);
  assert(count(ev, n, kStopEnd) == 1);

  // The same stop inside an authorized zone (a depot) is silent.
  Plan depot;
  makePlan(depot);
  depot.addZone(0.0, 0.25, 500.0);
  Tracker t2;
  t2.begin(&depot, Config());
  feed(t2, at(0, 0.0, 0.25, 0.0), ev);
  assert(feed(t2, at(900, 0.0, 0.25, 0.0), ev) == 0);
}

static void schedule() {
  Plan plan;
  makePlan(plan);
  plan.addCheckpoint(0.0, 0.5, 3600, 2000.0);
  plan.addCheckpoint(0.0, 1.0, 8000, 2000.0);
  Tracker tr;
  tr.begin(&plan, Config());
  Event ev[8];
  uint8_t n = feed(tr, at(5000, 0.0, 0.5), ev);  // 1400 s late
  assert(count(ev, n, kCheckpoint) == 1 && count(ev, n, kScheduleDelay) == 1);
  assert(ev[0].value > 1399.0 && ev[0].value < 1401.0);
  assert(count(ev, feed(tr, at(5060, 0.0, 0.5), ev), kCheckpoint) == 0);  // only once
  n = feed(tr, at(7000, 0.0, 1.0), ev);  // 1000 s early
  assert(count(ev, n, kCheckpoint) == 1 && count(ev, n, kScheduleDelay) == 0);
  assert(ev[0].value < -999.0);
}

static void jamming() {
  Plan plan;
  makePlan(plan);
  Tracker tr;
  tr.begin(&plan, Config());
  Event ev[8];
  Sample s = at(0, 0.0, 0.1);
  s.gnssValid = false;
  assert(feed(tr, s, ev) == 0);
  s.t = 59;
  assert(feed(tr, s, ev) == 0);
  s.t = 60;
  uint8_t n = feed(tr, s, ev);
  assert(count(ev, n, kGnssLoss) == 1 && tr.mode() == kAlert);
  n = feed(tr, at(90, 0.0, 0.1), ev);
  assert(count(ev, n, kGnssRestored) == 1 && tr.mode() == kNormal);

  // GNSS and cellular both down is an outage, not a jamming suspicion.
  Tracker t2;
  Plan plan2;
  makePlan(plan2);
  t2.begin(&plan2, Config());
  Sample q = at(0, 0.0, 0.1);
  q.gnssValid = false;
  q.cellOk = false;
  assert(feed(t2, q, ev) == 0);
  q.t = 600;
  assert(feed(t2, q, ev) == 0);  // moving (motion = true), so no stop either

  // Jammed and motionless outside any zone: the accelerometer still reveals the stop.
  Tracker t3;
  Plan plan3;
  makePlan(plan3);
  t3.begin(&plan3, Config());
  Sample j = at(0, 0.0, 0.1);
  j.gnssValid = false;
  j.motion = false;
  assert(feed(t3, j, ev) == 0);
  j.t = 600;
  assert(count(ev, feed(t3, j, ev), kUnauthorizedStop) == 1);
}

static void theft() {
  Plan plan;
  makePlan(plan);
  Tracker tr;
  tr.begin(&plan, Config());
  Event ev[8];
  // Parked and armed: motion for 10 s is suspicious.
  Sample s = at(0, 0.0, 0.0, 0.0);
  s.armed = true;
  assert(feed(tr, s, ev) == 0);
  s.t = 10;
  uint8_t n = feed(tr, s, ev);
  assert(count(ev, n, kArmedMotion) == 1 && tr.mode() == kAlert);
  s.motion = false;
  s.t = 20;
  feed(tr, s, ev);
  assert(tr.mode() == kNormal);

  // Tamper reaches theft mode immediately and the mode stays latched.
  s = at(30, 0.0, 0.1);
  s.tamperMount = true;
  n = feed(tr, s, ev);
  assert(count(ev, n, kTamper) == 1 && ev[0].value == 1.0 && tr.mode() == kTheft);
  assert(tr.reportIntervalS() == 10);
  feed(tr, at(60, 0.0, 0.1), ev);
  assert(tr.mode() == kTheft);
  tr.acknowledge();
  feed(tr, at(90, 0.0, 0.1), ev);
  assert(tr.mode() == kNormal);

  // Power loss is reported once and also reaches theft mode.
  Tracker t2;
  Plan plan2;
  makePlan(plan2);
  t2.begin(&plan2, Config());
  Sample p = at(0, 0.0, 0.1);
  p.powerOk = false;
  n = feed(t2, p, ev);
  assert(count(ev, n, kPowerLoss) == 1 && t2.mode() == kTheft);
  p.t = 1;
  assert(count(ev, feed(t2, p, ev), kPowerLoss) == 0);

  // Shock: one event, then a 5 s cool-down.
  Tracker t3;
  Plan plan3;
  makePlan(plan3);
  t3.begin(&plan3, Config());
  Sample k = at(2, 0.0, 0.1);
  k.shockG = 62.0;
  n = feed(t3, k, ev);
  assert(count(ev, n, kShock) == 1 && ev[0].value > 61.0);
  k.t = 4;
  assert(count(ev, feed(t3, k, ev), kShock) == 0);
  k.t = 8;
  assert(count(ev, feed(t3, k, ev), kShock) == 1);

  // Detour + stop + GNSS loss add up to theft level (40 + 30 + 40).
  Tracker t4;
  Plan plan4;
  makePlan(plan4);
  t4.begin(&plan4, Config());
  Sample c = at(0, 0.05, 0.25, 0.0);
  c.gnssValid = true;
  feed(t4, c, ev);
  c.t = 600;
  feed(t4, c, ev);  // deviation (40) + stop (30) = 70: alert only
  assert(t4.risk() == 70 && t4.mode() == kAlert);
  c.gnssValid = false;
  c.motion = false;  // jammed: the accelerometer confirms the vehicle is still
  c.t = 700;
  feed(t4, c, ev);
  c.t = 760;
  feed(t4, c, ev);
  assert(t4.risk() == 110 && t4.mode() == kTheft);
}

static void blackBox() {
  BlackBox<8> bb;
  Record r;
  r.t = 0;
  r.latE5 = r.lonE5 = 0;
  r.speedDkmh = 0;
  r.shockCg = 0;
  r.flags = 0;
  r.seq = 0;
  for (int i = 0; i < 18; ++i) bb.append(r);
  assert(bb.count() == 8 && bb.total() == 18);
  Record out[8];
  assert(bb.exportSorted(out, 8) == 8);
  for (int i = 0; i < 8; ++i) assert(out[i].seq == uint32_t(10 + i));  // the newest 8, in order

  // Records around an incident survive normal recording.
  BlackBox<8> b2;
  for (int i = 0; i < 8; ++i) b2.append(r);   // seq 0..7
  b2.flagIncident(3, 2);                      // protects 5, 6, 7 and the next two
  for (int i = 0; i < 12; ++i) b2.append(r);  // seq 8..19
  assert(b2.protectedCount() == 5 && b2.overwrittenProtected() == 0);
  b2.exportSorted(out, 8);
  assert(out[0].seq == 5 && out[1].seq == 6 && out[2].seq == 7 && out[3].seq == 8 && out[4].seq == 9);

  // When every slot is protected the oldest is overwritten: recording never stops.
  BlackBox<4> b3;
  for (int i = 0; i < 4; ++i) b3.append(r);
  b3.flagIncident(4, 100);
  for (int i = 0; i < 6; ++i) b3.append(r);
  assert(b3.count() == 4 && b3.overwrittenProtected() == 6);
  Record o4[4];
  b3.exportSorted(o4, 4);
  assert(o4[3].seq == 9 && o4[0].seq == 6);
}

static void lastGasp() {
  LastGasp lg;
  lg.arm(3.0);
  Links up = {true, true, true};
  assert(lg.next(up) == kChanNone);  // not triggered yet
  lg.trigger();
  assert(lg.next(up) == kChanCellular);  // cheapest reliable first

  // Cellular keeps failing: two tries, then the next channel that is affordable.
  lg.report(kChanCellular, false);
  assert(lg.next(up) == kChanCellular);
  lg.report(kChanCellular, false);  // 1.0 left
  assert(lg.next(up) == kChanMesh);
  lg.report(kChanMesh, true);
  assert(lg.delivered() && lg.next(up) == kChanNone);

  // No cellular, no peer: satellite only if the budget covers it.
  LastGasp sat;
  sat.arm(3.0);
  sat.trigger();
  Links onlySat = {false, false, true};
  assert(sat.next(onlySat) == kChanSatellite);
  sat.report(kChanSatellite, false);  // 0.5 left
  assert(sat.next(onlySat) == kChanNone);

  LastGasp poor;
  poor.arm(2.0);
  poor.trigger();
  assert(poor.next(onlySat) == kChanNone);  // 2.5 > 2.0

  // A mesh peer is preferred over satellite when cellular is down.
  LastGasp mesh;
  mesh.arm(3.0);
  mesh.trigger();
  Links noCell = {false, true, true};
  assert(mesh.next(noCell) == kChanMesh);
}

static void relayQueue() {
  RelayQueue<4> q;
  Message m = {1, 0, 4, 0};
  assert(q.offer(m));
  assert(!q.offer(m));  // duplicate
  Message dead = {2, 3, 0, 0};
  assert(!q.offer(dead));  // ttl 0
  Message far = {3, 3, 4, kMaxHops};
  assert(!q.offer(far));  // too many hops
  Message urgent = {4, 3, 4, 1};
  Message normal = {5, 1, 4, 0};
  assert(q.offer(urgent) && q.offer(normal));
  Message out;
  assert(q.popBest(out) && out.id == 4);  // urgent first
  assert(out.hops == 2 && out.ttl == 3);  // prepared for the next hop
  assert(q.popBest(out) && out.id == 5);  // then the better of the rest
  assert(q.popBest(out) && out.id == 1);
  assert(!q.popBest(out));
  assert(!q.offer(m));  // already seen, even after it left the queue

  // Full queue: a more urgent message evicts the oldest lowest-priority one.
  RelayQueue<4> f;
  for (uint32_t i = 10; i < 14; ++i) {
    Message low = {i, 0, 4, 0};
    assert(f.offer(low));
  }
  Message same = {20, 0, 4, 0};
  assert(f.offer(same) && f.size() == 4);  // equal priority: the newest replaces the oldest (id 10)
  Message high = {21, 2, 4, 0};
  assert(f.offer(high) && f.size() == 4);  // id 11 evicted
  assert(f.popBest(out) && out.id == 21);
  assert(f.popBest(out) && out.id == 12);
  RelayQueue<2> g;
  Message hi1 = {30, 3, 4, 0}, hi2 = {31, 3, 4, 0}, lo = {32, 1, 4, 0};
  assert(g.offer(hi1) && g.offer(hi2));
  assert(!g.offer(lo));  // an urgent backlog is never displaced by a routine message
}

int main() {
  geometry();
  deviation();
  stops();
  schedule();
  jamming();
  theft();
  blackBox();
  lastGasp();
  relayQueue();
  puts("Redline core tests passed");
}
