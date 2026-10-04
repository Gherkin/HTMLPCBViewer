#!/usr/bin/env python3
"""Cut a board JSON down to a size worth committing.

    python tools/trim_fixture.py in.json out.json [--footprints N]

Keeps the first N footprints, every net they touch, and only the tracks and
zones on those nets. Metadata, board edges and font data are kept whole.

The point is a fixture small enough to live in git but still structurally
real — an empty board passes every test vacuously and tells you nothing.
"""
import argparse
import json
import os
import sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--footprints", type=int, default=60,
                    help="how many footprints to keep (default 60)")
    # Board-wide sections are not tied to footprints, so they need their own
    # caps or they dominate the file. Zone and fabrication polygons carry a lot
    # of points each.
    ap.add_argument("--zones", type=int, default=4,
                    help="max zones per layer (default 4)")
    # A filled ground plane on an inner layer can be close to 1 MB on its own.
    ap.add_argument("--zone-kb", type=int, default=100,
                    help="drop any single zone larger than this (default 100)")
    ap.add_argument("--drawings", type=int, default=80,
                    help="max drawings per section (default 80)")
    args = ap.parse_args()

    with open(args.src, "r", encoding="utf-8") as f:
        data = json.load(f)

    pcb = data["pcbdata"]
    kept_fps = pcb["footprints"][:args.footprints]

    # Every net those footprints actually touch.
    kept_nets = set()
    for fp in kept_fps:
        for pad in fp.get("pads", []):
            if pad.get("net"):
                kept_nets.add(pad["net"])

    def filter_layers(section):
        out = {}
        for layer, items in (section or {}).items():
            out[layer] = [it for it in items if it.get("net") in kept_nets]
        return out

    pcb["footprints"] = kept_fps
    pcb["tracks"] = filter_layers(pcb.get("tracks"))
    def zone_fits(layer, zone):
        kb = len(json.dumps(zone, separators=(",", ":"))) // 1024
        if kb <= args.zone_kb:
            return True
        print(f"  dropped {kb} KB zone on {layer} ({zone.get('net')})")
        return False

    pcb["zones"] = {k: [z for z in v if zone_fits(k, z)][:args.zones]
                    for k, v in filter_layers(pcb.get("zones")).items()}
    pcb["nets"] = [n for n in pcb.get("nets", []) if n in kept_nets]

    # Silkscreen and fabrication are board-wide and nested section → layer →
    # items. Cap them so a handful of polygons survive for rendering coverage
    # without the bulk.
    trimmed_drawings = {}
    for section, layers in (pcb.get("drawings") or {}).items():
        if isinstance(layers, dict):
            trimmed_drawings[section] = {
                layer: items[:args.drawings] for layer, items in layers.items()
            }
        else:
            trimmed_drawings[section] = layers[:args.drawings]
    pcb["drawings"] = trimmed_drawings

    if "components" in data:
        data["components"] = data["components"][:args.footprints]

    os.makedirs(os.path.dirname(os.path.abspath(args.dst)), exist_ok=True)
    with open(args.dst, "w", encoding="utf-8") as f:
        json.dump(data, f, separators=(",", ":"))

    size_kb = os.path.getsize(args.dst) // 1024
    print(f"wrote {args.dst}  ({size_kb} KB)")
    print(f"  footprints {len(kept_fps)}")
    print(f"  nets       {len(kept_nets)}")
    for name in ("tracks", "zones"):
        counts = {k: len(v) for k, v in pcb.get(name, {}).items()}
        print(f"  {name:10} {counts}")

    if not kept_nets:
        print("WARNING: no nets kept — was the source built with include_nets?",
              file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
