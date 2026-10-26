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

## Static site

The same pages also work on a static host such as GitHub Pages, with no
server. Build a folder with this layout:

```
site/
  index.html        board list page
  favicon.svg
  viewer/index.html viewer shell
  pcbs/             board payloads and index.json
```

From the repo root:

```
python generate.py --build-viewer -o site/viewer/index.html
python build_boards.py --src pcb-exports --out site/pcbs
cp docker/index.html web/favicon.svg site/
```

Upload `site/` as it is. If GitHub Pages builds your site from a branch,
it runs Jekyll first, and Jekyll skips some files, such as names that start
with `_` or `.`. An empty `site/.nojekyll` should turn Jekyll off. This
step has not been tried on a real Pages deploy yet.

The site root is the folder that holds `viewer/` and `pcbs/`. It may be
a sub-path. On a project site, `https://<user>.github.io/<repo>/`, a
board opens as
`https://<user>.github.io/<repo>/viewer/?data=/<repo>/pcbs/<board>.json`.
The board list page makes these links itself. The board path in `data=`
starts at the host root, so it includes `/<repo>/`.

To try the folder locally, copy it under a sub-path, as on GitHub Pages,
and serve the parent:

```
rm -rf www/repo
mkdir -p www
cp -r site www/repo
python -m http.server 8000 --directory www
```

Then open `http://localhost:8000/repo/`.

Agents read this layout through the MCP server in stdio mode, see
[Static sites (stdio mode)](#static-sites-stdio-mode). A single file from
`generate.py board.json -o board.html` has the board inlined and cannot be
read by agents.

## MCP server for agents

`docker compose up` also starts `pcb-mcp`, an MCP server that reads the same
board folder. nginx passes `/mcp` on to it, so agents reach it at
`http://<host>:1010/mcp` (MCP over Streamable HTTP). One server is shared by
everyone who uses the viewer. To run the viewer without it, leave the
`pcb-mcp` service out of `docker-compose.yml`; `/mcp` then answers 502.

The published image is `ghcr.io/gherkin/htmlpcbviewer-mcp`, with the same tags
as the viewer image. It reads boards from `/pcbs` and listens on port 3000.
nginx looks for it under the name `pcb-mcp` on the same Docker network.

Tools:

| Tool | Returns |
|---|---|
| `list_boards` | Each board's path and title, from `index.json`. |
| `locate` | Side, center, size and rotation of parts by refdes, from the footprint bbox, in board units (mm for KiCad). |
| `net_places` | Every pad on a net: refdes, side, position and pad type. No vias. |
| `nearest` | The pads on a net nearest to a part or point, nearest first, each marked as test point, through-hole or SMD, and with the part that covers it if any. No vias. |
| `nearest_vias` | The vias on a net nearest to a part or point, with layers, pad diameter and the part that covers it if any. A last resort: vias are often under soldermask, and the export cannot tell which. |
| `link` | A viewer link with parts and nets selected, markers, side, view and copper layers. Unknown names are an error. |
| `snapshot` | A PNG of what a link shows, so an agent can check it before giving it out. Takes a link or the same fields as `link`, and a window size (default 1280x800, at most 2560x1600). |

Links from `link` need the address of the board list page as users open
it (the folder that holds `viewer/`, not the viewer page). Set it as
`VIEWER_URL` for `pcb-mcp`, e.g. in `.env` next to `docker-compose.yml`:

```
VIEWER_URL=http://pcbhost:1010/
```

Without it, links start at `/viewer/` and the tool tells the agent to ask
for the address. An agent can also pass `base_url` to the tool.

`snapshot` opens the link in headless Chromium inside the `pcb-mcp`
container (the viewer image has no browser). That browser cannot always
reach the address users use, so it has its own setting,
`SNAPSHOT_VIEWER_URL`. `docker-compose.yml` sets it to `http://pcb-viewer/`,
the viewer service on the Docker network; change it only if the viewer
service has another name. It is used to draw pictures only, never in a link.
Outside Docker it defaults to `VIEWER_URL`. The browser draws at most 2
snapshots at a time, with 4 more waiting; past that the tool says the
server is busy. Each snapshot has 30 s.

To connect Claude Code:

```
claude mcp add --transport http pcb-viewer http://<host>:1010/mcp
```

Other clients take the same URL as a "Streamable HTTP" or "HTTP" server.

To run the server outside Docker (needs Node 22):

```
cd mcp
npm ci
npx playwright-core install --with-deps --only-shell chromium
PCBS_DIR=../pcb-viewer-data PORT=3000 npm start
npm test
```

The browser is only needed for `snapshot` and its tests. `npm test` runs the
tool tests twice: once as in Docker, once with the boards read over HTTP as
in stdio mode below.

### Static sites (stdio mode)

A static host such as GitHub Pages cannot run the server. Run the same server
on your own machine instead; the agent starts it and talks to it over stdio.
It reads `pcbs/index.json` and the boards from the site, and offers the same
tools. Build the site as in [Static site](#static-site).

```
git clone https://github.com/Gherkin/HTMLPCBViewer.git
cd HTMLPCBViewer/mcp
npm ci
claude mcp add pcb-viewer -- node "$PWD/src/main.js" --stdio --site https://<user>.github.io/<repo>/
```

Other clients take the same command as a "stdio" server.

`--site` is the site root: the folder that holds `viewer/` and `pcbs/`.
Links point at `<site>viewer/`. The board path in `data=` includes the site
path, e.g. `https://<user>.github.io/<repo>/viewer/?data=/<repo>/pcbs/board.json`,
so links work on a GitHub Pages project site too.

`snapshot` needs Chromium on your machine. Install it once, in `mcp/`:

```
npx playwright-core install --only-shell chromium
```

On Linux, add `--with-deps` if Chromium then fails to start. Without it,
`snapshot` returns an error that says this, and the other tools work as
usual. Snapshots open the public site itself; set `SNAPSHOT_VIEWER_URL` to
draw from another copy of it.

Chromium keeps its own sandbox on your machine. Only the Docker image turns
it off (`CHROMIUM_NO_SANDBOX=1`), since the container is the boundary there.
If the sandbox cannot start, `snapshot` returns an error that says so; it
does not fall back to running without it.

Boards are kept in memory once read, up to 256 MB in all, least recently
used dropped first. Each call still asks the site whether a file changed
(`If-None-Match` / `If-Modified-Since`), so a new deploy shows up on the next
call and an unchanged board costs one small request. A file the site sends
without `ETag` or `Last-Modified` is fetched every time. A file over 64 MB,
or one that takes more than 30 s, is an error.

### Agent skill

`skills/pcb-viewer/SKILL.md` tells an agent how to use these tools: get net
and pin names from a netlist MCP server, look for pads with `nearest` first,
use vias only as a last resort, and give links made by `link`. It is a
Claude Code skill (a folder with a `SKILL.md`).

To install it for yourself in Claude Code, from the repo root:

```
mkdir -p ~/.claude/skills
cp -r skills/pcb-viewer ~/.claude/skills/
```

Or copy it into `.claude/skills/` of a project to use it there only. To keep
it up to date with the repo, use a link instead of the copy:
`ln -s "$PWD/skills/pcb-viewer" ~/.claude/skills/`. Remove an old copy
first, or the link ends up inside it. Claude Code picks the skill up when a question matches its
description; `/pcb-viewer` starts it by hand. Other agents can read the
file as plain instructions.

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
| `mark` | Marker at a board point: side, then `x,y` in board units, e.g. `mark=F:167.75,144.23`. Drawn on top of everything, on that side only; it does not change the selection. May repeat. Without `side`, the link shows the sides the markers are on. Esc removes them. |
| `zoom` | `board`, `selected` or `highlight`, same as W, E and Z. Used when there is no view. `selected` (and E) also fits the markers. |
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
