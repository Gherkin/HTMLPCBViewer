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