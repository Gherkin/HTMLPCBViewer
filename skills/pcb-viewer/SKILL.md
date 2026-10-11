---
name: pcb-viewer
description: Find where to measure, probe or patch a net on a PCB, and show it with a viewer link. Use when the user asks where on a board a net, pin or part is, e.g. "where can I measure +3.3V?", "is there a point to patch +3.3V near U69?", or wants a link or picture of a spot on the board. Needs the pcb-viewer MCP server; the netlist MCP server helps with net and pin names.
---

# PCB viewer: find a spot and link to it

The `pcb-viewer` MCP server knows where things are on a board. It makes viewer
links and pictures. It does not know the circuit. Ask circuit questions
("what is on this net?", "which pin is VDD?") to the `netlist` MCP server.

How to connect the server (Docker over HTTP at `/mcp`, or `--stdio --site` for
a static site) is in the HTMLPCBViewer README, section "MCP server for
agents". If no `pcb-viewer` tools are there, say so and point the user to
that section.

## Tools

| Tool | Use it for |
|---|---|
| `list_boards` | Board paths. Every other tool takes one as `board`. |
| `locate` | Side, center, size and extent of parts by refdes. |
| `net_places` | Every pad on a net. |
| `nearest` | Pads on a net nearest to a part or a point. Start here. |
| `nearest_vias` | Vias on a net nearest to a part or a point. Last resort. |
| `link` | A viewer link. The only way to make one. |
| `snapshot` | A PNG of what a link shows. |

## Names

- Take net and pin names from the netlist MCP (`get_net`, `get_pin`,
  `get_component`, `find_components`, `filter_nets`). Use them exactly as the
  CAD tool writes them, with the same case, `+`, `/` and dots. On netdaq the
  3.3 V rail is `+3.3V`, not `3V3` or `+3V3`.
- If the netlist MCP is not there, look the name up on the board with
  `net_places`, and say that you did.
- `found: false` means the board has no net by that name. Check the name; do
  not guess another one.
- Pads have `pin` on KiCad boards exported with `tools/make_fixture.py`. It
  is the PIN in the netlist's `REFDES:PIN` (U24 pad `pin: "4"` is `U24:4`).
  Use it to match a pad to a netlist pin. Allegro boards and KiCad boards from
  stock ibom have no `pin`; there, match by refdes and position only, and say
  so.

## Find a point to measure or patch

1. `list_boards`, pick the board.
2. Get the net name from the netlist MCP.
3. `nearest` with `board`, `net` and `near` (a refdes, or an `[x, y]` point).
   Add `side` if the user can only reach one side.
4. Read the result:
   - It is sorted by distance only. `testpoint: true` and `type` (`"th"` or
     `"smd"`) are labels. Prefer a test point or a through-hole pad when it is
     about as close as the nearest pad. Through-hole pads can be reached from
     both sides.
   - `own: true` is a pad of the part given as `near`. Own pads do not count
     toward `limit`. Own pads under a BGA or QFN body may not be reachable;
     do not offer those. A pin of a leaded part (SOIC, TSSOP, SOT) can be
     the best point itself. Say when its pins are close together, since a
     wire is then hard to solder without bridging.
   - `covered_by` means the pad is inside another part's box. The box
     includes silk and fab outlines, so it can also mean "right next to that
     part". Say which part it is; it may still be usable.
   - `side` is the side to reach the pad from: `F` (top), `B` (bottom) or
     `both`.
   - `distance` is in board units: mm on KiCad boards. On Allegro boards the
     unit is not known; do not call it mm.
5. Only when no usable pad is near, use `nearest_vias`. Then tell the user:
   - a via is a last resort;
   - it is likely covered by soldermask, which must be scraped off first;
   - the board data cannot say whether it is covered.
   Vias under the near part do not count toward `limit`.

## Links

- Always give links made by `link`. Never write a viewer URL or hash by hand,
  and never edit one.
- For a single pad or via, put a marker on it: `marks: [{side, x, y}]` with
  the `x` and `y` from `nearest` or `nearest_vias`. For a pad with `side:
  "both"`, pick `F` or `B`. Also select the part (`refs`) and the net (`nets`)
  so the user sees what it is.
- Zoom: leave `zoom` and the views out, and set `focus` to the part
  (`"comp:U24"`); the viewer then zooms to that part. Without `focus` the
  last selected item wins, which is the net when `nets` is given. `zoom: "selected"` fits
  everything selected, and a selected rail such as `+3.3V` spans most of the
  board, so the marker gets small. To frame a spot that is not on a part,
  give `view_f` or `view_b`, a box around it.
- Read `warnings`. If it says the server does not know its own address, ask
  the user for the address of the board list page (e.g.
  `http://host:1010/`, not a `/viewer/` link) and call `link` again with
  `base_url`.
- `link` fails on a refdes, net or layer that is not on the board. Fix the
  name; do not drop it silently.

## Check with snapshot

Call `snapshot` with the link (`url`) when the answer matters, for example
before the user cuts a track, patches a wire or scrapes a via. Look at the
picture: right board, right side, marker on the right pad. If `snapshot` says
it is not set up or the server is busy, give the link anyway and say that it
was not checked.

## Answer

Give the user, short:

- the point: refdes and pin (or "via"), side, what it is (test point,
  through-hole, SMD pad), distance and unit;
- any `covered_by` and what it means here;
- for a via: the last resort and soldermask note;
- the link from `link`.
