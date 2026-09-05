metrics:
    mkdir -p metrics-report
    # Python: cyclomatic + Halstead + SLOC
    uv run radon cc -s -j src/ > metrics-report/radon-cc.json || true
    uv run radon hal src/ -j > metrics-report/radon-hal.json || true
    uv run radon raw -j src/ > metrics-report/radon-raw.json || true
    # Python: cognitive complexity (writes metrics-report/complexipy-results.json)
    uv run complexipy src/ --output metrics-report/complexipy-results.json --output-format json -q || true
    # Python: coverage (target 80%, not enforced); rm stale report so a failed pytest can't leave an old one behind
    rm -f metrics-report/coverage.xml
    uv run pytest -q --cov=src/voice_to_text --cov-report=xml:metrics-report/coverage.xml --cov-report=term-missing -p no:cacheprovider || true
    # Python: CRAP from radon CC + coverage (guarded: depends on coverage.xml from optional pytest step)
    test -f metrics-report/coverage.xml && uv run python metrics/crap_check.py || echo "crap_check skipped: coverage.xml missing"
    # Python: explicit Any occurrences (pyright config unchanged; guarded — pyright.json may be empty if pyright failed)
    uv run pyright --outputjson src/ > metrics-report/pyright.json || true
    test -s metrics-report/pyright.json && uv run python metrics/any_unknown_count.py || echo "pyright summary skipped: report missing or empty"
    # JS: cyclomatic + cognitive via sonarjs rules (metrics-only ESLint)
    npx eslint --no-warn-ignored --config metrics/eslint.config.metrics.mjs --format json 'gnome-ext/**/*.js' > metrics-report/eslint-complexity.json || true
    # JS: LOC
    find gnome-ext -name '*.js' -not -path '*/tests/*' -not -path '*/vendor/*' | xargs wc -l | sort -rn > metrics-report/js-loc.txt
    # JS: dead code (knip, JSON reporter so summary can count entries precisely)
    bunx knip --reporter json --no-exit-code > metrics-report/knip.json || true
    # Python: dead code (vulture)
    uv run vulture src/ --min-confidence 80 > metrics-report/vulture.txt || true
    # Both: duplicate code
    bunx jscpd src/ gnome-ext/ --reporters json --output metrics-report/jscpd --min-tokens 50 --silent || true
    # summary is best-effort: individual report producers above are allowed to fail
    uv run python metrics/metrics_summary.py || echo "metrics_summary skipped: reports incomplete"
    echo "Metrics reports written to metrics-report/"

# @category metrics
# Drill-down: Python cyclomatic complexity per function (from radon-cc.json)
metrics-cc:
    uv run python -c "import json; d=json.load(open('metrics-report/radon-cc.json')); fns=[(b['complexity'],b['name'],p.replace('src/voice_to_text/','')) for p,bs in d.items() for b in bs if b['type'] in ('function','method')]; [print(f'{c:4d}  {n}  ({f})') for c,n,f in sorted(fns,reverse=True)]"

# @category metrics
# Drill-down: Python cognitive complexity per function (from complexipy)
metrics-cognitive:
    uv run python -c "import json; d=json.load(open('metrics-report/complexipy-results.json')); [print(f\"{f['complexity']:4d}  {f['function_name']}  ({f['path'].replace('src/voice_to_text/','')})\") for f in sorted(d,key=lambda x:-x['complexity'])]"

# @category metrics
# Drill-down: CRAP score per function (CC + coverage)
metrics-crap:
    uv run python -c "import json; d=json.load(open('metrics-report/crap.json')); [print(f\"{c['crap']:7.1f}  cc={c['cc']:<3d} cov={c['coverage']*100:.0f}%  {c['name']}  ({c['file'].replace('src/voice_to_text/','')})\") for c in sorted(d,key=lambda x:-x['crap'])]"

# @category metrics
# Drill-down: SLOC per file, Python then JS
metrics-loc:
    uv run radon raw -s src/ | grep -E '(^src/|SLOC)'
    echo "---"
    cat metrics-report/js-loc.txt

# @category metrics
# Drill-down: test coverage per file
metrics-coverage:
    uv run python -c "import xml.etree.ElementTree as ET; cs=[c for p in ET.parse('metrics-report/coverage.xml').getroot().find('packages') for c in p.find('classes')]; [print(f\"{float(c.attrib['line-rate'])*100:5.1f}%  {c.attrib['filename'].replace('src/voice_to_text/','')}\") for c in sorted(cs,key=lambda c:float(c.attrib['line-rate']))]"

# @category metrics
# Drill-down: duplication clones (jscpd)
metrics-duplication:
    bunx jscpd src/ gnome-ext/ --reporters consoleFull --min-tokens 50 || true

# @category metrics
# Drill-down: dead code, Python (vulture) + JS (knip)
metrics-dead-code:
    uv run vulture src/ --min-confidence 80 || true
    bunx knip || true

# @category metrics
# Drill-down: type issues + explicit Any occurrences (pyright)
metrics-types:
    uv run pyright src/ || true
    echo "--- explicit Any/Unknown occurrences ---"
    grep -rnoE '\b(Any|Unknown)\b' src/ || echo "none"

# @category metrics
# Run mutation testing on src/ (long: possibly hours; parallel across cores)
mutants:
    uv run mutmut run --max-children 4
