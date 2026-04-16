#!/usr/bin/env python3
"""
PCBA Bringup Viewer generator.
Reads an Allegro/InteractiveHtmlBom JSON export and produces a single
self-contained HTML viewer focused on board bringup and test-point navigation.

Usage:
    python generate.py <input.json> [-o output.html]
"""

import argparse
import json
import os
import sys


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(SCRIPT_DIR, "web")

PLACEHOLDERS = {
    "///SPLITJS///": "split.js",
    "///CSS///": "viewer.css",
    "///UTILJS///": "util.js",
    "///RENDERJS///": "render.js",
    "///APPJS///": "app.js",
}


def read_web_file(filename):
    path = os.path.join(WEB_DIR, filename)
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def generate(input_json_path, output_html_path):
    # Load and validate the input JSON
    print(f"Reading {input_json_path}...")
    with open(input_json_path, "r", encoding="utf-8") as f:
        raw = f.read()

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"Error: invalid JSON: {e}", file=sys.stderr)
        sys.exit(1)

    if "pcbdata" not in data:
        print("Error: JSON does not contain 'pcbdata' key. Is this an ibom-compatible export?",
              file=sys.stderr)
        sys.exit(1)

    # Read template
    template_path = os.path.join(WEB_DIR, "viewer.html")
    with open(template_path, "r", encoding="utf-8") as f:
        html = f.read()

    # Inject static files
    for placeholder, filename in PLACEHOLDERS.items():
        content = read_web_file(filename)
        html = html.replace(placeholder, content)

    # Inject board data — extract the pcbdata sub-object and merge top-level
    # components (ref/val/layer/etc.) into it so JS can use pcbdata.components.
    pcb = dict(data["pcbdata"])
    if "components" in data:
        pcb["components"] = data["components"]
    pcbdata_js = "var pcbdata = " + json.dumps(pcb, separators=(",", ":")) + ";"
    html = html.replace("///PCBDATA///", pcbdata_js)

    # Write output
    with open(output_html_path, "w", encoding="utf-8") as f:
        f.write(html)

    size_kb = os.path.getsize(output_html_path) / 1024
    print(f"Written {output_html_path}  ({size_kb:.0f} KB)")


def main():
    parser = argparse.ArgumentParser(
        description="Generate a standalone PCBA bringup viewer HTML file."
    )
    parser.add_argument("input", help="Path to the Allegro JSON export file")
    parser.add_argument(
        "-o", "--output",
        help="Output HTML file path (default: <input_stem>_viewer.html)",
        default=None,
    )
    args = parser.parse_args()

    if not os.path.isfile(args.input):
        print(f"Error: input file not found: {args.input}", file=sys.stderr)
        sys.exit(1)

    if args.output is None:
        stem = os.path.splitext(os.path.basename(args.input))[0]
        args.output = os.path.join(os.path.dirname(args.input) or ".", stem + "_viewer.html")

    generate(args.input, args.output)


if __name__ == "__main__":
    main()
