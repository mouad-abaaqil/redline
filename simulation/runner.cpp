// Runs the real firmware core (firmware/RedlineCore.h) over a simulated trip.
//
// Input (text, one record per line):
//   CFG <name> <value>                       tracker settings
//   G <budget> <satelliteEnabled>            last-gasp energy budget
//   R <lat> <lon>                            planned route point
//   Z <lat> <lon> <radiusM>                  authorized stop zone
//   C <lat> <lon> <plannedS> <radiusM>       schedule checkpoint
//   S <t> <lat> <lon> <speedKmh> <gnss> <cell> <peerId> <peerCell> <sat> <motion>
//     <tamperMount> <tamperCover> <power> <shockG> <armed>
//
// Output: JSON lines. k=t tick, k=e device event, k=d message delivered,
// k=g last-gasp attempt, k=end summary.

#include "../firmware/RedlineCore.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

using namespace redline;

static const char* eventName(EventType t) {
  switch (t) {
    case kDeviationStart: return "deviation_start";
    case kDeviationEnd: return "deviation_end";
    case kUnauthorizedStop: return "unauthorized_stop";
    case kStopEnd: return "stop_end";
    case kCheckpoint: return "checkpoint";
    case kScheduleDelay: return "schedule_delay";
    case kGnssLoss: return "gnss_loss";
    case kGnssRestored: return "gnss_restored";
    case kArmedMotion: return "armed_motion";
    case kTamper: return "tamper";
    case kPowerLoss: return "power_loss";
    case kShock: return "shock";
    case kModeChange: return "mode_change";
    default: return "none";
  }
}

static const char* channelName(Channel c) {
  return c == kChanCellular ? "cellular" : c == kChanMesh ? "mesh" : c == kChanSatellite ? "satellite" : "none";
}

// Priority of the urgent message an event produces (0 = none).
static uint8_t eventPriority(EventType t, double value) {
  switch (t) {
    case kModeChange:
      return value >= 2.0 ? 3 : value >= 1.0 ? 2 : 0;
    case kDeviationStart:
    case kUnauthorizedStop:
    case kGnssLoss:
    case kArmedMotion:
    case kTamper:
    case kPowerLoss:
    case kShock:
      return 3;
    case kScheduleDelay:
      return 2;
    case kCheckpoint:
      return 1;
    default:
      return 0;
  }
}

struct Meta {
  uint32_t id;
  uint32_t createdT;
  double lat, lon;
  int mode;
  int evt;
};

static void applyConfig(Config& c, const char* key, double v) {
  if (!strcmp(key, "corridorM")) c.corridorM = v;
  else if (!strcmp(key, "deviationConfirmS")) c.deviationConfirmS = uint32_t(v);
  else if (!strcmp(key, "stopSpeedKmh")) c.stopSpeedKmh = v;
  else if (!strcmp(key, "stopConfirmS")) c.stopConfirmS = uint32_t(v);
  else if (!strcmp(key, "delayWarnS")) c.delayWarnS = uint32_t(v);
  else if (!strcmp(key, "armedMotionConfirmS")) c.armedMotionConfirmS = uint32_t(v);
  else if (!strcmp(key, "gnssLossConfirmS")) c.gnssLossConfirmS = uint32_t(v);
  else if (!strcmp(key, "shockThresholdG")) c.shockThresholdG = v;
  else if (!strcmp(key, "reportNormalS")) c.reportNormalS = uint32_t(v);
  else if (!strcmp(key, "reportAlertS")) c.reportAlertS = uint32_t(v);
  else if (!strcmp(key, "reportTheftS")) c.reportTheftS = uint32_t(v);
}

int main(int argc, char** argv) {
  FILE* in = argc > 1 ? fopen(argv[1], "r") : stdin;
  if (!in) {
    fprintf(stderr, "cannot open input\n");
    return 1;
  }

  static Plan plan;
  Config cfg;
  Tracker tracker;
  static BlackBox<256> bb;
  LastGasp gasp;
  static RelayQueue<16> queue;
  static Meta metas[128];
  for (int i = 0; i < 128; ++i) metas[i].id = 0;

  double budget = 3.0;
  bool satEnabled = false;
  bool begun = false;
  bool anyReport = false;
  uint32_t lastReport = 0;
  uint32_t nextId = 1;
  uint32_t undelivered = 0;
  const double crashG = 150.0;

  char line[512];
  while (fgets(line, sizeof line, in)) {
    char tag[8];
    if (sscanf(line, "%7s", tag) != 1) continue;

    if (!strcmp(tag, "CFG")) {
      char key[48];
      double v;
      if (sscanf(line, "CFG %47s %lf", key, &v) == 2) applyConfig(cfg, key, v);
    } else if (!strcmp(tag, "G")) {
      int sat;
      if (sscanf(line, "G %lf %d", &budget, &sat) == 2) satEnabled = sat != 0;
    } else if (!strcmp(tag, "R")) {
      double a, b;
      if (sscanf(line, "R %lf %lf", &a, &b) == 2) plan.addRoutePoint(a, b);
    } else if (!strcmp(tag, "Z")) {
      double a, b, r;
      if (sscanf(line, "Z %lf %lf %lf", &a, &b, &r) == 3) plan.addZone(a, b, r);
    } else if (!strcmp(tag, "C")) {
      double a, b, r;
      unsigned long ps;
      if (sscanf(line, "C %lf %lf %lu %lf", &a, &b, &ps, &r) == 4) plan.addCheckpoint(a, b, uint32_t(ps), r);
    } else if (!strcmp(tag, "S")) {
      if (!begun) {
        tracker.begin(&plan, cfg);
        gasp.arm(budget);
        begun = true;
      }
      unsigned long t;
      Sample s;
      int gnss, cell, peerId, peerCell, sat, motion, tm, tc, power, armed;
      if (sscanf(line, "S %lu %lf %lf %lf %d %d %d %d %d %d %d %d %d %lf %d", &t, &s.p.lat, &s.p.lon,
                 &s.speedKmh, &gnss, &cell, &peerId, &peerCell, &sat, &motion, &tm, &tc, &power,
                 &s.shockG, &armed) != 15)
        continue;
      s.t = uint32_t(t);
      s.gnssValid = gnss != 0;
      s.cellOk = cell != 0;
      s.motion = motion != 0;
      s.tamperMount = tm != 0;
      s.tamperCover = tc != 0;
      s.powerOk = power != 0;
      s.armed = armed != 0;

      Event ev[8];
      const uint8_t n = tracker.update(s, ev, 8);
      const Point here = s.p;  // the scenario repeats the last known fix while jammed

      Record rec;
      rec.t = s.t;
      rec.latE5 = int32_t(here.lat * 1e5);
      rec.lonE5 = int32_t(here.lon * 1e5);
      rec.speedDkmh = uint16_t(s.speedKmh * 10.0);
      rec.shockCg = int16_t(s.shockG * 100.0);
      rec.flags = uint16_t((s.gnssValid ? 1 : 0) | (s.cellOk ? 2 : 0) | (s.motion ? 4 : 0) |
                           ((s.tamperMount || s.tamperCover) ? 8 : 0) | (s.powerOk ? 16 : 0));
      rec.seq = 0;
      bb.append(rec);

      const Links links = {s.cellOk, peerId >= 0 && peerCell != 0, satEnabled && sat != 0};
      bool incident = false;
      for (uint8_t i = 0; i < n; ++i) {
        printf("{\"k\":\"e\",\"t\":%lu,\"type\":\"%s\",\"lat\":%.6f,\"lon\":%.6f,\"value\":%.2f}\n",
               (unsigned long)ev[i].t, eventName(ev[i].type), ev[i].p.lat, ev[i].p.lon, ev[i].value);
        const uint8_t prio = eventPriority(ev[i].type, ev[i].value);
        if (prio >= 3) incident = true;
        if (ev[i].type == kPowerLoss || (ev[i].type == kShock && ev[i].value >= crashG)) gasp.trigger();
        if (prio > 0) {
          Message m = {nextId++, prio, 6, 0};
          if (queue.offer(m)) {
            Meta& mt = metas[m.id % 128];
            mt.id = m.id;
            mt.createdT = s.t;
            mt.lat = ev[i].p.lat;
            mt.lon = ev[i].p.lon;
            mt.mode = int(tracker.mode());
            mt.evt = int(ev[i].type);
          }
        }
      }
      if (incident) bb.flagIncident(20, 20);

      // Periodic report at the interval the current mode asks for.
      if (s.powerOk && (!anyReport || s.t - lastReport >= tracker.reportIntervalS())) {
        const uint8_t prio = tracker.mode() == kTheft ? 2 : tracker.mode() == kAlert ? 1 : 0;
        Message m = {nextId++, prio, 6, 0};
        if (queue.offer(m)) {
          Meta& mt = metas[m.id % 128];
          mt.id = m.id;
          mt.createdT = s.t;
          mt.lat = here.lat;
          mt.lon = here.lon;
          mt.mode = int(tracker.mode());
          mt.evt = 0;
        }
        anyReport = true;
        lastReport = s.t;
      }

      // Pick the link for normal traffic: cellular, else a fleet peer; satellite only in theft mode.
      Channel ch = kChanNone;
      if (s.powerOk) {
        if (links.cellular) ch = kChanCellular;
        else if (links.meshPeer) ch = kChanMesh;
        else if (links.satellite && tracker.mode() == kTheft) ch = kChanSatellite;
      }
      Message out;
      int sent = 0;
      while (ch != kChanNone && sent < 8 && queue.popBest(out)) {
        Meta& mt = metas[out.id % 128];
        const uint8_t hops = ch == kChanMesh ? 1 : 0;
        printf("{\"k\":\"d\",\"t\":%lu,\"id\":%lu,\"created\":%lu,\"ch\":\"%s\",\"peer\":%d,\"hops\":%u,\"prio\":%u,"
               "\"lat\":%.6f,\"lon\":%.6f,\"mode\":%d,\"evt\":%d}\n",
               (unsigned long)s.t, (unsigned long)out.id, (unsigned long)(mt.id == out.id ? mt.createdT : s.t),
               channelName(ch), ch == kChanMesh ? peerId : -1, hops, out.priority, mt.lat, mt.lon, mt.mode, mt.evt);
        ++sent;
      }

      // Last gasp: after power loss, try the best channel the remaining energy allows.
      if (gasp.active()) {
        const Channel g = gasp.next(links);
        if (g != kChanNone) {
          const bool ok = g == kChanCellular ? links.cellular : g == kChanMesh ? links.meshPeer : links.satellite;
          gasp.report(g, ok);
          printf("{\"k\":\"g\",\"t\":%lu,\"ch\":\"%s\",\"ok\":%d,\"peer\":%d,\"remaining\":%.2f,\"lat\":%.6f,\"lon\":%.6f,"
                 "\"bbCount\":%u,\"bbProtected\":%u}\n",
                 (unsigned long)s.t, channelName(g), ok ? 1 : 0, g == kChanMesh ? peerId : -1, gasp.remaining(),
                 here.lat, here.lon, bb.count(), bb.protectedCount());
        }
      }

      printf("{\"k\":\"t\",\"t\":%lu,\"mode\":%d,\"risk\":%u,\"rep\":%lu,\"q\":%u,\"bb\":[%u,%u]}\n",
             (unsigned long)s.t, int(tracker.mode()), tracker.risk(), (unsigned long)tracker.reportIntervalS(),
             queue.size(), bb.count(), bb.protectedCount());
    }
  }
  undelivered = queue.size();
  printf("{\"k\":\"end\",\"bbCount\":%u,\"bbProtected\":%u,\"bbTotal\":%lu,\"bbOverwrittenProtected\":%lu,"
         "\"undelivered\":%lu}\n",
         bb.count(), bb.protectedCount(), (unsigned long)bb.total(), (unsigned long)bb.overwrittenProtected(),
         (unsigned long)undelivered);
  if (in != stdin) fclose(in);
  return 0;
}
