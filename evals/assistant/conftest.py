# tasks/ 下是题目里的节点包源码和看不到的断言，属于各自的节点包：判分时在那个包的 venv 里跑，
# 不在仓库的 pytest 里收集。`uv run --locked pytest evals/assistant` 只跑 tests/ 下判分自己的测试。
collect_ignore_glob = ["tasks/*"]
