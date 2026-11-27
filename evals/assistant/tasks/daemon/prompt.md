svc-stock 里的 `stock_check` 节点向库存服务查一个商品的库存。包里带了库存服务的本地替身：`uv run python -m svc_stock.stub_service --port 8765`，起来之后一直运行，直到被结束。

帮我做两件事：
1. 把替身起起来，用 `sfly debug` 让 `stock_check` 对着它（`base_url` 是 `http://127.0.0.1:8765`）分别查 A-100 和 B-200，告诉我两个商品各有多少库存。
2. 写一个集成测试 `tests/test_stock_integration.py`：测试自己起替身（子进程），等它能连上，对它跑 `stock_check`，最后关掉替身；不依赖外面已经起着的服务。

不要改节点、替身和已有的单测。
