# Test fixtures

## netdaq-small.json

A trimmed export of [Gherkin/netdaq](https://github.com/Gherkin/netdaq), pinned
to commit `e476a90`. netdaq is licensed CERN-OHL-P-2.0 (Gherkin/netdaq#49).

Copper layers: `F`, `B`, `In1.Cu`, `In2.Cu`. ibom only exports F and B, so
`tools/make_fixture.py` adds the inner layers itself, under their KiCad names.
Allegro exports name inner layers `LAY1`, `LAY2`, ... instead, so this fixture
does not exercise the viewer's `LAY(\d+)` code paths.

To regenerate (needs KiCad's python bindings and an InteractiveHtmlBom checkout):

```
git -C ../netdaq archive -o /tmp/netdaq.tar e476a90 netdaq.kicad_pcb netdaq.kicad_pro netdaq.kicad_prl
mkdir -p /tmp/netdaq && tar -xf /tmp/netdaq.tar -C /tmp/netdaq
python3 tools/make_fixture.py /tmp/netdaq/netdaq.kicad_pcb /tmp/netdaq-full.json
python3 tools/trim_fixture.py /tmp/netdaq-full.json tests/fixtures/netdaq-small.json
```

The trim step drops any zone over 100 KB, which removes the large ground and
power planes. The smoke tests derive their expected counts from the fixture,
so they do not need editing after a regenerate.

To move the pin, change the commit here and in the archive command, and
regenerate. The `demo-board` job in `.github/workflows/ci.yml` builds the
full board for the Pages demo from the same pin; change it there too.

## ciaa-acc.json

A full, untrimmed export of the CIAA-ACC board from
[ciaa/Hardware](https://github.com/ciaa/Hardware), file
`PCB/ACC/CIAA_ACC/ciaa_acc.kicad_pcb`, pinned to commit `56628522`. It is
the large board for perf work: 12 copper layers, 569 footprints, 788 nets,
about 59k track segments, 1875 vias and 47 zones. The JSON is about 20 MB.

The CIAA Project Hardware License is BSD-style and asks that redistributions
keep the AUTHORS file, the conditions and the disclaimer. Both files are in
`ciaa-acc/`, and CI publishes them next to the demo page built from this
board.

The board is a KiCad 5 file. KiCad 10 warns "Legacy zone fill strategy is
not supported anymore" on load and converts the fills. They render as
expected.

To regenerate (needs KiCad's python bindings and an InteractiveHtmlBom checkout):

```
curl -sSfLo /tmp/ciaa_acc.kicad_pcb https://raw.githubusercontent.com/ciaa/Hardware/56628522c5cbf4ddb43a98f4a7d21a2166f5147e/PCB/ACC/CIAA_ACC/ciaa_acc.kicad_pcb
python3 tools/make_fixture.py /tmp/ciaa_acc.kicad_pcb tests/fixtures/ciaa-acc.json
```

To move the pin, change the commit here and in the URL, regenerate, update
the files in `ciaa-acc/` from the same commit, and run `npm run perf:baseline`.
