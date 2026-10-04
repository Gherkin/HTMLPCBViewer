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
