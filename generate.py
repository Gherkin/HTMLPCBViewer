#!/usr/bin/env python3
"""
PCBA Bringup Viewer generator.
Reads an Allegro/InteractiveHtmlBom JSON export and produces either:
  - A single self-contained HTML viewer (default / legacy mode)
  - A shared viewer shell + separate board JSON file (split mode)

Usage:
    # Legacy: one self-contained HTML
    python generate.py <input.json> [-o output.html]

    # Split: write only board payload JSON
    python generate.py <input.json> --split [-o board.json]

    # Build shared viewer shell (no board data embedded)
    python generate.py --build-viewer [-o docker/viewer.html]
"""

import argparse
import json
import gzip
import base64
import os
import sys


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(SCRIPT_DIR, "web")

PLACEHOLDERS = {
    "///SPLITJS///": "split.js",
    "///CSS///":     "viewer.css",
    "///UTILJS///":  "util.js",
    "///RENDERJS///": "render.js",
    "///APPJS///":   "app.js",
}

# The render-worker.js is inlined as a JS string literal inside render.js
WORKER_PLACEHOLDER = "///RENDERWORKERJS_INLINE///"
WORKER_FILE = "render-worker.js"


def read_web_file(filename):
    path = os.path.join(WEB_DIR, filename)
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def build_html_skeleton():
    """Read viewer.html and inline all static web assets (CSS/JS).
    Returns the HTML string with ///PCBDATA/// still as a placeholder."""
    template_path = os.path.join(WEB_DIR, "viewer.html")
    with open(template_path, "r", encoding="utf-8") as f:
        html = f.read()

    for placeholder, filename in PLACEHOLDERS.items():
        content = read_web_file(filename)
        if filename == "render.js":
            worker_code = read_web_file(WORKER_FILE)
            escaped = (worker_code
                       .replace("\\", "\\\\")
                       .replace('"', '\\"')
                       .replace("\r", "")
                       .replace("\n", "\\n"))
            content = content.replace(WORKER_PLACEHOLDER, escaped)
        html = html.replace(placeholder, content)

    return html


def make_pcbdata_inline_js(data):
    """Return the ///PCBDATA/// replacement for legacy self-contained mode."""
    pcb = dict(data["pcbdata"])
    if "components" in data:
        pcb["components"] = data["components"]
    raw_json = json.dumps(pcb, separators=(",", ":"))
    compressed = base64.b64encode(
        gzip.compress(raw_json.encode("utf-8"), compresslevel=6)
    ).decode("ascii")
    return (
        'var pcbdata;'
        'var pcbdataReady=(async function(){'
        'var _t0=performance.now();'
        'var bstr=atob("' + compressed + '");'
        'var n=bstr.length,bin=new Uint8Array(n);'
        'for(var i=0;i<n;i++)bin[i]=bstr.charCodeAt(i);'
        'var _t1=performance.now();'
        'var ab=await new Response('
        '  new Blob([bin]).stream().pipeThrough(new DecompressionStream("gzip"))'
        ').arrayBuffer();'
        'var _t2=performance.now();'
        'pcbdata=JSON.parse(new TextDecoder().decode(ab));'
        'var _t3=performance.now();'
        'console.log("[PCBAViewer] b64decode: "+(_t1-_t0).toFixed(0)+"ms'
        ' | gzip: "+(_t2-_t1).toFixed(0)+"ms'
        ' | JSON.parse: "+(_t3-_t2).toFixed(0)+"ms'
        ' | total: "+(_t3-_t0).toFixed(0)+"ms");'
        '})();'
    )


# Bootstrap used in the shared viewer shell — loads board.json via ?data= query param.
FETCH_BOOTSTRAP_JS = (
    'var pcbdata;'
    'var pcbdataReady=(async function(){'
    'var _url=new URLSearchParams(location.search).get("data");'
    'if(!_url){'
    '  document.getElementById("loading-label").textContent='
    '    "Error: no ?data= parameter. Use ?data=/pcbs/path/to/board.json";'
    '  throw new Error("[PCBAViewer] No ?data= query parameter");'
    '}'
    'var _t0=performance.now();'
    'var _resp=await fetch(_url);'
    'if(!_resp.ok)throw new Error("[PCBAViewer] Fetch failed: "+_resp.status+" "+_resp.statusText+" ("+_url+")");'
    'pcbdata=await _resp.json();'
    'console.log("[PCBAViewer] fetch+parse: "+(performance.now()-_t0).toFixed(0)+"ms | "+_url);'
    '})();'
)


def make_pcb_payload(data):
    """Return the board payload dict (pcbdata + components)."""
    pcb = dict(data["pcbdata"])
    if "components" in data:
        pcb["components"] = data["components"]
    return pcb


def load_and_validate(input_json_path):
    print(f"Reading {input_json_path}...")
    with open(input_json_path, "r", encoding="utf-8") as f:
        raw = f.read()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"Error: invalid JSON: {e}", file=sys.stderr)
        sys.exit(1)
    # Accept two formats:
    #   1. ibom export envelope: {"pcbdata": {...}, "components": [...]}
    #   2. raw pcbdata object: {"metadata": ..., "footprints": ..., ...}
    if "pcbdata" not in data:
        if "footprints" in data and "edges_bbox" in data:
            # Already raw pcbdata — wrap it so the rest of the pipeline is uniform
            data = {"pcbdata": data}
        else:
            print("Error: JSON does not contain 'pcbdata' key and does not look like raw "
                  "pcbdata (missing 'footprints'/'edges_bbox'). Is this an ibom-compatible export?",
                  file=sys.stderr)
            sys.exit(1)
    return data


def generate_legacy(input_json_path, output_html_path):
    """Original mode: single self-contained HTML with board data inlined."""
    data = load_and_validate(input_json_path)
    html = build_html_skeleton()
    html = html.replace("///PCBDATA///", make_pcbdata_inline_js(data))
    with open(output_html_path, "w", encoding="utf-8") as f:
        f.write(html)
    size_kb = os.path.getsize(output_html_path) / 1024
    print(f"Written {output_html_path}  ({size_kb:.0f} KB)")


def generate_split(input_json_path, output_json_path):
    """Split mode: write only the board payload JSON.
    Serve the shared viewer shell separately via Docker/NGINX."""
    data = load_and_validate(input_json_path)
    payload = make_pcb_payload(data)
    os.makedirs(os.path.dirname(os.path.abspath(output_json_path)), exist_ok=True)
    with open(output_json_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, separators=(",", ":"))
    size_kb = os.path.getsize(output_json_path) / 1024
    print(f"Written {output_json_path}  ({size_kb:.0f} KB)")
    meta = payload.get("metadata", {})
    title = meta.get("title", os.path.basename(output_json_path))
    print(f"Board: {title}")
    print(f"Open with: /viewer/?data=/pcbs/<path-to>/{os.path.basename(output_json_path)}")


def build_viewer(output_html_path):
    """Build the shared viewer shell: all JS/CSS inlined, board data loaded via ?data=."""
    html = build_html_skeleton()
    html = html.replace("///PCBDATA///", FETCH_BOOTSTRAP_JS)
    os.makedirs(os.path.dirname(os.path.abspath(output_html_path)), exist_ok=True)
    with open(output_html_path, "w", encoding="utf-8") as f:
        f.write(html)
    size_kb = os.path.getsize(output_html_path) / 1024
    print(f"Written shared viewer shell: {output_html_path}  ({size_kb:.0f} KB)")
    print("Deploy this file once; point boards at it with ?data=/pcbs/path/to/board.json")


def main():
    parser = argparse.ArgumentParser(
        description="Generate PCBA bringup viewer HTML and/or board payload files."
    )
    # Mutually exclusive mode flags
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--split",
        action="store_true",
        help="Write only board payload JSON (use with a separately deployed shared viewer).",
    )
    mode.add_argument(
        "--build-viewer",
        action="store_true",
        help="Build the shared viewer shell (no board data). Deploy once in Docker.",
    )

    parser.add_argument(
        "input",
        nargs="?",
        help="Path to the Allegro JSON export file (not needed with --build-viewer).",
    )
    parser.add_argument(
        "-o", "--output",
        help=(
            "Output path. "
            "Legacy/split: defaults to <input_stem>.html or <input_stem>.json. "
            "--build-viewer: defaults to docker/viewer.html."
        ),
        default=None,
    )
    args = parser.parse_args()

    if args.build_viewer:
        out = args.output or os.path.join(SCRIPT_DIR, "docker", "viewer.html")
        build_viewer(out)
        return

    if args.input is None:
        parser.error("input JSON file is required (omit only with --build-viewer).")

    if not os.path.isfile(args.input):
        print(f"Error: input file not found: {args.input}", file=sys.stderr)
        sys.exit(1)

    stem = os.path.splitext(os.path.basename(args.input))[0]
    input_dir = os.path.dirname(args.input) or "."

    if args.split:
        out = args.output or os.path.join(input_dir, stem + ".json")
        generate_split(args.input, out)
    else:
        out = args.output or os.path.join(input_dir, stem + "_viewer.html")
        generate_legacy(args.input, out)


if __name__ == "__main__":
    main()
