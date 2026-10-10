# HTMLPCBViewer

A web PCB viewer for board bringup. Reads the JSON export format used by
[InteractiveHtmlBom](https://github.com/openscopeproject/InteractiveHtmlBom)
and serves boards from an NGINX container.

The viewer is heavily based on InteractiveHtmlBom — same data format, similar
look. The BOM side is gone; this is built around net tracing instead. Two-pane
net search, highlight on hover, layer filtering, inner layers visible from both
sides, keyboard shortcuts.

Rendering runs in a Web Worker on an OffscreenCanvas, so pan and zoom stay
smooth on large boards.

## Demo

https://gherkin.github.io/HTMLPCBViewer/

A single self-contained HTML file with the
[Gherkin/netdaq](https://github.com/Gherkin/netdaq) board (CERN-OHL-P-2.0)
inlined. On every push to `main`, CI exports the board from its KiCad source
at the commit pinned in `tests/fixtures/README.md` and rebuilds the page.

Each pull request gets its own demo, built from the PR branch, at
`https://gherkin.github.io/HTMLPCBViewer/pr-preview/pr-<N>/`. A bot comment on
the PR links to it. The preview is removed when the PR is closed. The site is
served from the `gh-pages` branch.

## Requirements

- Allegro PCB Designer, for the export
- Python 3
- Docker, if you want the server

## Export from Allegro

Copy an `ibomConfig.json` next to the `.brd` file, then in Allegro:

```
set telskill
load("jsonDecode.il")
load("exportJson.il")
exportJson( ?config "ibomConfig.json" )
```

The SKILL scripts are in `allegro-skills/`.

## Build

Copy the exported JSON into a new folder under `pcb-exports/`, then:

```
python build_boards.py
```

This writes board payloads to `pcb-viewer-data/`. It skips files that have not
changed; `--force` rebuilds everything. Every run also writes
`pcb-viewer-data/index.json` with each board's path and title. The board list
page reads that file, so run the build again after adding or removing a board
by hand.

The Docker build makes the viewer shell itself. To build it by hand
(writes `docker/viewer.html`):

```
python generate.py --build-viewer
```

For a single file with the board data inlined and no server:

```
python generate.py board.json -o board.html
```

## Serve

```
docker compose up -d --build
```

Or pull the published image (amd64 and arm64) instead of building:

```
docker run -p 1010:80 -v ./pcb-viewer-data:/usr/share/nginx/html/pcbs:ro ghcr.io/gherkin/htmlpcbviewer
```

CI publishes the image once all checks pass. Pushes to `main` publish
`latest`, a `v*` tag publishes its version (`v1.2.3` as `1.2.3`). Every
image is also tagged `sha-<short commit>`.

Boards come from the mounted `pcb-viewer-data/` and open as
`/viewer/?data=/pcbs/<board>.json`. To update a running server, zip
`pcb-viewer-data`, copy it over and restart the container.

## Links

The URL hash holds the current selection, so the address bar is always a
link to it. The link button in the top bar can add the current view and
layers. A link's view and layers apply for that visit only; they do not
change the saved settings.

The hash is a list of `key=value` pairs. Keys may repeat.

| Key | Value |
|---|---|
| `comp` | Pinned component, e.g. `comp=U5`. |
| `net` | Walked net, e.g. `net=/ADC1/CS`. `comp` and `net` keep selection order, which sets the colours. |
| `focus` | `comp:U5` or `net:GND`, what the detail pane shows. Default is the last `comp` or `net`. |
| `side` | `F`, `B` or `FB`. |
| `viewF`, `viewB` | Visible area per side: `cx,cy,w,h` in board units. |
| `zoom` | `board`, `selected` or `highlight`, same as W, E and R. Used when there is no view. |
| `copper` | Shown copper layer, as named in the CAD tool, e.g. `copper=F`. Layers not listed are off; `copper=` alone hides them all. Add `:` and letters to show only some kinds: `t` tracks, `z` zones, `v` vias, `s` silk, `f` fab. `copper=In1.Cu:tv` shows tracks and vias on In1.Cu. |
| `netlayers` | `1` turns on every layer the linked nets are routed on. |

Example: `board.html#net=/ADC1/CS&net=GND&netlayers=1&zoom=selected`.

A hash longer than 1500 characters is compressed into a single `z=` value.
Old `#component=U5` links still work, and so do the old `layers`, `xray`
and `overlay` keys.

## License

MIT, see [LICENSE](LICENSE).

Derived from InteractiveHtmlBom (MIT) and includes code from it,
from [exportJson](https://github.com/juulsA/exportJson) and from Split.js.
[NOTICE](NOTICE) lists what came from where.

`generate.py` writes the license notices into every generated HTML file,
since that file contains the whole viewer. Leave that block in place.
