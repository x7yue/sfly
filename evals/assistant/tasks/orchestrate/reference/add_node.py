"""题目「编排」的参考答案：在 pull 下来的场景文件里加上「统计服务报错」这一步。"""

import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
pulled = json.loads(path.read_text())
document = pulled["document"]
document["nodes"].append(
    {
        "id": "scan_errors",
        "kind": "package",
        "package": "svc-probe",
        "node": "scan_remote_log",
        "display_name": "统计服务报错",
        "note": "放在 dev-root-dev 上执行：被测机上只跑探测，分析放在别的机器上，"
        "经 Agent 能力读 sut-01 的日志。",
        "agent": "dev-root-dev",
        "inputs": {"source": "sut-01", "path": "/var/log/demo-svc/app.log", "pattern": "ERROR"},
    }
)
document["edges"].append({"from": "inspect_items", "to": "scan_errors", "kind": "chain"})
path.write_text(json.dumps(pulled, ensure_ascii=False, indent=2))
