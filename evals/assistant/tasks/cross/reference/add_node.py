"""题目「跨机器」的参考答案：在 pull 下来的联调副本里加上「统计访问日志」这一步。"""

import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
pulled = json.loads(path.read_text())
document = pulled["document"]
document["nodes"].append(
    {
        "id": "access_stats",
        "kind": "package",
        "package": "svc-probe",
        "node": "access_stats",
        "display_name": "统计访问日志",
        "inputs": {"source": "sut-01", "path": "/var/log/demo-svc/access-2026-11-19.log"},
    }
)
document["edges"].append({"from": "inspect_items", "to": "access_stats", "kind": "chain"})
path.write_text(json.dumps(pulled, ensure_ascii=False, indent=2))
