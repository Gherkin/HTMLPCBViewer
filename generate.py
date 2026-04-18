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
        # For render.js, inline the worker script as a JS string literal
        if filename == "render.js":
            worker_code = read_web_file(WORKER_FILE)
            # Escape for embedding inside a JS double-quoted string:
            #   \ -> \\, " -> \", newline -> \n, carriage return removed
            escaped = (worker_code
                       .replace("\\", "\\\\")
                       .replace('"', '\\"')
                       .replace("\r", "")
                       .replace("\n", "\\n"))
            content = content.replace(WORKER_PLACEHOLDER, escaped)
        html = html.replace(placeholder, content)

    # Inject board data — gzip compressed, decompressed at runtime via native DecompressionStream
    pcb = dict(data["pcbdata"])
    if "components" in data:
        pcb["components"] = data["components"]
    raw_json = json.dumps(pcb, separators=(",", ":"))
    compressed = base64.b64encode(
        gzip.compress(raw_json.encode("utf-8"), compresslevel=6)
    ).decode("ascii")
    pcbdata_js = (
        'var pcbdata;'
        'var pcbdataReady=(async function(){'
        'var _t0=performance.now();'
        # Fast base64 decode: atob + typed array for loop (no per-element callback)
        'var bstr=atob("' + compressed + '");'
        'var n=bstr.length,bin=new Uint8Array(n);'
        'for(var i=0;i<n;i++)bin[i]=bstr.charCodeAt(i);'
        'var _t1=performance.now();'
        # Use Response + pipeThrough + arrayBuffer() — no manual chunk loop
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
