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
changed; `--force` rebuilds everything.

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

Pushing a `v*` tag runs CI and then publishes the image, tagged with the
version and `latest`.

Boards come from the mounted `pcb-viewer-data/` and open as
`/viewer/?data=/pcbs/<board>.json`. To update a running server, zip
`pcb-viewer-data`, copy it over and restart the container.

## License

MIT, see [LICENSE](LICENSE).

Derived from InteractiveHtmlBom (MIT) and includes code from it,
from [exportJson](https://github.com/juulsA/exportJson) and from Split.js.
[NOTICE](NOTICE) lists what came from where.

`generate.py` writes the license notices into every generated HTML file,
since that file contains the whole viewer. Leave that block in place.
