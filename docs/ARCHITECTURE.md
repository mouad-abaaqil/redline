# Architecture

Redline has three parts that only talk through messages: the **device**, the **links**, and the **platform**.

```
 device (RedlineCore + nRF9151)           links                       platform
 ┌──────────────────────────────┐   ┌────────────────────┐   ┌───────────────────────────┐
 │ sensors → Tracker (risk, mode)│   │ 1 cellular          │   │ receives messages         │
 │ BlackBox (ring, protected)    │──▶│ 2 fleet relay (mesh)│──▶│ ETA engine (eta.js)       │
 │ RelayQueue (store and forward)│   │ 3 satellite (opt.)  │   │ alerts, dead-man switch   │
 │ LastGasp (energy budget)      │   └────────────────────┘   │ control center (web/)     │
 └──────────────────────────────┘                             └───────────────────────────┘
```

## What runs where, and why

| Decision | Where | Reason |
| --- | --- | --- |
| Corridor, stop, jamming, theft score, mode | **Device** | Must work with no network. The alert is queued and leaves with the first link. |
| Which channel for which message | **Device** | Only the device knows which links are up and how much energy is left. |
| Arrival estimate | **Platform** | Needs open traffic and weather data and the speeds of the whole fleet. |
| *Device silent* alarm | **Platform** | A dead device cannot report its own death. |

## The device: `firmware/RedlineCore.h`

Plain C++11, no heap, no dependency. Fixed-size buffers: 400 route points, 16 zones, 16 checkpoints, a 256-slot black box in the demo.

- **`Tracker`**: takes one `Sample` per tick (position, speed, GNSS and cellular state, motion, tamper, power, shock, armed) and returns events. A condition must hold for a confirmation time before it fires (2 min for a deviation, 10 min for a stop, 60 s for GNSS loss, 10 s for movement while armed), and a deviation clears only inside 80 % of the corridor, to avoid flapping.
- **Risk and mode.** Each active condition adds a weight; the sum selects the mode. Deviation 40, stop 30, GNSS loss 40, armed motion 60, tamper 100, power loss 100. Alert starts at 40, theft at 100. **Theft is latched** until an operator acknowledges it. The mode sets the reporting interval: 15 min, 60 s, 10 s.
- **`BlackBox<N>`**: ring buffer. `flagIncident(pre, post)` protects the `pre` newest records and the next `post`. When every slot is protected, the oldest is overwritten so recording never stops (the count of overwritten protected records is kept).
- **`LastGasp`**: an energy budget. `next(links)` returns the best affordable channel: cellular, then mesh, then satellite, at most 2 tries per channel. Costs are relative units to calibrate on hardware.
- **`RelayQueue<N>`**: messages carry a priority (0 routine to 3 urgent), a TTL and a hop count. Duplicates are dropped, urgent messages leave first, a full queue evicts the oldest lowest-priority message, and a routine message never displaces an urgent backlog.

## The platform: `web/`

- `eta.js`: the estimate (see [ETA.md](./ETA.md)).
- `model.js`: `platformView(trip, t)` is the key function. It returns only what **was delivered** by time `t`. Everything else is shown as *stored on the device*. `tripStatus` turns that into the headline.
- `main.js`: rendering with Leaflet. The replay slider sets `t`; nothing the platform could not know at `t` is displayed.

## Data flow of one theft alert, in the simulation

1. `Tracker.update()` fires `unauthorized_stop` at 22:28:00 and the risk reaches theft level.
2. The runner creates a priority-3 message in the `RelayQueue`.
3. Cellular is down and no peer is in range: the message stays queued.
4. At 22:37:10 a fleet truck comes within 2 km. The message is popped and delivered through it.
5. `platformView` shows the alert from 22:37:10 with the badge *DELIVERED 9 min LATER*, and the event time stays 22:28:00.

## Simulation boundary

Simulated: vehicles, traffic accident, jammer, thief, fleet peers, radio. **Real:** the road geometry and speeds (OpenStreetMap), the weather (Open-Meteo), and every device decision (the core is compiled and run unchanged by `simulation/runner.cpp`). Radio range and energy costs are assumptions, listed in the README.
