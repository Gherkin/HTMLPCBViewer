#!/usr/bin/env python3
"""
Build board JSON payload files for the PCBA viewer.

Walks pcb-exports/ (or --src), mirrors the folder structure into
pcb-viewer-data/ (or --out), and calls generate.py --split for each
source JSON that is new or has been modified since last build.

Usage:
    python build_boards.py               # incremental (skip unchanged)
    python build_boards.py --force       # rebuild everything
    python build_boards.py --dry-run     # show what would be built
    python build_boards.py --src other/  # custom source directory
    python build_boards.py --out other/  # custom output directory
"""

import argparse
import os
import sys
import subprocess

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_SRC = os.path.join(SCRIPT_DIR, "pcb-exports")
DEFAULT_OUT = os.path.join(SCRIPT_DIR, "pcb-viewer-data")


def find_source_jsons(src_root):
    """Yield (rel_path, abs_path) for every .json under src_root."""
    for dirpath, dirnames, filenames in os.walk(src_root):
        # Skip hidden dirs
        dirnames[:] = [d for d in sorted(dirnames) if not d.startswith(".")]
        for fname in sorted(filenames):
            if fname.lower().endswith(".json"):
                abs_path = os.path.join(dirpath, fname)
                rel_path = os.path.relpath(abs_path, src_root)
                yield rel_path, abs_path


def output_path_for(rel_path, out_root):
    """Return the output .json path for a given source rel_path."""
    # Keep the same relative path — source files are already named *.json
    return os.path.join(out_root, rel_path)


def needs_rebuild(src_abs, out_abs):
    """Return True if output is missing or older than source."""
    if not os.path.isfile(out_abs):
        return True
    return os.path.getmtime(src_abs) > os.path.getmtime(out_abs)


def build_one(src_abs, out_abs, dry_run=False):
    os.makedirs(os.path.dirname(out_abs), exist_ok=True)
    cmd = [sys.executable, os.path.join(SCRIPT_DIR, "generate.py"),
           src_abs, "--split", "-o", out_abs]
    if dry_run:
        print(f"  [dry-run] {' '.join(cmd)}")
        return True
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"  ERROR: {result.stderr.strip() or result.stdout.strip()}")
        return False
    # Print the "Written …" line from generate.py
    for line in (result.stdout + result.stderr).splitlines():
        if line.strip():
            print(f"  {line.strip()}")
    return True


def main():
    parser = argparse.ArgumentParser(description="Build PCB viewer board JSON payloads.")
    parser.add_argument("--src", default=DEFAULT_SRC,
                        help=f"Source directory of raw board JSONs (default: {DEFAULT_SRC})")
    parser.add_argument("--out", default=DEFAULT_OUT,
                        help=f"Output directory for viewer payloads (default: {DEFAULT_OUT})")
    parser.add_argument("--force", action="store_true",
                        help="Rebuild all boards even if output is up to date.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Show what would be built without writing anything.")
    args = parser.parse_args()

    src_root = os.path.abspath(args.src)
    out_root = os.path.abspath(args.out)

    if not os.path.isdir(src_root):
        print(f"Error: source directory not found: {src_root}", file=sys.stderr)
        sys.exit(1)

    boards = list(find_source_jsons(src_root))
    if not boards:
        print(f"No .json files found under {src_root}")
        return

    print(f"Source : {src_root}")
    print(f"Output : {out_root}")
    print(f"Boards : {len(boards)} found")
    print()

    built = skipped = failed = 0

    for rel_path, src_abs in boards:
        out_abs = output_path_for(rel_path, out_root)
        if not args.force and not needs_rebuild(src_abs, out_abs):
            print(f"  skip  {rel_path}  (up to date)")
            skipped += 1
            continue

        tag = "build" if not args.dry_run else "dry  "
        print(f"  {tag}  {rel_path}")
        ok = build_one(src_abs, out_abs, dry_run=args.dry_run)
        if ok:
            built += 1
        else:
            failed += 1

    print()
    print(f"Done.  built={built}  skipped={skipped}  failed={failed}")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
