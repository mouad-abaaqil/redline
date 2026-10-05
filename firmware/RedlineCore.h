#ifndef REDLINE_CORE_H
#define REDLINE_CORE_H

// Redline core logic: plain C++11, no Arduino or Zephyr dependency, no heap.
// Everything here is driven by synthetic inputs in tests/ and in the trip
// simulation, then runs unchanged on the device.
//
//   Tracker      route corridor, unauthorized stops, schedule, theft rules, mode
//   BlackBox     ring buffer that protects the records around an incident
//   LastGasp     last message on the best channel the remaining energy allows
//   RelayQueue   store-and-forward queue with priority, TTL and de-duplication

#include <math.h>
#include <stdint.h>

namespace redline {

static const double kEarthM = 6371000.0;
static const double kPi = 3.14159265358979323846;

struct Point {
  double lat;
  double lon;
};

inline double toRad(double deg) { return deg * kPi / 180.0; }

// Great-circle distance (haversine), metres.
inline double distanceM(const Point& a, const Point& b) {
  const double dLat = toRad(b.lat - a.lat);
  const double dLon = toRad(b.lon - a.lon);
  const double s1 = sin(dLat / 2.0);
  const double s2 = sin(dLon / 2.0);
  const double h = s1 * s1 + cos(toRad(a.lat)) * cos(toRad(b.lat)) * s2 * s2;
  return 2.0 * kEarthM * asin(sqrt(h));
}

// Distance from p to the segment a-b, metres (local flat approximation:
// accurate to a few metres over the corridor widths used here).
inline double segmentDistanceM(const Point& p, const Point& a, const Point& b) {
  const double k = cos(toRad(p.lat));
  const double ax = (a.lon - p.lon) * k, ay = a.lat - p.lat;
  const double bx = (b.lon - p.lon) * k, by = b.lat - p.lat;
  const double dx = bx - ax, dy = by - ay;
  const double len2 = dx * dx + dy * dy;
  double t = len2 > 0.0 ? -(ax * dx + ay * dy) / len2 : 0.0;
  if (t < 0.0) t = 0.0;
  if (t > 1.0) t = 1.0;
  const double cx = ax + t * dx, cy = ay + t * dy;
  return sqrt(cx * cx + cy * cy) * toRad(1.0) * kEarthM;
}

// ---------------------------------------------------------------- plan

struct Zone {
  Point p;
  double radiusM;
};

struct Checkpoint {
  Point p;
  uint32_t plannedS;  // seconds since the start of the trip
  double radiusM;
  bool passed;
};

struct Plan {
  static const uint16_t kMaxRoute = 400;
  static const uint8_t kMaxZones = 16;
  static const uint8_t kMaxCheckpoints = 16;

  Point route[kMaxRoute];
  uint16_t routeCount;
  Zone zones[kMaxZones];  // authorized stop areas (depots, rest areas)
  uint8_t zoneCount;
  Checkpoint checkpoints[kMaxCheckpoints];
  uint8_t checkpointCount;

  Plan() : routeCount(0), zoneCount(0), checkpointCount(0) {}

  bool addRoutePoint(double lat, double lon) {
    if (routeCount >= kMaxRoute) return false;
    route[routeCount].lat = lat;
    route[routeCount].lon = lon;
    ++routeCount;
    return true;
  }
  bool addZone(double lat, double lon, double radiusM) {
    if (zoneCount >= kMaxZones) return false;
    zones[zoneCount].p.lat = lat;
    zones[zoneCount].p.lon = lon;
    zones[zoneCount].radiusM = radiusM;
    ++zoneCount;
    return true;
  }
  bool addCheckpoint(double lat, double lon, uint32_t plannedS, double radiusM) {
    if (checkpointCount >= kMaxCheckpoints) return false;
    Checkpoint& c = checkpoints[checkpointCount++];
    c.p.lat = lat;
    c.p.lon = lon;
    c.plannedS = plannedS;
    c.radiusM = radiusM;
    c.passed = false;
    return true;
  }

  double distanceToRouteM(const Point& p) const {
    if (routeCount == 0) return 0.0;
    if (routeCount == 1) return distanceM(p, route[0]);
    double best = 1e18;
    for (uint16_t i = 0; i + 1 < routeCount; ++i) {
      const double d = segmentDistanceM(p, route[i], route[i + 1]);
      if (d < best) best = d;
    }
    return best;
  }
  bool inAuthorizedZone(const Point& p) const {
    for (uint8_t i = 0; i < zoneCount; ++i)
      if (distanceM(p, zones[i].p) <= zones[i].radiusM) return true;
    return false;
  }
};

// ---------------------------------------------------------------- tracker

struct Config {
  double corridorM;
  uint32_t deviationConfirmS;   // time outside the corridor before alerting
  double stopSpeedKmh;
  uint32_t stopConfirmS;        // time stopped outside an authorized zone
  uint32_t delayWarnS;          // lateness at a checkpoint that raises an event
  uint32_t armedMotionConfirmS; // motion while parked and armed
  uint32_t gnssLossConfirmS;    // GNSS lost while the cellular link stays up
  double shockThresholdG;
  uint32_t reportNormalS;
  uint32_t reportAlertS;
  uint32_t reportTheftS;
  uint16_t riskAlert;
  uint16_t riskTheft;

  Config()
      : corridorM(3000.0), deviationConfirmS(120), stopSpeedKmh(3.0), stopConfirmS(600),
        delayWarnS(900), armedMotionConfirmS(10), gnssLossConfirmS(60), shockThresholdG(50.0),
        reportNormalS(900), reportAlertS(60), reportTheftS(10), riskAlert(40), riskTheft(100) {}
};

// Risk weights of each active condition. Tamper and power loss alone reach
// theft level; a detour alone only raises an alert.
static const uint16_t kWDeviation = 40;
static const uint16_t kWStop = 30;
static const uint16_t kWGnssLoss = 40;
static const uint16_t kWArmedMotion = 60;
static const uint16_t kWTamper = 100;
static const uint16_t kWPowerLoss = 100;

struct Sample {
  uint32_t t;  // seconds since the start of the trip
  Point p;
  double speedKmh;
  bool gnssValid;
  bool cellOk;
  bool motion;
  bool tamperMount;
  bool tamperCover;
  bool powerOk;
  double shockG;
  bool armed;  // parked and armed: any motion is suspicious
};

enum EventType {
  kNone = 0,
  kDeviationStart,
  kDeviationEnd,
  kUnauthorizedStop,
  kStopEnd,
  kCheckpoint,      // value = lateness in seconds (negative = early)
  kScheduleDelay,   // value = lateness in seconds
  kGnssLoss,
  kGnssRestored,
  kArmedMotion,
  kTamper,          // value: 1 = mounting, 2 = cover
  kPowerLoss,
  kShock,           // value = peak g
  kModeChange       // value = new mode
};

enum Mode { kNormal = 0, kAlert = 1, kTheft = 2 };

struct Event {
  EventType type;
  uint32_t t;
  Point p;
  double value;
};

class Tracker {
 public:
  Tracker() : plan_(0), mode_(kNormal), started_(false) { reset(); }

  void begin(Plan* plan, const Config& config) {
    plan_ = plan;
    cfg_ = config;
    reset();
    started_ = true;
  }

  // Feeds one sample. Writes up to `cap` events and returns how many.
  uint8_t update(const Sample& s, Event* out, uint8_t cap) {
    uint8_t n = 0;
    if (!started_ || plan_ == 0) return 0;

    if (s.gnssValid) {
      last_ = s.p;
      haveFix_ = true;
    }
    const Point here = haveFix_ ? last_ : s.p;

    // --- GNSS: loss with a healthy cellular link points to jamming.
    if (!s.gnssValid && s.cellOk) {
      if (gnssLostSince_ == kNever) gnssLostSince_ = s.t;
      if (!gnssLoss_ && s.t - gnssLostSince_ >= cfg_.gnssLossConfirmS) {
        gnssLoss_ = true;
        push(out, cap, n, kGnssLoss, s.t, here, 0.0);
      }
    } else if (s.gnssValid) {
      gnssLostSince_ = kNever;
      if (gnssLoss_) {
        gnssLoss_ = false;
        push(out, cap, n, kGnssRestored, s.t, here, 0.0);
      }
    }

    if (s.gnssValid) {
      // --- Route corridor with hysteresis.
      const double d = plan_->distanceToRouteM(s.p);
      if (d > cfg_.corridorM) {
        if (outsideSince_ == kNever) outsideSince_ = s.t;
        if (!deviation_ && s.t - outsideSince_ >= cfg_.deviationConfirmS) {
          deviation_ = true;
          push(out, cap, n, kDeviationStart, s.t, s.p, d);
        }
      } else if (d <= cfg_.corridorM * 0.8) {
        outsideSince_ = kNever;
        if (deviation_) {
          deviation_ = false;
          push(out, cap, n, kDeviationEnd, s.t, s.p, d);
        }
      }

      // --- Schedule: lateness is measured when a checkpoint is reached.
      for (uint8_t i = 0; i < plan_->checkpointCount; ++i) {
        Checkpoint& c = plan_->checkpoints[i];
        if (c.passed || distanceM(s.p, c.p) > c.radiusM) continue;
        c.passed = true;
        const double late = double(s.t) - double(c.plannedS);
        push(out, cap, n, kCheckpoint, s.t, s.p, late);
        if (late >= double(cfg_.delayWarnS)) push(out, cap, n, kScheduleDelay, s.t, s.p, late);
      }
    }

    // --- Stops outside authorized zones. Without a fix (jamming, tunnel) the
    // accelerometer tells whether the vehicle moves and the last fix is used.
    const bool still = s.gnssValid ? s.speedKmh < cfg_.stopSpeedKmh : !s.motion;
    if (still && !s.armed) {
      if (slowSince_ == kNever) slowSince_ = s.t;
      if (!stop_ && s.t - slowSince_ >= cfg_.stopConfirmS && !plan_->inAuthorizedZone(here)) {
        stop_ = true;
        push(out, cap, n, kUnauthorizedStop, s.t, here, double(s.t - slowSince_));
      }
    } else {
      slowSince_ = kNever;
      if (stop_) {
        stop_ = false;
        push(out, cap, n, kStopEnd, s.t, here, 0.0);
      }
    }

    // --- Theft rules.
    if (s.armed && s.motion) {
      if (motionSince_ == kNever) motionSince_ = s.t;
      if (!armedMotion_ && s.t - motionSince_ >= cfg_.armedMotionConfirmS) {
        armedMotion_ = true;
        push(out, cap, n, kArmedMotion, s.t, here, 0.0);
      }
    } else {
      motionSince_ = kNever;
      armedMotion_ = false;
    }

    const bool tamper = s.tamperMount || s.tamperCover;
    if (tamper && !tamper_) {
      push(out, cap, n, kTamper, s.t, here, s.tamperMount ? 1.0 : 2.0);
    }
    tamper_ = tamper;

    if (!s.powerOk && powerOk_) push(out, cap, n, kPowerLoss, s.t, here, 0.0);
    powerOk_ = s.powerOk;

    if (s.shockG >= cfg_.shockThresholdG && (lastShockT_ == kNever || s.t - lastShockT_ >= 5)) {
      lastShockT_ = s.t;
      push(out, cap, n, kShock, s.t, here, s.shockG);
    }

    // --- Mode from the risk of the conditions currently active. A theft
    // mode stays latched until acknowledge() is called.
    risk_ = 0;
    if (deviation_) risk_ += kWDeviation;
    if (stop_) risk_ += kWStop;
    if (gnssLoss_) risk_ += kWGnssLoss;
    if (armedMotion_) risk_ += kWArmedMotion;
    if (tamper_) risk_ += kWTamper;
    if (!powerOk_) risk_ += kWPowerLoss;

    Mode next = kNormal;
    if (risk_ >= cfg_.riskTheft || mode_ == kTheft) next = kTheft;
    else if (risk_ >= cfg_.riskAlert) next = kAlert;
    if (next != mode_) {
      mode_ = next;
      push(out, cap, n, kModeChange, s.t, here, double(mode_));
    }
    return n;
  }

  // Operator acknowledgement: clears the latched theft mode.
  void acknowledge() { mode_ = kNormal; }

  Mode mode() const { return mode_; }
  uint16_t risk() const { return risk_; }
  uint32_t reportIntervalS() const {
    return mode_ == kTheft ? cfg_.reportTheftS : mode_ == kAlert ? cfg_.reportAlertS : cfg_.reportNormalS;
  }

 private:
  static const uint32_t kNever = 0xFFFFFFFFu;

  void reset() {
    mode_ = kNormal;
    risk_ = 0;
    haveFix_ = false;
    last_.lat = 0.0;
    last_.lon = 0.0;
    outsideSince_ = slowSince_ = motionSince_ = gnssLostSince_ = kNever;
    deviation_ = stop_ = gnssLoss_ = armedMotion_ = tamper_ = false;
    powerOk_ = true;
    lastShockT_ = kNever;
  }

  static void push(Event* out, uint8_t cap, uint8_t& n, EventType type, uint32_t t, const Point& p,
                   double value) {
    if (n >= cap) return;
    out[n].type = type;
    out[n].t = t;
    out[n].p = p;
    out[n].value = value;
    ++n;
  }

  Plan* plan_;
  Config cfg_;
  Mode mode_;
  uint16_t risk_;
  bool started_;
  bool haveFix_;
  Point last_;
  uint32_t outsideSince_, slowSince_, motionSince_, gnssLostSince_;
  bool deviation_, stop_, gnssLoss_, armedMotion_, tamper_, powerOk_;
  uint32_t lastShockT_;
};

// ---------------------------------------------------------------- black box

struct Record {
  uint32_t t;
  int32_t latE5;
  int32_t lonE5;
  uint16_t speedDkmh;  // 0.1 km/h
  int16_t shockCg;     // 0.01 g
  uint16_t flags;      // bit0 gnss, bit1 cell, bit2 motion, bit3 tamper, bit4 power ok
  uint32_t seq;
};

// Ring buffer of N records. When an incident is flagged, the records before
// it (pre-trigger) and the next ones (post-trigger) are protected: normal
// recording cannot overwrite them. When every slot is protected the oldest
// one is overwritten, so recording never stops.
template <uint16_t N>
class BlackBox {
 public:
  BlackBox() : count_(0), total_(0), postLeft_(0), overwrittenProtected_(0) {
    for (uint16_t i = 0; i < N; ++i) prot_[i] = false;
  }

  void append(const Record& r) {
    uint16_t slot;
    if (count_ < N) {
      slot = count_++;
    } else {
      slot = victim();
      if (prot_[slot]) ++overwrittenProtected_;
    }
    buf_[slot] = r;
    buf_[slot].seq = total_++;
    prot_[slot] = postLeft_ > 0;
    if (postLeft_ > 0) --postLeft_;
  }

  // Flags an incident: protects the `pre` newest records and the next `post`.
  void flagIncident(uint16_t pre, uint16_t post) {
    for (uint16_t i = 0; i < count_; ++i)
      if (total_ - buf_[i].seq <= pre) prot_[i] = true;
    if (post > postLeft_) postLeft_ = post;
  }

  uint16_t count() const { return count_; }
  uint32_t total() const { return total_; }
  uint16_t protectedCount() const {
    uint16_t c = 0;
    for (uint16_t i = 0; i < count_; ++i)
      if (prot_[i]) ++c;
    return c;
  }
  uint32_t overwrittenProtected() const { return overwrittenProtected_; }

  // Copies the records in chronological order; returns how many were copied.
  uint16_t exportSorted(Record* out, uint16_t cap) const {
    uint16_t n = 0;
    uint32_t lastSeq = 0;
    bool first = true;
    while (n < cap && n < count_) {
      uint16_t best = N;
      for (uint16_t i = 0; i < count_; ++i) {
        if (!first && buf_[i].seq <= lastSeq) continue;
        if (best == N || buf_[i].seq < buf_[best].seq) best = i;
      }
      if (best == N) break;
      out[n++] = buf_[best];
      lastSeq = buf_[best].seq;
      first = false;
    }
    return n;
  }

 private:
  uint16_t victim() const {
    uint16_t oldest = 0, oldestUnprot = N;
    for (uint16_t i = 0; i < count_; ++i) {
      if (buf_[i].seq < buf_[oldest].seq) oldest = i;
      if (!prot_[i] && (oldestUnprot == N || buf_[i].seq < buf_[oldestUnprot].seq)) oldestUnprot = i;
    }
    return oldestUnprot != N ? oldestUnprot : oldest;
  }

  Record buf_[N];
  bool prot_[N];
  uint16_t count_;
  uint32_t total_;
  uint16_t postLeft_;
  uint32_t overwrittenProtected_;
};

// ---------------------------------------------------------------- last gasp

enum Channel { kChanNone = 0, kChanCellular, kChanMesh, kChanSatellite };

struct Links {
  bool cellular;
  bool meshPeer;   // a relay-capable fleet node is in range
  bool satellite;  // satellite service enabled and in view
};

// When power is cut or the device is destroyed, the hold-up capacitor gives
// a small energy budget. The last message goes out on the best channel that
// budget allows. Costs are relative units until measured on hardware.
class LastGasp {
 public:
  static const uint8_t kMaxTries = 2;

  LastGasp() : budget_(0.0), active_(false), delivered_(false), spent_(0.0) { clear(); }

  void arm(double budget) {
    budget_ = budget;
    clear();
  }
  void trigger() {
    if (!delivered_) active_ = true;
  }
  bool active() const { return active_ && !delivered_; }
  bool delivered() const { return delivered_; }
  double remaining() const { return budget_ - spent_; }

  static double cost(Channel c) {
    return c == kChanCellular ? 1.0 : c == kChanMesh ? 0.4 : c == kChanSatellite ? 2.5 : 0.0;
  }

  // Best channel that is available, affordable and not exhausted.
  Channel next(const Links& l) const {
    if (!active()) return kChanNone;
    if (viable(kChanCellular, l.cellular)) return kChanCellular;
    if (viable(kChanMesh, l.meshPeer)) return kChanMesh;
    if (viable(kChanSatellite, l.satellite)) return kChanSatellite;
    return kChanNone;
  }

  // Records the outcome of one attempt on a channel.
  void report(Channel c, bool acknowledged) {
    if (c == kChanNone) return;
    spent_ += cost(c);
    ++tries_[c];
    if (acknowledged) delivered_ = true;
  }

 private:
  void clear() {
    active_ = false;
    delivered_ = false;
    spent_ = 0.0;
    for (int i = 0; i < 4; ++i) tries_[i] = 0;
  }
  bool viable(Channel c, bool available) const {
    return available && tries_[c] < kMaxTries && cost(c) <= remaining();
  }

  double budget_;
  bool active_;
  bool delivered_;
  double spent_;
  uint8_t tries_[4];
};

// ---------------------------------------------------------------- relay queue

struct Message {
  uint32_t id;
  uint8_t priority;  // 0 routine ... 3 urgent
  uint8_t ttl;       // remaining forwards
  uint8_t hops;      // forwards so far
};

static const uint8_t kMaxHops = 6;

// Fixed-size store-and-forward queue. A node keeps messages it cannot
// deliver yet and hands them over when a better link shows up. Messages
// already seen are dropped (loop and duplicate protection).
template <uint8_t N>
class RelayQueue {
 public:
  RelayQueue() : count_(0), seenHead_(0), seq_(0) {
    for (uint8_t i = 0; i < kSeen; ++i) seen_[i] = 0;
  }

  // Accepts a message for relay. False when it is a duplicate, expired or
  // lower priority than everything in a full queue. At equal priority the
  // newest message replaces the oldest one (the latest position matters most).
  bool offer(const Message& m) {
    if (m.id == 0 || m.ttl == 0 || m.hops >= kMaxHops || wasSeen(m.id)) return false;
    uint8_t slot;
    if (count_ < N) {
      slot = count_++;
    } else {
      slot = 0;  // evict the lowest-priority, oldest entry if the new one beats it
      for (uint8_t i = 1; i < N; ++i)
        if (prio_(i) < prio_(slot) || (prio_(i) == prio_(slot) && order_[i] < order_[slot])) slot = i;
      if (m.priority < buf_[slot].priority) return false;
    }
    buf_[slot] = m;
    order_[slot] = seq_++;
    remember(m.id);
    return true;
  }

  // Removes the most urgent (then oldest) message, prepared for forwarding.
  bool popBest(Message& out) {
    if (count_ == 0) return false;
    uint8_t best = 0;
    for (uint8_t i = 1; i < count_; ++i)
      if (buf_[i].priority > buf_[best].priority ||
          (buf_[i].priority == buf_[best].priority && order_[i] < order_[best]))
        best = i;
    out = buf_[best];
    out.ttl = out.ttl > 0 ? uint8_t(out.ttl - 1) : 0;
    out.hops = uint8_t(out.hops + 1);
    buf_[best] = buf_[count_ - 1];
    order_[best] = order_[count_ - 1];
    --count_;
    return true;
  }

  uint8_t size() const { return count_; }

 private:
  static const uint8_t kSeen = 32;
  uint8_t prio_(uint8_t i) const { return buf_[i].priority; }
  bool wasSeen(uint32_t id) const {
    for (uint8_t i = 0; i < kSeen; ++i)
      if (seen_[i] == id) return true;
    return false;
  }
  void remember(uint32_t id) {
    seen_[seenHead_] = id;
    seenHead_ = uint8_t((seenHead_ + 1) % kSeen);
  }

  Message buf_[N];
  uint32_t order_[N];
  uint8_t count_;
  uint32_t seen_[kSeen];
  uint8_t seenHead_;
  uint32_t seq_;
};

}  // namespace redline

#endif
