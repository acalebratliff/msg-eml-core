#!/bin/bash
# Convert every .msg in a folder, read each .eml back with Python's email
# package, run the independent reader (extract-msg) and compare.
#
# usage: qa/run_corpus.sh <samples-dir> <new-output-dir> <python-with-extract-msg>
# The output dir must not exist (results are never overwritten).
# extract-msg (GPL-3.0) is only run as a separate test tool; it is not a
# dependency of this project and nothing from it is distributed.
set -u
SAMPLES=$1; OUT=$2; PY=$3
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(dirname "$HERE")
if [ -e "$OUT" ]; then echo "output dir exists: $OUT" >&2; exit 1; fi
mkdir -p "$OUT"
for f in "$SAMPLES"/*.msg; do
  b=$(basename "$f" .msg)
  start=$(date +%s%N)
  timeout 60 node "$ROOT/cli/msg2eml.js" "$f" "$OUT/$b.eml" --report "$OUT/$b.report.json" ${MSG2EML_OPTS:-} 2>"$OUT/$b.stderr"
  rc=$?
  end=$(date +%s%N)
  echo "{\"rc\": $rc, \"ms\": $(( (end-start)/1000000 ))}" > "$OUT/$b.run.json"
  "$PY" "$HERE/indep.py" "$f" "$OUT/$b.ind.json" 2>/dev/null
  if [ $rc -eq 0 ]; then
    "$PY" "$HERE/eml_model.py" "$OUT/$b.eml" "$OUT/$b.ours.json" 2>"$OUT/$b.model.err"
    "$PY" "$HERE/compare.py" "$OUT/$b.ours.json" "$OUT/$b.ind.json" "$OUT/$b.report.json" "$f" > "$OUT/$b.cmp.json" 2>"$OUT/$b.cmp.err"
  fi
done
"$PY" "$HERE/summarize.py" "$SAMPLES" "$OUT" "${BASELINE:-}" > "$OUT/summary.md"
"$PY" "$HERE/html_stream_check.py" "$SAMPLES" "$OUT" > "$OUT/html_stream_check.md" || echo "PidTagHtml stream check FAILED (see html_stream_check.md)" >&2
cat "$OUT/summary.md" | head -5
