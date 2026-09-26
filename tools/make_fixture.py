#!/usr/bin/env python3
"""Generate an ibom-format board JSON from a KiCad .kicad_pcb.

Calls InteractiveHtmlBom's parser directly, so no X display is needed — the
normal ibom entry point opens a wx dialog and fails headless.

Usage:
    python tools/make_fixture.py board.kicad_pcb out.json
    IBOM_PATH=/path/to/InteractiveHtmlBom python tools/make_fixture.py ...

Needs KiCad's python bindings (pcbnew) on the path, and a checkout of
InteractiveHtmlBom.

Known gap: stock ibom only emits F.Cu and B.Cu tracks and zones
(ecad/kicad.py, parse_tracks hardcodes {F_Cu: [], B_Cu: []}), so boards
generated here have no inner copper layers. Allegro exports do have them.
See the fixture issue before relying on this for inner-layer coverage.
"""
import json
import logging
import os
import sys

IBOM = os.environ.get("IBOM_PATH", os.path.expanduser("~/git/InteractiveHtmlBom"))

if not os.path.isdir(IBOM):
    sys.exit(f"InteractiveHtmlBom not found at {IBOM}; set IBOM_PATH")

sys.path.insert(0, IBOM)

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
    pcbdata, components = parser.parse()
    if not pcbdata:
        sys.exit("parser returned no pcbdata")

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
