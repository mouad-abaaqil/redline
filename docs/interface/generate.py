#!/usr/bin/env python3
"""A3 blueprint of the Redline control center (web/), drawn in the CAD frame.

Zones mirror the sections built by web/src/main.js and the sizes set in
web/src/style.css (desktop layout, 1440 px wide). Run from the repository:
    python3 docs/interface/generate.py
"""

import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
sys.path.insert(0, str(REPO / "cad"))
from drafting import balloon, line, rect, sheet_start, table, txt  # noqa: E402

OUT = REPO / "docs" / "blueprints" / "redline-interface-blueprint.svg"
K = 0.128          # mm per CSS pixel
X0, Y0 = 18, 28    # sheet origin of the 1440 px viewport


def px(x, y):
    return X0 + x * K, Y0 + y * K


def box(x, y, w, h, cls="frame"):
    sx, sy = px(x, y)
    return rect(sx, sy, w * K, h * K, cls)


def label(x, y, value, size=2.0, cls="sub", anchor="start"):
    sx, sy = px(x, y)
    return txt(sx, sy, value, size, cls, anchor)


def bars(x, y, widths, gap=16):
    return "".join(line(*px(x, y + i * gap), *px(x + w, y + i * gap), "thin") for i, w in enumerate(widths))


def wireframe():
    s = [box(0, 0, 1440, 1590, "border")]
    # 1 Sidebar.
    s += [box(0, 0, 272, 1590), label(26, 62, "REDLINE", 3.6, "accent"), label(26, 84, "TRACK  PREDICT  SURVIVE", 1.5),
          label(26, 130, "SHIPMENTS", 1.6)]
    for i, name in enumerate(["RL-1001  Paris to Lyon", "RL-2207  Paris to Lyon"]):
        s += [box(16, 144 + i * 96, 240, 86, "head" if i == 0 else "frame"), label(30, 172 + i * 96, name, 1.8, "label"),
              box(30, 196 + i * 96, 96, 22, "frame"), label(38, 212 + i * 96, "STATUS", 1.4, "accent")]
    s += [label(26, 360, "VIEWS", 1.6)]
    for i, name in enumerate(["Overview", "Map", "Alerts", "Links and ETA", "Black box"]):
        s += [label(40, 392 + i * 40, name, 1.8, "label")]
    # 2 Top bar.
    s += [box(272, 0, 1168, 64), label(310, 38, "REDLINE / CONTROL CENTER / RL-2207", 1.7),
          box(1000, 16, 190, 32), label(1014, 37, "SIMULATED SHIPMENTS", 1.5, "accent"),
          box(1226, 14, 190, 36, "head"), label(1240, 37, "EXPORT INCIDENT LOG", 1.6, "label-bold")]
    # 3 Hero + notice.
    s += [label(310, 110, "TRACK . PREDICT . SURVIVE", 1.6, "accent"), label(310, 168, "KNOW WHERE IT IS.", 4.4, "label-bold"),
          label(310, 218, "KNOW WHEN IT LANDS.", 4.4, "label-bold"), label(310, 268, "KNOW WHAT HAPPENED.", 4.4, "accent"),
          box(310, 296, 1090, 56), label(326, 330, "Simulation: route and weather are real open data, the rest is simulated", 1.6)]
    # 4 Trip head.
    s += [box(310, 366, 1090, 146, "head"), label(330, 396, "SHIPMENT RL-2207 . DEVICE RL-0107", 1.5, "accent"),
          label(330, 436, "PHARMACEUTICAL SHIPMENT, PARIS TO LYON", 2.6, "label-bold"), bars(330, 458, [300]),
          box(1210, 384, 170, 34, "head"), label(1224, 407, "THEFT SUSPECTED", 1.6, "label-bold")]
    # 5 KPIs.
    for i, k in enumerate(["ARRIVAL", "DEVICE MODE", "LAST CONTACT", "SPEED / RELAYS"]):
        x = 310 + i * 275
        s += [box(x, 528, 262, 104), label(x + 16, 556, k, 1.5), label(x + 16, 602, "00:00", 3.0, "label-bold"), bars(x + 16, 618, [150])]
    # 6 Map panel.
    s += [box(310, 650, 660, 560), label(328, 682, "LIVE MAP . POSITION, CORRIDOR AND RELAYS", 1.7, "label-bold"),
          box(326, 700, 628, 490, "frame")]
    route = [(380, 760), (470, 840), (540, 920), (640, 1000), (740, 1080), (820, 1140), (900, 1170)]
    s.append('<polyline class="wire" points="' + " ".join("%.2f,%.2f" % px(x, y) for x, y in route) + '"/>')
    cx, cy = px(560, 930)
    s.append(f'<circle cx="{cx:.2f}" cy="{cy:.2f}" r="6" class="balloon"/>')
    cx, cy = px(500, 1000)
    s.append(f'<circle cx="{cx:.2f}" cy="{cy:.2f}" r="3" class="dot"/>')
    # 7 Alerts panel.
    s += [box(986, 650, 414, 560), label(1004, 682, "PLATFORM FEED . ALERTS", 1.7, "label-bold")]
    for i in range(4):
        y = 706 + i * 124
        s += [box(1002, y, 382, 110, "head" if i == 0 else "frame"), box(1018, y + 20, 14, 14),
              bars(1048, y + 34, [250, 300], 24), label(1048, y + 98, "CRITICAL   FLEET RELAY", 1.4, "accent")]
    # 8 Replay.
    s += [box(310, 1226, 1090, 96), label(334, 1262, "REPLAY", 1.8, "label-bold"), line(*px(334, 1290), *px(1180, 1290), "wire"),
          label(1280, 1296, "01:12:50", 3.0, "label-bold")]
    # 9 Links, ETA, last gasp.
    s += [box(310, 1338, 1090, 212, "frame"), label(328, 1368, "LINKS . MODES . ARRIVAL ESTIMATE OR LAST GASP", 1.7, "label-bold"),
          box(328, 1386, 500, 34), box(328, 1432, 500, 34), box(860, 1386, 520, 100), label(880, 1440, "ETA CHART / LAST GASP LOG", 1.6)]
    # 10 Black box.
    return "".join(s)


ZONES = [  # (n, x, y anchor in px, balloon offset mm, zone, content, data / action)
    (1, 136, 620, (-8, 0), "Sidebar", "Logo, shipment cards with live status, view links", "One card per shipment"),
    (2, 640, 32, (0, -7), "Top bar", "Breadcrumb, simulation pill, export", "CSV of the incident log"),
    (3, 1150, 220, (8, -4), "Hero and notice", "Promise, and what is real versus simulated", "Always visible"),
    (4, 1400, 438, (6, -2), "Shipment header", "Title, cargo, vehicle, status chip", "tripStatus()"),
    (5, 1400, 580, (6, 0), "KPIs", "Arrival, device mode, last contact, speed or relays", "platformView()"),
    (6, 310, 940, (-8, 0), "Live map", "Corridor, plan, track, alerts, fleet relays", "Leaflet + OpenStreetMap"),
    (7, 1392, 960, (6, 0), "Alerts feed", "What the platform received, and what is still stored on the device", "Severity, channel, delay"),
    (8, 1180, 1290, (6, 12), "Replay", "Scrub or play the whole trip", "Filters what is known at time t"),
    (9, 860, 1440, (0, 10), "Links, modes, ETA", "Link and mode strips, plan versus live ETA, last gasp", "eta.js, model.js"),
]


def build():
    s = sheet_start(1, "INTERFACE: CONTROL CENTER", "RL-UI-01", "about 0.14 mm / px", total=1,
                    subtitle="Redline control center (web/), desktop view at 1440 px",
                    revision="Dashboard interface plan",
                    notes=["1. Zones and labels taken from web/src/main.js; widths and grids from web/src/style.css.",
                           "2. CSS breakpoints: 1250 px, 930 px, 620 px (panels stack, sidebar hides on mobile).",
                           "3. Demo data in web/src/demo-trips.json: real route and weather, simulated vehicles and events.",
                           "4. Rule: the platform never shows an alert it has not received. Stored alerts are shown as stored."],
                    material="-")
    s.append(wireframe())
    for n, x, y, (dx, dy), *_ in ZONES:
        ax, ay = px(x, y)
        s.append(balloon(ax, ay, ax + dx, ay + dy, n))
    rows = [["NO", "ZONE", "CONTENT", "DATA / ACTION"]] + [[str(n), z, c, a] for n, _, _, _, z, c, a in ZONES]
    s.append(txt(252, 34, "ZONE LIST", 3.2, "label-bold"))
    s.append(table(252, 37, [7, 26, 76, 42], rows, 5.6, 2.0, 1.75))
    x, y, k = 252, 102, 0.34
    s.append(txt(x, y - 4, "DETAIL A: ALERT CARD (3:1)", 3, "label-bold"))
    s.append(rect(x, y, 397 * k, 110 * k, "frame"))
    s.append(f'<circle cx="{x + 24 * k:.2f}" cy="{y + 26 * k:.2f}" r="{7 * k:.2f}" class="dot"/>')
    s.append(txt(x + 50 * k, y + 30 * k, "Unauthorized stop", 2.6, "label-bold"))
    s.append(txt(x + 322 * k, y + 30 * k, "00:28:00", 2.2, "label"))
    s.append(txt(x + 50 * k, y + 56 * k, "Stopped 10 min outside every authorized zone", 2.1, "sub"))
    s.append(txt(x + 50 * k, y + 92 * k, "HIGH", 2.0, "accent"))
    s.append(txt(x + 100 * k, y + 92 * k, "FLEET RELAY . RL-PEER-07", 2.0, "label"))
    s.append(txt(x + 230 * k, y + 92 * k, "DELIVERED 9 min LATER", 2.0, "accent"))
    yy = y + 110 * k + 8
    for i, t in enumerate(["a  severity dot", "b  title and time of the event on the device", "c  detail", "d  severity, channel, delay before delivery"]):
        s.append(txt(x, yy + i * 5.2, t, 2.2, "label"))
    s.append(txt(252, 196, "USER FLOW", 3, "label-bold"))
    for i, t in enumerate(["1. Pick a shipment (1), read its status chip and KPIs (4, 5).",
                           "2. Follow the alerts (7); each shows the channel it travelled and how late it arrived.",
                           "3. Click an alert to centre the map on it (6).",
                           "4. Replay (8) to see only what the platform knew at that moment.",
                           "5. Check the arrival estimate or the last gasp (9). Export the log (2)."]):
        s.append(txt(252, 202 + i * 5.4, t, 2.25, "label"))
    s.append("</svg>")
    return "".join(s)


def main():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(build(), encoding="utf-8")
    subprocess.run(["rsvg-convert", "-f", "pdf", "-o", str(OUT.with_suffix(".pdf")), str(OUT)], check=True)
    subprocess.run(["rsvg-convert", "-w", "2200", "-o", str(OUT.with_suffix(".png")), str(OUT)], check=True)
    print(f"Generated {OUT.name} (+ .pdf, .png)")


if __name__ == "__main__":
    main()
