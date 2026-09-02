"""Count explicit `Any` occurrences via word-boundary grep and record pyright summary."""

import json
import re
import subprocess
from pathlib import Path

REPORTS = Path("metrics-report")

d = json.loads((REPORTS / "pyright.json").read_text())
out = subprocess.run(["grep", "-rn", r"\bAny\b", "src/"], capture_output=True, text=True)
(REPORTS / "any-unknown-count.json").write_text(
    json.dumps(
        {
            "pyright_summary": d["summary"],
            "explicit_Any_occurrences_grep": len(re.findall(r"\bAny\b", out.stdout)),
        },
        indent=2,
    )
)
