# HTMLPCBViewer

A web PCB viewer for board bringup work. It reads the JSON export format used by
[InteractiveHtmlBom](https://github.com/openscopeproject/InteractiveHtmlBom) and
serves boards from a small NGINX container.

## Usage

copy some `ibomConfig.json` to the same folder as the .brd file.

```
set telskill
```

```
load("jsonDecode.il")
load("exportJson.il")
exportJson( ?config "ibomConfig.json" )
```

copy the json to a new folder under pcb-exports

run
```
python build_boards.py
```

zip the output pcb-viewer-data
send to the docker server, restart the docker

## License and credits

This project is licensed under the MIT license — see `LICENSE`.

It is a derivative of [InteractiveHtmlBom](https://github.com/openscopeproject/InteractiveHtmlBom)
by qu1ck (MIT), which is also MIT licensed. The viewer reuses its JSON data format
and a substantial amount of its rendering and interaction code, and follows its
look and feel.

Where the code comes from:

| File | Origin |
| --- | --- |
| `web/render.js`, `web/render-worker.js` | Derived from InteractiveHtmlBom `web/render.js`. Split into a main-thread coordinator plus an OffscreenCanvas worker; drawing primitives, path building and hit-testing are largely upstream. |
| `web/app.js` | Derived in part from InteractiveHtmlBom `web/ibom.js` and `web/table-util.js`. |
| `web/util.js` | Derived in part from InteractiveHtmlBom `web/util.js` (storage, settings, dark mode, metadata). |
| `web/viewer.css` | Inspired by, and partly derived from, InteractiveHtmlBom `web/ibom.css`. |
| `web/split.js` | [Split.js](https://github.com/nathancahill/split) v1.3.5 by Nathan Cahill (MIT), vendored unmodified as shipped by InteractiveHtmlBom. |
| `allegro-skills/jsonDecode.il` | [exportJson](https://github.com/juulsA/exportJson) by juulsA (MIT), unmodified. |
| `allegro-skills/exportJson.il` | [exportJson](https://github.com/juulsA/exportJson) by juulsA (MIT), with local modifications. |
| `generate.py`, `build_boards.py`, `docker/` | Original to this project. |

The JSON data format is documented in InteractiveHtmlBom's
[`DATAFORMAT.md`](https://github.com/openscopeproject/InteractiveHtmlBom/blob/master/DATAFORMAT.md).

The MIT license requires the copyright and permission notices to travel with all
copies and substantial portions. `generate.py` therefore writes them into every
generated viewer HTML file as a comment at the top — do not strip that block.