# Simulation

Two simulated shipments, Paris to Lyon, built from **real open data** and driven by the **real firmware core**.

```
simulation/data/            snapshots of real data: route-a.json, route-b.json, weather.json
simulation/runner.cpp       compiles with firmware/RedlineCore.h and runs it over a trip
simulation/make-scenario.mjs  builds the vehicles, injects the events, writes web/src/demo-trips.json
simulation/fetch-data.mjs   refreshes the snapshots from OSRM and Open-Meteo
```

## Run

```sh
node simulation/make-scenario.mjs      # needs g++ and Node 20+; rewrites web/src/demo-trips.json
node simulation/fetch-data.mjs         # optional: refetch the open data (network)
```

The generator is deterministic (seeded noise): the same data gives the same trips.

## What is real, what is simulated

| Real | Simulated |
| --- | --- |
| The road: 465 km Paris to Lyon with OpenStreetMap speeds, and a 52 km detour road | The vehicles and their speed noise |
| The weather forecast along the route, hour by hour (fog included) | The traffic accident (published at a chosen time) |
| Every device decision: the code of `RedlineCore.h` runs unchanged in `runner.cpp` | The GNSS jammer, the dead zone, the thief |
| The ETA engine `web/src/eta.js` | Fleet peers and their 2 km relay range (an assumption) |

The traffic congestion pattern in the ETA model is synthetic (see [../docs/ETA.md](../docs/ETA.md)).

## Trips

**RL-1001, the arrival time that learns.** A truck leaves at 05:30 (Paris time), planned arrival 12:22. It meets real fog and a simulated accident. It arrives at 13:14, 52 minutes late. The plan is off by 52 min; the live estimate is off by 10 min one hour before arrival and by 1 min fifteen minutes before. One shock is recorded and sent. The platform raises two ETA-slip alerts. Cellular coverage is lost in one valley and the stored reports go out afterwards.

**RL-2207, theft.** The truck leaves the corridor, GNSS is jammed, the truck stops at an isolated site and cellular is gone. The stop alert waits 9 minutes for a fleet relay. The device is torn off, then its power is cut: the tamper alert and the last gasp go over the fleet relay, and the platform raises the dead-man alarm.

## Runner protocol

`runner.cpp` reads lines: `CFG`, `G` (hold-up budget), `R` (route point), `Z` (authorized zone), `C` (checkpoint), `S` (one sample per tick). It writes JSON lines: `t` ticks, `e` device events, `d` delivered messages with their channel, `g` last-gasp attempts, and a final `end` summary of the black box.
