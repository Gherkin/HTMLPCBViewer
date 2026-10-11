#!/usr/bin/env python3
"""Generate an ibom-format board JSON from a KiCad .kicad_pcb.

Calls InteractiveHtmlBom's parser directly, so no X display is needed — the
normal ibom entry point opens a wx dialog and fails headless.

Usage:
    python tools/make_fixture.py board.kicad_pcb out.json
    IBOM_PATH=/path/to/InteractiveHtmlBom python tools/make_fixture.py ...

Needs KiCad's python bindings (pcbnew) on the path, and a checkout of
InteractiveHtmlBom.

Stock ibom only emits F.Cu and B.Cu tracks and zones (ecad/kicad.py,
parse_tracks hardcodes {F_Cu: [], B_Cu: []}). add_inner_copper() walks the
inner copper layers itself and adds them under their KiCad names (In1.Cu,
In2.Cu, ...). Allegro exports name them LAY1, LAY2, ... instead, so this
covers the viewer's In(\\d+) paths but not its LAY(\\d+) ones.

Stock ibom also drops pad names. tag_pad_names() puts each pad's KiCad name
back on the pad as "name", so a pad can be matched to a netlist pin.
"""
import json
import logging
import os
import sys

IBOM = os.environ.get("IBOM_PATH", os.path.expanduser("~/git/InteractiveHtmlBom"))

if not os.path.isdir(IBOM):
    sys.exit(f"InteractiveHtmlBom not found at {IBOM}; set IBOM_PATH")

sys.path.insert(0, IBOM)

import pcbnew
from InteractiveHtmlBom.core.config import Config
from InteractiveHtmlBom.ecad import get_parser_by_extension


def to_plain(obj):
    """ibom returns Component objects; make the tree JSON-safe."""
    if hasattr(obj, "_asdict"):
        return to_plain(obj._asdict())
    if hasattr(obj, "__dict__"):
        return to_plain(vars(obj))
    if isinstance(obj, dict):
        return {k: to_plain(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [to_plain(v) for v in obj]
    return obj


def tag_pad_names(parser):
    """Make each pad dict carry its KiCad pad name as "name" (e.g. "5",
    "A1", "EP"). ibom reads the name to guess pin 1, then drops it.
    parse_pad can return more than one dict per pad (one per side for a
    custom padstack), so the name is set on each dict as parse_pad makes it,
    not matched back by index afterwards. Pads with an empty name (often
    mechanical pads) get no "name"."""
    parse_pad = parser.parse_pad

    def parse_pad_named(pad):
        dicts = parse_pad(pad)
        name = pad.GetPadName()  # the same call ibom uses for pin 1
        for d in dicts:
            if d is not None and name:
                d["name"] = str(name)
        return dicts

    parser.parse_pad = parse_pad_named


def add_inner_copper(parser, pcbdata):
    """Add inner-layer tracks, vias and zones in the same shape ibom uses
    for F and B. Mirrors parse_tracks and parse_zones in ibom's kicad.py."""
    board = parser.board
    inner = [l for l in board.GetEnabledLayers().CuStack()
             if pcbnew.IsInnerCopperLayer(l)]
    names = {l: pcbnew.BOARD.GetStandardLayerName(l) for l in inner}

    tracks = {l: [] for l in inner}
    tent_vias = board.GetTentVias() if hasattr(board, "GetTentVias") else True
    for track in board.GetTracks():
        if track.GetClass() in ["VIA", "PCB_VIA"]:
            for l in inner:
                if not track.IsOnLayer(l):
                    continue
                # KiCad 10 vias are padstacks and warn if GetWidth has no
                # layer. Older bindings take no argument.
                try:
                    width = track.GetWidth(l)
                except TypeError:
                    width = track.GetWidth()
                via = {
                    "start": parser.normalize(track.GetStart()),
                    "end": parser.normalize(track.GetEnd()),
                    "width": width * 1e-6,
                    "net": track.GetNetname(),
                }
                if not tent_vias:
                    via["drillsize"] = track.GetDrillValue() * 1e-6
                tracks[l].append(via)
        elif track.GetLayer() in tracks:
            if track.GetClass() in ["ARC", "PCB_ARC"]:
                a1, a2 = parser.get_arc_angles(track)
                item = {
                    "center": parser.normalize(track.GetCenter()),
                    "startangle": a1,
                    "endangle": a2,
                    "radius": track.GetRadius() * 1e-6,
                    "width": track.GetWidth() * 1e-6,
                }
            else:
                item = {
                    "start": parser.normalize(track.GetStart()),
                    "end": parser.normalize(track.GetEnd()),
                    "width": track.GetWidth() * 1e-6,
                }
            item["net"] = track.GetNetname()
            tracks[track.GetLayer()].append(item)

    zones = {l: [] for l in inner}
    for zone in board.Zones():
        if not zone.IsFilled() or zone.GetIsRuleArea():
            continue
        for l in zone.GetLayerSet().Seq():
            if l in zones:
                zones[l].append({
                    "polygons": parser.parse_poly_set(zone.GetFilledPolysList(l)),
                    # ibom uses 0 for KiCad 7+, where fills carry no outline.
                    # Older KiCad gets the min thickness there; not handled.
                    "width": 0,
                    "net": zone.GetNetname(),
                })

    for l in inner:
        pcbdata["tracks"][names[l]] = tracks[l]
        pcbdata["zones"][names[l]] = zones[l]


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    board, out = sys.argv[1], sys.argv[2]

    logging.basicConfig(level=logging.WARNING)
    logger = logging.getLogger("make_fixture")

    cfg = Config("0.0.0", os.path.dirname(os.path.abspath(board)))
    # Both off by default in ibom. This viewer is built around net tracing,
    # so without them the output is useless here.
    cfg.include_tracks = True
    cfg.include_nets = True

    parser = get_parser_by_extension(os.path.abspath(board), cfg, logger)
    tag_pad_names(parser)
    pcbdata, components = parser.parse()
    if not pcbdata:
        sys.exit("parser returned no pcbdata")
    add_inner_copper(parser, pcbdata)

    envelope = {"pcbdata": to_plain(pcbdata), "components": to_plain(components)}
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(envelope, f, separators=(",", ":"))

    print(f"wrote {out}  ({os.path.getsize(out) // 1024} KB)")
    print(f"  footprints   {len(pcbdata.get('footprints', []))}")
    print(f"  components   {len(components)}")
    print(f"  track layers {sorted(pcbdata.get('tracks', {}).keys())}")
    print(f"  zone layers  {sorted(pcbdata.get('zones', {}).keys())}")


if __name__ == "__main__":
    main()
