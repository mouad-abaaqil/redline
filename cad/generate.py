#!/usr/bin/env python3
"""Parametric enclosure, board layout and A3 drawing set for Redline.

All dimensions are millimetres. Run with Python 3.12 and build123d 0.13.0.
The enclosure is a design study, not a measured or production-ready part.
Component outlines come from hardware/netlist.json; values marked "indicative"
there are envelopes used for clearance checks.
"""

from __future__ import annotations

import argparse
import math
import shutil
from dataclasses import dataclass
from pathlib import Path
import subprocess

from build123d import (
    Align, Box, Cylinder, Compound, Plane, Pos, Rot, Shape,
    export_step, export_stl, fillet, section,
)

from components import (
    ANT1_KEEPOUT, FLOORPLAN, PLUNGER_XY, build_parts, load_netlist, validate_netlist, wire_routes
)
from drafting import DATE, balloon, dim_h, dim_v, line, rect, sheet_start, table, txt

MIN = (Align.CENTER, Align.CENTER, Align.MIN)


@dataclass(frozen=True)
class Dimensions:
    length: float = 92
    width: float = 62
    height: float = 22
    base_height: float = 15
    wall: float = 3.5
    floor: float = 3
    roof: float = 2
    corner_radius: float = 7
    screw_x: float = 38
    screw_y: float = 23.5
    boss_radius: float = 3.5
    screw_diameter: float = 2.7
    # External strap ears at both ends, so the strap never crosses the cavity.
    ear_length: float = 10
    ear_thickness: float = 5
    strap_slot_width: float = 4
    strap_slot_length: float = 30
    # Main board RL-MB-01, held above the battery.
    pcb_length: float = 80
    pcb_width: float = 52
    pcb_thickness: float = 1.0
    pcb_z: float = 11.0
    pcb_notch_gap: float = 0.7
    foam: float = 0.5
    battery_x: float = -6
    # Openings: USB-C and side button in the -X wall, light pipe in the lid, tamper plunger in the floor.
    usb_y: float = 8
    usb_width: float = 10
    usb_height: float = 4.6
    button_y: float = -10
    button_d: float = 4
    light_pipe_d: float = 3
    light_hole_d: float = 3.4
    plunger_d: float = 4
    plunger_hole_d: float = 4.4
    min_clearance: float = 0.2


D = Dimensions()
ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
OUT = ROOT / "output"
SHEETS = 5


def rounded_box(length: float, width: float, height: float, z0: float, radius: float):
    solid = Pos(0, 0, z0) * Box(length, width, height, align=(Align.CENTER, Align.CENTER, Align.MIN))
    vertical = [e for e in solid.edges() if abs((e.end_point() - e.start_point()).Z) > height - 0.01]
    return fillet(vertical, radius)


def screw_centers(d: Dimensions):
    return [(x, y) for x in (-d.screw_x, d.screw_x) for y in (-d.screw_y, d.screw_y)]


def board_top(d: Dimensions):
    return d.pcb_z + d.pcb_thickness


def make_parts(d: Dimensions = D):
    # Open topped base. The cut extends through the top face.
    base = rounded_box(d.length, d.width, d.base_height, 0, d.corner_radius)
    cavity = rounded_box(d.length - 2*d.wall, d.width - 2*d.wall,
                         d.base_height - d.floor + 1, d.floor,
                         d.corner_radius - d.wall)
    base = base - cavity
    # Four coaxial pillars and through bores. The same centres drive the lid.
    for x, y in screw_centers(d):
        base += Pos(x, y, d.floor) * Cylinder(d.boss_radius, d.base_height-d.floor, align=MIN)
    for x, y in screw_centers(d):
        base -= Pos(x, y, -1) * Cylinder(d.screw_diameter/2, d.base_height+2, align=MIN)
    # Two end ears carry the strap outside the electronics volume.
    for sx in (-1, 1):
        ear_x = sx * (d.length/2 + d.ear_length/2 - 1)
        ear = Pos(ear_x, 0, 0) * Box(d.ear_length + 2, d.strap_slot_length + 10, d.ear_thickness, align=MIN)
        ear -= Pos(ear_x + sx, 0, -1) * Box(d.strap_slot_width, d.strap_slot_length, d.ear_thickness + 2, align=MIN)
        base += ear
    # USB-C and button openings, aligned with J1 and SW1 on the board.
    top = board_top(d)
    base -= Pos(-d.length/2, d.usb_y, top + 1.6 - d.usb_height/2) * Box(3*d.wall, d.usb_width, d.usb_height, align=MIN)
    base -= Pos(-d.length/2, d.button_y, top + 1.75) * Rot(0, 90, 0) * Cylinder(d.button_d/2, 3*d.wall)
    # Tamper plunger bore through the floor.
    base -= Pos(PLUNGER_XY[0], PLUNGER_XY[1], -1) * Cylinder(d.plunger_hole_d/2, d.floor + 2, align=MIN)

    # Cap is a separate hollow part. Its four sleeves meet the base pillars.
    lid_height = d.height - d.base_height
    lid = rounded_box(d.length, d.width, lid_height, d.base_height, d.corner_radius)
    lid -= rounded_box(d.length - 2*d.wall, d.width - 2*d.wall,
                       lid_height-d.roof+0.1, d.base_height-0.1,
                       d.corner_radius-d.wall)
    for x, y in screw_centers(d):
        lid += Pos(x, y, d.base_height) * Cylinder(d.boss_radius, lid_height-d.roof, align=MIN)
    for x, y in screw_centers(d):
        lid -= Pos(x, y, d.base_height-1) * Cylinder(d.screw_diameter/2, lid_height+2, align=MIN)
    lx, ly = FLOORPLAN["D1"]
    lid -= Pos(lx, ly, d.base_height) * Cylinder(d.light_hole_d/2, lid_height + 1, align=MIN)
    return base, lid, build_parts(d)


def check(parts, d: Dimensions = D):
    base, lid, electronics = parts
    validate_netlist(load_netlist())
    assert d.height > d.base_height
    assert d.screw_x + d.boss_radius < d.length/2-d.wall
    assert d.screw_y + d.boss_radius <= d.width/2-d.wall + 1e-6
    for part, z0, z1 in ((base, 0, d.base_height), (lid, d.base_height, d.height)):
        bb = part.bounding_box()
        assert abs(bb.size.Y-d.width) < 1e-5
        assert abs(bb.min.Z-z0) < 1e-5 and abs(bb.max.Z-z1) < 1e-5
        assert part.volume > 0
    assert abs(base.bounding_box().size.X - (d.length + 2*d.ear_length)) < 1e-5
    assert abs(lid.bounding_box().size.X - d.length) < 1e-5
    for x, y in screw_centers(d):
        probe = Pos(x, y, 0) * Cylinder(d.screw_diameter/2-0.1, d.height)
        assert base.intersect(probe) is None and lid.intersect(probe) is None
    # The USB-C and button openings really cross the wall in front of J1/SW1.
    top = board_top(d)
    for y, z in ((d.usb_y, top + 1.6), (d.button_y, top + 1.75)):
        probe = Pos(-d.length/2 - 1, y, z) * Box(2*d.wall + 2, 0.5, 0.5)
        assert base.intersect(probe) is None, f"Wall opening at y={y} is blocked"
    # Every part lies inside the cavity and keeps clear of walls, bosses and
    # every other part. Parts on PCB1 touch the board by design only.
    inner_x, inner_y = d.length/2 - d.wall, d.width/2 - d.wall
    board = next(p for p in electronics if p.ref == "PCB1")
    for p in electronics:
        bb = p.solid.bounding_box()
        assert bb.min.X >= -inner_x and bb.max.X <= inner_x, f"{p.ref} outside cavity in X"
        assert bb.min.Y >= -inner_y and bb.max.Y <= inner_y, f"{p.ref} outside cavity in Y"
        if p.in_cavity:
            assert bb.min.Z >= d.floor and bb.max.Z <= d.height - d.roof, f"{p.ref} outside cavity in Z"
        if p.on_board:
            assert abs(bb.min.Z - top) < 1e-6, f"{p.ref} not seated on PCB1"
            assert abs(bb.min.X) <= d.pcb_length/2 + 1 and abs(bb.max.X) <= d.pcb_length/2 + 1, f"{p.ref} off board"
            assert abs(bb.min.Y) <= d.pcb_width/2 and abs(bb.max.Y) <= d.pcb_width/2, f"{p.ref} off board"
            kx0, kx1, ky0, ky1 = ANT1_KEEPOUT
            if p.ref != "ANT1":
                assert bb.max.X <= kx0 or bb.min.X >= kx1 or bb.max.Y <= ky0 or bb.min.Y >= ky1, \
                    f"{p.ref} inside the LTE antenna keep-out"
        for shell, label in ((base, "base"), (lid, "lid")):
            gap = p.solid.distance_to(shell)
            assert gap >= d.min_clearance - 1e-6, f"{p.ref} touches {label} ({gap:.2f} mm)"
    for i, a in enumerate(electronics):
        for b in electronics[i+1:]:
            if {a.ref, b.ref} & {"PCB1"} and (a.on_board or b.on_board):
                continue
            gap = a.solid.distance_to(b.solid)
            assert gap >= d.min_clearance - 1e-6, f"{a.ref} touches {b.ref} ({gap:.2f} mm)"
    # No component hangs over a screw notch of the board.
    for p in electronics:
        if not p.on_board:
            continue
        bb = p.solid.bounding_box()
        for x, y in screw_centers(d):
            nx = min(max(x, bb.min.X), bb.max.X)
            ny = min(max(y, bb.min.Y), bb.max.Y)
            assert math.hypot(nx - x, ny - y) >= d.boss_radius + d.pcb_notch_gap, f"{p.ref} hangs over a board notch"
    refs = {c["ref"] for c in load_netlist()["components"]}
    assert refs == {p.ref for p in electronics}, "Netlist and CAD part list differ"
    assert board.solid.distance_to(base) >= d.min_clearance - 1e-6


# ---------------------------------------------------------------- projection

def polyline(edge, n=18):
    # Topological edges are projected by OpenCascade; sample curved edges for SVG.
    if edge.geom_type.name == "LINE":
        pts = [edge.start_point(), edge.end_point()]
    else:
        pts = [edge.position_at(i/n) for i in range(n+1)]
    return [(p.X, p.Y) for p in pts]


class View:
    """One orthographic projection; maps both edges and 3D points to the sheet."""

    def __init__(self, shape: Shape, camera, up, cx, cy, scale=1, look_at=(0, 0, 18)):
        self.camera, self.up, self.look_at = camera, up, look_at
        self.cx, self.cy, self.scale = cx, cy, scale
        self.vis, self.hid = shape.project_to_viewport(camera, up, look_at=look_at)
        pts = [p for e in self.vis for p in polyline(e)]
        self.midx = (min(p[0] for p in pts)+max(p[0] for p in pts))/2
        self.midy = (min(p[1] for p in pts)+max(p[1] for p in pts))/2

    def xy(self, x, y):
        return self.cx+(x-self.midx)*self.scale, self.cy-(y-self.midy)*self.scale

    def point(self, v):
        marker = Pos(v.X, v.Y, v.Z) * Box(.02, .02, .02)
        vis, hid = marker.project_to_viewport(self.camera, self.up, look_at=self.look_at)
        p = (vis + hid)[0].start_point()
        return self.xy(p.X, p.Y)

    def svg(self, hidden=True):
        def path_for(edges, cls):
            out = []
            for e in edges:
                coords = " ".join("%.3f,%.3f" % self.xy(x, y) for x, y in polyline(e))
                out.append(f'<polyline class="{cls}" points="{coords}"/>')
            return "".join(out)
        return (path_for(self.hid, "hidden") if hidden else "") + path_for(self.vis, "object")


def section_svg(sections, cx, cy, d: Dimensions, cls="hatch", scale=1.0):
    """Draw the real planar section faces with hatch fill and their boundary edges."""
    markup=[]
    def xy(point):
        return (cx + point.X*scale, cy + (d.height/2 - point.Z)*scale)
    def close(a,b):
        return abs(a.X-b.X)+abs(a.Z-b.Z)<1e-5
    for sk in sections:
        for face in sk.faces():
            edges=list(face.outer_wire().edges())
            if not edges:
                continue
            chain=[edges.pop(0)]
            while edges:
                tip=chain[-1].end_point()
                match=next(((i,e,False) for i,e in enumerate(edges) if close(e.start_point(),tip)),None)
                if match is None:
                    match=next(((i,e,True) for i,e in enumerate(edges) if close(e.end_point(),tip)),None)
                if match is None:
                    raise ValueError('Section perimeter not closed')
                i,e,reverse=match
                chain.append(e.reversed() if reverse else e)
                edges.pop(i)
            points=[]
            for edge in chain:
                samples=[edge.start_point(),edge.end_point()] if edge.geom_type.name=='LINE' else [edge.position_at(i/24) for i in range(25)]
                points.extend(samples[:-1])
            path=' '.join(f'{x:.3f},{y:.3f}' for x,y in map(xy,points))
            markup.append(f'<polygon points="{path}" style="fill:url(#{cls})" class="object"/>')
    return ''.join(markup)


def ring_positions(points, box, pad):
    """Spread balloons evenly around a rectangle, ordered by angle around its centre."""
    (x0, y0, x1, y1) = box
    cx, cy = (x0+x1)/2, (y0+y1)/2
    order = sorted(points, key=lambda kv: math.atan2(kv[1][1]-cy, kv[1][0]-cx))
    w, h = x1-x0+2*pad, y1-y0+2*pad
    perim = 2*(w+h)
    out = {}
    # Start the walk at the angle of the first item so leaders stay short.
    for i, (key, (px, py)) in enumerate(order):
        ang = math.atan2(py-cy, px-cx)
        t = (i + 0.5) / len(order)
        a = -math.pi + 2*math.pi*t
        a = (a + ang) / 2 if abs(a - ang) < math.pi/2 else a
        dx, dy = math.cos(a), math.sin(a)
        sx = (w/2) / abs(dx) if abs(dx) > 1e-9 else 1e9
        sy = (h/2) / abs(dy) if abs(dy) > 1e-9 else 1e9
        r = min(sx, sy)
        out[key] = (cx + dx*r, cy + dy*r)
    return out




# ------------------------------------------------------------------- sheets

def assembly(parts):
    base, lid, electronics = parts
    return Compound(children=[base, lid] + [p.solid for p in electronics])


def P(x, y, z):
    return Pos(x, y, z).position


def clipped(markup, x, y, w, h, name):
    return (f'<clipPath id="{name}"><rect x="{x}" y="{y}" width="{w}" height="{h}"/></clipPath>'
            f'<g clip-path="url(#{name})">{markup}</g>')


def sheet_one(parts, d: Dimensions):
    base, lid, electronics = parts
    full = assembly(parts)
    top_z = board_top(d)
    s = sheet_start(1, "GENERAL ASSEMBLY", "RL-HW-01", "1.4:1 unless noted", total=SHEETS)
    k = 1.4
    top = View(full, (0, 0, 200), (0, 1, 0), 106, 94, k)
    s.append(top.svg())
    s.append(txt(106, 150, "PLAN VIEW (LID SHOWN TRANSPARENT) / 1.4:1", 3, "label", "middle"))
    x0, x1 = top.point(P(-d.length/2, 0, d.height))[0], top.point(P(d.length/2, 0, d.height))[0]
    y0, y1 = top.point(P(0, d.width/2, d.height))[1], top.point(P(0, -d.width/2, d.height))[1]
    ex0, ex1 = top.point(P(-d.length/2-d.ear_length, 0, 0))[0], top.point(P(d.length/2+d.ear_length, 0, 0))[0]
    s.append(dim_h(x0, x1, y0-8, y0-1, f"{d.length:g}"))
    s.append(dim_h(ex0, ex1, y0-15, y0-1, f"{d.length+2*d.ear_length:g} OVERALL"))
    s.append(dim_v(y0, y1, ex0-6, x0-1, f"{d.width:g}"))
    sy0, sy1 = top.point(P(0, d.screw_y, d.height))[1], top.point(P(0, -d.screw_y, d.height))[1]
    sx1 = top.point(P(d.screw_x, 0, d.height))[0]
    s.append(dim_v(sy0, sy1, ex1+8, sx1, f"{2*d.screw_y:g} C-C"))
    cy = top.point(P(0, d.usb_y, 0))[1]
    s.append(line(ex0-4, cy, ex1+4, cy, "cut"))
    s.append(txt(ex0-6, cy-1.5, "A", 3, "label-bold")); s.append(txt(ex1+4, cy-1.5, "A", 3, "label-bold"))

    front = View(full, (0, -200, 10), (0, 0, 1), 106, 182, k)
    s.append(front.svg())
    s.append(txt(106, 214, "FRONT ELEVATION", 3, "label", "middle"))
    fy0, fy1 = front.point(P(0, 0, d.height))[1], front.point(P(0, 0, 0))[1]
    fx0 = front.point(P(-d.length/2-d.ear_length, 0, 0))[0]
    s.append(dim_v(fy0, fy1, fx0-6, fx0, f"{d.height:g}"))

    side = View(full, (-200, 0, 10), (0, 0, 1), 236, 182, k)
    s.append(side.svg())
    s.append(txt(236, 214, "LEFT SIDE: USB-C, BUTTON, TAMPER PLUNGER", 3, "label", "middle"))
    pu = side.point(P(-d.length/2, d.usb_y, top_z + 1.6))
    pb = side.point(P(-d.length/2, d.button_y, top_z + 1.75))
    s.append(balloon(pu[0], pu[1], pu[0]-14, pu[1]-22, "U"))
    s.append(balloon(pb[0], pb[1], pb[0]+16, pb[1]-22, "B"))
    s.append(txt(190, 226, f"U  USB-C opening {d.usb_width:g} x {d.usb_height:g} (charge only), silicone plug", 2.4, "label"))
    s.append(txt(190, 231, f"B  hole D{d.button_d:g} for SW1, membrane to be added", 2.4, "label"))

    # Exact section through J1 (Y = usb_y): board, connector, lid, base.
    cut = Plane(origin=(0, d.usb_y, 0), x_dir=(1, 0, 0), z_dir=(0, 1, 0))
    shells = [section(base, section_by=cut), section(lid, section_by=cut)]
    inner = [section(solid, section_by=cut) for p in electronics for solid in p.solid.solids()
             if solid.bounding_box().min.Y < d.usb_y < solid.bounding_box().max.Y]
    sc, scx, scy = 1.5, 322, 66
    s.append(section_svg(shells, scx, scy, d, scale=sc))
    s.append(section_svg(inner, scx, scy, d, "hatch2", scale=sc))
    s.append(txt(scx, 98, f"SECTION A-A / Y = +{d.usb_y:g} / 1.5:1", 3, "label", "middle"))
    s.append(txt(scx, 103, "Enclosure white hatch, electronics red hatch (PCB1, U1, U7, J1, BT1)", 2.2, "sub", "middle"))
    top_y, bot_y = scy - d.height/2*sc, scy + d.height/2*sc
    left = scx - (d.length/2 + d.ear_length)*sc
    s.append(dim_v(top_y, bot_y, left-5, left, f"{d.height:g}"))
    pcb_y = scy + (d.height/2 - top_z)*sc
    right = scx + (d.length/2 + d.ear_length)*sc
    s.append(dim_v(pcb_y, bot_y, right+6, scx + d.length/2*sc, f"Z {top_z:g}"))

    iso = View(full, (125, -140, 120), (0, 0, 1), 330, 176, 1.0, look_at=(0, 0, 10))
    s.append(iso.svg(hidden=False))
    s.append(txt(330, 224, "ISOMETRIC, ASSEMBLED / 1:1", 3, "label", "middle"))
    px, py = iso.point(P(*FLOORPLAN["D1"], d.height))
    s.append(line(px, py, px-26, py-12, "leader") + f'<circle cx="{px:.2f}" cy="{py:.2f}" r=".6" class="dot"/>')
    s.append(txt(px-27, py-11, "LP1 status light", 2.4, "label", "end"))
    s.append('</svg>')
    return ''.join(s)


def sheet_two(parts, d: Dimensions):
    base, lid, electronics = parts
    s = sheet_start(2, "BOARD RL-MB-01 AND TAMPER MECHANISM", "RL-HW-02", "2:1 board, 3:1 detail", total=SHEETS)
    top_z = board_top(d)
    on_board = [p for p in electronics if p.on_board]
    pcb = next(p for p in electronics if p.ref == "PCB1")
    k = 2.0
    v = View(Compound(children=[pcb.solid] + [p.solid for p in on_board]), (0, 0, 200), (0, 1, 0), 112, 104, k)
    kx0, kx1, ky0, ky1 = ANT1_KEEPOUT
    (ax, ay), (bx, by) = v.point(P(kx0, ky1, top_z)), v.point(P(kx1, ky0, top_z))
    s.append(f'<rect x="{ax:.2f}" y="{ay:.2f}" width="{bx-ax:.2f}" height="{by-ay:.2f}" style="fill:url(#hatch2)" class="frame"/>')
    s.append(v.svg(hidden=False))
    s.append(txt((ax+bx)/2, ay-1.5, "ANTENNA KEEP-OUT (NO PARTS, NO COPPER)", 2.1, "accent", "middle"))
    px0, py0 = v.point(P(-d.pcb_length/2, d.pcb_width/2, top_z))
    px1, py1 = v.point(P(d.pcb_length/2, -d.pcb_width/2, top_z))
    pts = {p.ref: v.point(P(p.ports["C"].X, p.ports["C"].Y, top_z)) for p in on_board}
    keys = [(p.find, pts[p.ref]) for p in on_board]
    spots = ring_positions(keys, (px0, py0, px1, py1), 13)
    for p in on_board:
        (x, y), (tx, ty) = pts[p.ref], spots[p.find]
        s.append(balloon(x, y, tx, ty, p.find))
        s.append(txt(tx + (5 if tx > (px0+px1)/2 else -5), ty + 1, p.ref, 2.0, "sub", "start" if tx > (px0+px1)/2 else "end"))
    s.append(dim_h(px0, px1, py0-27, py0-16, f"{d.pcb_length:g}"))
    s.append(dim_v(py0, py1, px1+30, px1+17, f"{d.pcb_width:g}"))
    s.append(txt(112, py1+32, "01 BOARD RL-MB-01, COMPONENT SIDE / 2:1", 3, "label", "middle"))
    s.append(txt(112, py1+37, f"Thickness {d.pcb_thickness:g} - notches R{d.boss_radius+d.pcb_notch_gap:g} at the four screws - top face at Z = {top_z:g}",
                 2.3, "sub", "middle"))

    # Tamper mechanism: exact section through the plunger (Y = plunger_y), clipped around it.
    pxm, pym = PLUNGER_XY
    cut = Plane(origin=(0, pym, 0), x_dir=(1, 0, 0), z_dir=(0, 1, 0))
    sc = 3.0
    ox, oy = 322, 68
    cx = ox - pxm * sc
    secs = [section(base, section_by=cut)]
    inner = []
    for p in electronics:
        if p.ref in ("PCB1", "TS1", "PL1", "ANT2", "BT1"):
            for solid in p.solid.solids():
                bb = solid.bounding_box()
                if bb.min.Y < pym < bb.max.Y:
                    inner.append(section(solid, section_by=cut))
    markup = section_svg(secs, cx, oy, d, scale=sc) + section_svg(inner, cx, oy, d, "hatch2", scale=sc)
    s.append(clipped(markup, ox - 42, oy - d.height/2*sc - 4, 84, d.height*sc + 8, "clipDetail"))
    s.append(rect(ox - 42, oy - d.height/2*sc - 4, 84, d.height*sc + 8, "frame"))
    s.append(txt(ox, oy + d.height/2*sc + 12, f"DETAIL B: TAMPER PLUNGER, SECTION Y = +{pym:g} / 3:1", 3, "label", "middle"))
    s.append(txt(ox, oy + d.height/2*sc + 17.5, "Mounting surface pushes PL1 up: TS1 stays open. Remove the device: spring drops PL1, TS1 closes.", 2.1, "sub", "middle"))
    pl = next(p for p in electronics if p.ref == "PL1")
    zc = (pl.solid.bounding_box().min.Z + pl.solid.bounding_box().max.Z) / 2
    qx, qy = ox, oy + (d.height/2 - zc) * sc
    s.append(balloon(qx, qy, ox + 30, qy + 6, pl.find))
    ts = next(p for p in electronics if p.ref == "TS1")
    s.append(balloon(ox, oy + (d.height/2 - (top_z + 2)) * sc, ox + 30, oy + (d.height/2 - (top_z + 2)) * sc - 10, ts.find))

    under = View(lid, (0, 0, -200), (0, 1, 0), 318, 148, 0.75)
    s.append(under.svg(hidden=False))
    s.append(txt(318, 178, f"LID, INSIDE FACE / 0.75:1: D{d.light_hole_d:g} hole for the light pipe, no metal over ANT2", 2.4, "label", "middle"))

    bt = next(p for p in electronics if p.ref == "BT1")
    lower = View(Compound(children=[base, bt.solid, pl.solid]), (0, 0, 200), (0, 1, 0), 318, 208, 0.75)
    s.append(lower.svg(hidden=False))
    c = lower.point(P(d.battery_x, 0, 10.5))
    s.append(balloon(c[0], c[1], c[0]+20, c[1]-22, bt.find))
    c2 = lower.point(P(PLUNGER_XY[0], PLUNGER_XY[1], 6))
    s.append(balloon(c2[0], c2[1], c2[0]+16, c2[1]-10, pl.find))
    s.append(txt(318, 242, "BASE WITH BT1 ON FOAM AND PL1 (BOARD REMOVED) / 0.75:1", 2.6, "label", "middle"))

    rules = ["LAYOUT RULES",
             "- ANT1 at the board edge, keep-out clear of copper and parts (checked).",
             "- ANT2 faces the polymer lid; nothing metallic above it.",
             "- U2 near the centre of the board, held by four rigid points.",
             "- BT1 under the board: check the antenna tuning with it in place.",
             "- J1 and SW1 line up with the openings in the -X wall (checked)."]
    for i, r in enumerate(rules):
        s.append(txt(14, 214 + i*5.4, r, 2.7 if i == 0 else 2.3, "label-bold" if i == 0 else "label"))
    s.append(line(222, 24, 222, 168, "thin"))
    s.append('</svg>')
    return ''.join(s)


EXPLODE = {"PL1": (0, 0, -16), "BT1": (0, 0, 16), "pcb": (0, 0, 36), "LP1": (0, 0, 58), "LID": (0, 0, 70)}


def exploded(parts, d: Dimensions):
    """Each group lifted along Z so no part hides another."""
    base, lid, electronics = parts
    solids, moved = [base, Pos(*EXPLODE["LID"]) * lid], {}
    for p in electronics:
        off = EXPLODE.get(p.ref, EXPLODE.get(p.mount, (0, 0, 0)))
        solids.append(Pos(*off) * p.solid)
        moved[p.ref] = off
    return Compound(children=solids), moved


def view_bbox(view):
    xs, ys = [], []
    for e in view.vis:
        for x, y in polyline(e):
            sx, sy = view.xy(x, y)
            xs.append(sx); ys.append(sy)
    return min(xs), min(ys), max(xs), max(ys)


def sheet_three(parts, d: Dimensions):
    base, lid, electronics = parts
    data = load_netlist()
    s = sheet_start(3, "EXPLODED VIEW: EVERY COMPONENT", "RL-HW-03", "1.15:1 (exploded)", total=SHEETS)
    shape, moved = exploded(parts, d)
    iso = View(shape, (125, -140, 120), (0, 0, 1), 118, 138, 1.15, look_at=(0, 0, 40))
    for x, y in screw_centers(d):
        (ax, ay), (bx, by) = iso.point(P(x, y, -4)), iso.point(P(x, y, d.height + EXPLODE["LID"][2] + 6))
        s.append(line(ax, ay, bx, by, "center"))
    s.append(iso.svg(hidden=False))
    for wid, (a, b) in wire_routes(electronics).items():
        pa = (Pos(*moved["BT1"]) * Pos(a.X, a.Y, a.Z)).position
        pb = (Pos(*moved["J3"]) * Pos(b.X, b.Y, b.Z)).position
        (x1, y1), (x2, y2) = iso.point(pa), iso.point(pb)
        s.append(f'<path class="wire" d="M{x1:.2f},{y1:.2f} C{x1-12:.2f},{y1:.2f} {x2-12:.2f},{y2:.2f} {x2:.2f},{y2:.2f}"/>')
    anchors = {}
    for p in electronics:
        bb = p.solid.bounding_box()
        cx, cy, z = bb.center().X, bb.center().Y, bb.max.Z
        if p.ref == "PCB1":
            cx, cy = 0, -d.pcb_width/2 + 1.5
        anchors[p.find] = iso.point((Pos(*moved[p.ref]) * Pos(cx, cy, z)).position)
    bb = base.bounding_box()
    anchors[24] = iso.point(P(bb.max.X - 6, bb.min.Y, 3))
    anchors[25] = iso.point(P(-d.length/2 + 8, -d.width/2, d.height + EXPLODE["LID"][2] - 2))
    spots = ring_positions(list(anchors.items()), view_bbox(iso), 12)
    for n, (x, y) in anchors.items():
        tx, ty = spots[n]
        s.append(balloon(x, y, tx, ty, n))
    s.append(txt(118, 247, "EXPLODED ISOMETRIC / 25 CALLOUTS / SCREW AXES IN CHAIN LINE / W1 BATTERY CABLE IN RED", 2.5, "label", "middle"))

    rows = [["NO", "QTY", "DESIGNATION", "PART", "SIZE mm", "DATA"]]
    for c in sorted(data["components"], key=lambda c: c["find"]):
        size = " x ".join(f"{v:g}" for v in c["size_mm"][:2])
        rows.append([str(c["find"]), "1", f'{c["ref"]} {c["name"]}', c["part"], size, c["size_status"]])
    rows += [["24", "1", "Base with strap ears", "RL-HW-01", f"{d.length+2*d.ear_length:g} x {d.width:g}", "CAD model"],
             ["25", "1", "Lid (non-metallic polymer)", "RL-HW-02", f"{d.length:g} x {d.width:g}", "CAD model"],
             ["26", "4", "Plastic self-tapping screw", "to choose", f"D{d.screw_diameter:g}", "to define"],
             ["27", "1", "Adhesive foam under the battery", "to choose", "60 x 36 x 0.5", "to define"],
             ["28", "1", "Strap or mounting plate", "to choose", "25 wide", "to define"]]
    tx0 = 250
    s.append(txt(tx0, 30, "PARTS LIST", 3.2, "label-bold"))
    s.append(table(tx0, 33, [7, 6, 53, 31, 18, 45], rows, 4.45, 1.85, 1.62))
    ty = 33 + 4.45 * len(rows) + 4
    s.append(txt(tx0, ty, "Sources: hardware/netlist.json. 'indicative': size to be taken from the part chosen.", 1.8, "sub"))
    facts = ["92 x 62 x 22 mm (112 mm with the strap ears)", "23 electronic items, one cable inside",
             "Cellular, satellite and DECT NR+ mesh from one SiP", "Shock +-200 g, motion, tamper plunger, black box flash",
             "Hold-up capacitor for the last message"]
    for i, f in enumerate(facts):
        s.append(txt(tx0, ty + 9 + i*5.6, "- " + f, 2.2, "label"))
    s.append('</svg>')
    return ''.join(s)


def block(x, y, w, h, title, subtitle=""):
    out = rect(x, y, w, h, "frame") + rect(x, y, w, 5, "head") + txt(x + w/2, y + 3.7, title, 2.4, "label-bold", "middle")
    if subtitle:
        out += txt(x + w/2, y + 9, subtitle, 2.0, "sub", "middle")
    return out


def link(points, label=None, at=0, cls="wire", dx=1, dy=-1):
    d = "M" + " L".join(f"{x:.2f},{y:.2f}" for x, y in points)
    out = f'<path class="{cls}" d="{d}"/>'
    if label:
        x, y = points[at]
        out += txt(x + dx, y + dy, label, 2.0, "accent")
    return out


def sheet_four(parts, d: Dimensions):
    data = load_netlist()
    s = sheet_start(4, "ELECTRICAL ARCHITECTURE", "RL-EL-04", "diagram, not to scale", total=SHEETS)
    s.append(txt(16, 32, "BLOCK DIAGRAM FROM hardware/netlist.json", 3, "label-bold"))

    def dot(x, y):
        return f'<circle cx="{x:.2f}" cy="{y:.2f}" r=".7" class="pin"/>'

    s.append(block(16, 44, 36, 16, "J1 USB-C", "VBUS 5 V, charge only"))
    s.append(block(16, 76, 36, 18, "BT1 Li-Po 1S", "2000 mAh, W1 to J3"))
    s.append(block(16, 108, 36, 24, "U7 + C1", "hold-up and ideal diode"))
    s.append(block(70, 44, 40, 58, "U4 nPM1300", "PMIC"))
    for i, t in enumerate(["charger 32-800 mA", "fuel gauge", "BUCK1 to 1.8 V", "VSYS to nRF9151 and U7", "LED0 sink", "I2C and GPIO0 IRQ"]):
        s.append(txt(72, 58 + i*6.6, t, 2.1, "label"))
    s.append(block(144, 44, 54, 100, "U1 nRF9151", "cellular + NTN + DECT NR+ + GNSS"))
    for i, t in enumerate(["VDD from VSYS", "VDD_GPIO from 1.8 V", "SPI: SCK MOSI MISO", "CS0 to U2   CS1 to U5", "TWI to U3, U4",
                           "INT1 from U2, INT2 from U3", "INT3 from U4", "PWR_FAIL from U7", "BTN from SW1, TAMPER from TS1",
                           "ANT to ANT1 (RF)", "GPS from U6", "SIM to J2", "SWD to J4"]):
        s.append(txt(146, 58 + i*6.0, t, 2.05, "label"))
    s.append(block(224, 44, 40, 14, "ANT1", "cell + DECT chip antenna"))
    s.append(block(224, 66, 18, 14, "U6", "filter + LNA"))
    s.append(block(246, 66, 24, 14, "ANT2", "GNSS patch"))
    s.append(block(224, 88, 40, 14, "J2 eSIM MFF2", "soldered"))
    s.append(block(224, 110, 40, 14, "J4 SWD pads", "programming + readout"))
    s.append(block(70, 118, 40, 16, "U3 ADXL367", "motion, always on, I2C"))
    s.append(block(70, 144, 40, 16, "U2 ADXL372", "shock +-200 g, SPI"))
    s.append(block(70, 170, 40, 16, "U5 MX25R6435F", "black box, SPI"))
    s.append(block(144, 156, 24, 14, "SW1", "button"))
    s.append(block(174, 156, 24, 14, "TS1 + PL1", "tamper"))
    s.append(block(16, 150, 36, 14, "D1 LED + LP1", "sunk by U4 LED0"))

    # Power.
    s += [link([(52, 52), (70, 52)], "VBUS", 0, dy=-1.2), link([(52, 85), (70, 85)], "VBAT", 0, dy=-1.2),
          link([(110, 50), (144, 50)], "VSYS", 0, dy=-1.2),
          link([(122, 50), (122, 40), (60, 40), (60, 120), (52, 120)], "VSYS to U7 and back (hold-up)", 1, dx=2, dy=-1.2), dot(122, 50)]
    channels = {
        "V1V8": (116, [(58, 144), (126, 110), (152, 110), (178, 110)]),
        "I2C": (122, [(82, 144), (82, 110), (130, 110)]),
        "SPI": (128, [(70, 144), (152, 110), (180, 110)]),
        "INT": (134, [(94, 144), (88, 110), (136, 110), (162, 110)]),
    }
    for name, (cx, taps) in channels.items():
        ys = [y for y, _ in taps]
        s.append(link([(cx, min(ys)), (cx, max(ys))]))
        s.append(txt(cx, min(ys) - 1.5 - (2.8 if name in ("I2C", "INT") else 0), name, 2.0, "accent", "middle"))
        for y, x in taps:
            s.append(link([(x, y), (cx, y)]) + dot(cx, y))
    s += [link([(151, 156), (151, 144)], "BTN", 0, dx=1.2, dy=-3), link([(186, 156), (186, 144)], "TAMPER", 0, dx=1.2, dy=-3)]
    s += [link([(198, 51), (224, 51)], "RF_CELL", 0, "wire-rf", dy=-1.2), link([(198, 73), (224, 73)], "GNSS", 0, "wire-rf", dy=-1.2),
          link([(242, 73), (246, 73)], None, 0, "wire-rf"), link([(198, 95), (224, 95)], "SIM x4", 0, dy=-1.2),
          link([(198, 117), (224, 117)], "SWD", 0, dy=-1.2)]
    s.append(txt(16, 200, "Red solid: signals and supplies. Dashed: 50 ohm RF. One cable inside the device: W1 (BT1 to J3).", 2.2, "sub"))
    h = data["holdup"]
    energy = 0.5 * h["capacitance_F"] * (h["v_full"] ** 2 - h["v_min"] ** 2)
    need = h["budget_units"] * h["unit_J"]
    s.append(txt(16, 206, f"Hold-up: C1 {h['capacitance_F']:g} F from {h['v_full']:g} V to {h['v_min']:g} V stores {energy:.2f} J; the last-gasp budget needs {need:.2f} J ({energy/need:.1f}x margin, assumptions in the netlist).", 2.2, "sub"))

    rails = [["RAIL", "SOURCE", "VOLTAGE", "LOADS"]]
    loads = {"VBUS": "U4", "VBAT": "U4", "VSYS": "U1 VDD, U7, D1", "V1V8": "U1 GPIO, U2, U3, U5, U6, J4", "VCAP": "C1 via U7"}
    for name, r in data["rails"].items():
        volt = f'{r["min_v"]:g} V' if r["min_v"] == r["max_v"] else f'{r["min_v"]:g}-{r["max_v"]:g} V'
        rails.append([name, r["source"], volt, loads[name]])
    s.append(txt(278, 34, "RAILS (RANGES CHECKED)", 3, "label-bold"))
    s.append(table(278, 37, [13, 36, 18, 55], rails, 5, 1.9, 1.8))
    buses = [["BUS", "MEMBERS", "SELECT / ADDRESS"], ["SPI", "U2 ADXL372, U5 flash", "CS_IMPACT, CS_BLACKBOX"],
             ["I2C", "U3 ADXL367, U4 nPM1300", "0x1D, 0x6B (to confirm)"], ["RF", "U1 to ANT1 ; ANT2 to U6 to U1", "50 ohm, tuning to do"]]
    s.append(txt(278, 76, "BUSES", 3, "label-bold"))
    s.append(table(278, 79, [13, 58, 51], buses, 5, 1.9, 1.8))
    s.append(txt(278, 106, "FIRMWARE POINTS TO FIX", 3, "label-bold"))
    for i, n in enumerate(data["firmware_notes"]):
        words, lines_, cur = n.split(), [], ""
        for w in words:
            if len(cur) + len(w) > 70:
                lines_.append(cur); cur = w
            else:
                cur = (cur + " " + w).strip()
        lines_.append(cur)
        for j, l in enumerate(lines_):
            s.append(txt(278, 112 + (sum(len(x) for x in [] ) ) + i*13.5 + j*4.2, ("- " if j == 0 else "  ") + l, 1.9, "label"))
    s.append(txt(278, 172, "COMMUNICATION LAYERS", 3, "label-bold"))
    for i, n in enumerate(["1. Cellular LTE-M / NB-IoT: normal reporting.",
                           "2. Fleet relay over DECT NR+: the message hops through any passing fleet vehicle.",
                           "3. Satellite NB-NTN: optional, off by default. Needs its own L-band antenna.",
                           "Priority 3 (theft, tamper, power loss) leaves first on whichever layer is up."]):
        s.append(txt(278, 178 + i*5.2, n, 2.0, "label"))
    s.append('</svg>')
    return ''.join(s)


def sheet_five(parts, d: Dimensions):
    data = load_netlist()
    s = sheet_start(5, "WIRING AND NET LIST", "RL-EL-05", "tables", total=SHEETS)
    classes = {"VBUS": "power", "VBAT": "power", "VSYS": "power", "VCAP": "power", "V1V8": "power", "GND": "ground"}
    for n in data["nets"]:
        if n["name"] not in classes:
            classes[n["name"]] = ("RF" if n["name"].startswith(("RF_", "GNSS")) else "bus" if n["name"].startswith(("SPI", "I2C", "CS_", "SIM", "SWD")) else "signal")
    rows = [["NET", "CLASS", "TERMINALS"]]
    for n in data["nets"]:
        terms = " ".join(n["terminals"])
        if len(terms) > 62:
            terms = terms[:60].rsplit(" ", 1)[0] + " +" + str(len(n["terminals"]) - len(terms[:60].rsplit(" ", 1)[0].split()))
        rows.append([n["name"], classes[n["name"]], terms])
    s.append(txt(14, 28, f"NET LIST: {len(data['nets'])} NETS, ALL TERMINALS UNIQUE (CHECKED)", 3, "label-bold"))
    s.append(table(14, 31, [24, 14, 100], rows, 5.3, 1.9, 1.75))

    conns = {"J1": "USB-C", "J2": "eSIM MFF2", "J3": "Battery JST-PH 2", "J4": "SWD pads", "SW1": "Button", "TS1": "Tamper switch"}
    x0, y = 168, 28
    s.append(txt(x0, y, "CONNECTOR PIN-OUTS", 3, "label-bold"))
    y += 3
    for ref, title in conns.items():
        pins = []
        for n in data["nets"]:
            for t in n["terminals"]:
                if t.startswith(ref + "."):
                    pins.append((t.split(".")[1], n["name"]))
        pins.sort(key=lambda p: p[0])
        rows2 = [[f"{ref} {title}", "PIN", "NET"]] + [["", p, n] for p, n in pins]
        s.append(table(x0, y, [34, 14, 36], [[a, b, c] for a, b, c in rows2], 4.3, 1.9, 1.8))
        y += 4.3 * len(rows2) + 3.5
    # Cable W1 sketch.
    cx0, cy0 = 258, 28
    s.append(txt(cx0, cy0, "CABLE W1 (ONLY CABLE INSIDE)", 3, "label-bold"))
    s.append(rect(cx0, cy0 + 6, 30, 16, "frame") + txt(cx0 + 15, cy0 + 15.2, "BT1 Li-Po", 2.4, "label-bold", "middle")
             + txt(cx0 + 15, cy0 + 19.4, "2000 mAh", 2.0, "sub", "middle"))
    s.append(line(cx0 + 30, cy0 + 11, cx0 + 78, cy0 + 11, "wire") + line(cx0 + 30, cy0 + 17, cx0 + 78, cy0 + 17, "dimension"))
    s.append(rect(cx0 + 78, cy0 + 7, 16, 14, "frame") + txt(cx0 + 86, cy0 + 15.2, "J3", 2.6, "label-bold", "middle"))
    s.append(txt(cx0 + 54, cy0 + 9, "red: VBAT", 2, "accent", "middle") + txt(cx0 + 54, cy0 + 22, "black: GND", 2, "label", "middle"))
    s.append(txt(cx0, cy0 + 29, "JST-PH 2 pins, 50 mm. Check polarity before plugging.", 2.1, "sub"))
    s.append(txt(cx0, cy0 + 36, "POWER-UP SEQUENCE", 3, "label-bold"))
    for i, n in enumerate(["1. VSYS from U4 (battery or USB-C).", "2. VDD of U1 and ENABLE high.", "3. BUCK1 starts 1.8 V more than 6 ms later.",
                           "4. VDD_GPIO then follows, sensors wake.", "5. C1 charges through U7; PWR_FAIL goes high when full.",
                           "6. On a supply drop U7 keeps VSYS up and raises PWR_FAIL: last gasp."]):
        s.append(txt(cx0, cy0 + 42 + i * 5.2, n, 2.05, "label"))
    s.append(txt(cx0, cy0 + 80, "PASSIVE PARTS", 3, "label-bold"))
    for i, n in enumerate(["Decoupling, RF matching, pull-ups and level parts are", "added at routing; only R1 and R2 (USB-C CC pull-downs)", "are modelled here because they define the connector."]):
        s.append(txt(cx0, cy0 + 86 + i * 4.6, n, 2.05, "sub"))
    s.append('</svg>')
    return ''.join(s)


def publish(svgs):
    """Merge the sheets into one PDF and copy the sheet people open first."""
    docs = REPO / "docs" / "blueprints"
    docs.mkdir(parents=True, exist_ok=True)
    pdf = docs / "redline-plans-A3.pdf"
    subprocess.run(['rsvg-convert', '-f', 'pdf', '-o', str(pdf)] + [str(p) for p in svgs], check=True)
    shutil.copy(svgs[2], docs / "redline-exploded-view.svg")
    shutil.copy(OUT / "redline-sheet-3.png", docs / "redline-exploded-view.png")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true', help='validate geometry and netlist only')
    args = parser.parse_args()
    parts = make_parts()
    check(parts)
    if args.check:
        print('Geometry and netlist checks passed')
        return
    OUT.mkdir(exist_ok=True)
    base, lid, _ = parts
    for name, part in [('base', base), ('lid', lid)]:
        export_step(part, OUT/f'redline-{name}.step')
        export_stl(part, OUT/f'redline-{name}.stl')
    export_step(assembly(parts), OUT/'redline-assembly.step')
    svgs = []
    for number, fn in [(1, sheet_one), (2, sheet_two), (3, sheet_three), (4, sheet_four), (5, sheet_five)]:
        svg = OUT/f'redline-sheet-{number}.svg'
        svg.write_text(fn(parts, D), encoding='utf-8')
        subprocess.run(['rsvg-convert', '-f', 'pdf', '-o', str(svg.with_suffix('.pdf')), str(svg)], check=True)
        subprocess.run(['rsvg-convert', '-f', 'png', '-w', '2200', '-o', str(svg.with_suffix('.png')), str(svg)], check=True)
        svgs.append(svg)
    publish(svgs)
    print(f'Generated CAD and drawing exports in {OUT}')


if __name__ == '__main__':
    main()
