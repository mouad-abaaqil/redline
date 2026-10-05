# Enclosure and drawings

A parametric enclosure for the Redline tracker and the five A3 sheets that describe it, generated from one 3D model.

```sh
python3.12 -m venv .venv
.venv/bin/pip install -r cad/requirements.txt
.venv/bin/python cad/generate.py --check     # checks only
.venv/bin/python cad/generate.py             # sheets, PDF, STEP, STL
```

`rsvg-convert` is needed to produce the PDF and PNG files.

| File | Role |
| --- | --- |
| `generate.py` | Dimensions, enclosure, checks, the five sheets |
| `components.py` | The 23 parts as solids, the floorplan, the netlist validator |
| `drafting.py` | Shared A3 frame: zone border A to F and 1 to 8, revision and title blocks |
| `output/` | `redline-sheet-1..5` (SVG, PDF, PNG), base, lid and assembly STEP, base and lid STL |

## Sheets

1. General assembly: plan, front and side views, exact section through the USB-C port, isometric.
2. Board RL-MB-01 at 2:1 with callouts and the antenna keep-out, the tamper plunger in an exact section at 3:1, lid and base.
3. Exploded view of every part on one page with 25 callouts and a 28-line parts list.
4. Electrical architecture: block diagram, rails, buses, firmware points, communication layers.
5. Wiring: all 33 nets, connector pin-outs, the battery cable, power-up sequence.

The script also writes `docs/blueprints/redline-plans-A3.pdf` (the five sheets) and `redline-exploded-view.svg/png`.

## What `--check` proves

- The enclosure outline, wall openings and the four screw bores are consistent.
- All 23 parts lie inside the cavity and keep at least 0.2 mm from walls, screw bosses and each other. Parts on the board touch it by design only.
- No part enters the LTE antenna keep-out or hangs over a screw notch of the board.
- The netlist is valid: unique terminals and references, every supply pin on its rail with the rail inside the part's range, distinct SPI chip selects and I²C addresses, no short between VSYS, V1V8 and the hold-up rail, and the hold-up capacitor stores at least twice the last-gasp energy.

It does not replace a print test, a mechanical review, or an RF review.
