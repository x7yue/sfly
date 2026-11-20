在场景「demo 巡检」的「检查商品列表」后面加一步：用 svc-probe 里的 scan_remote_log 节点，统计被测机 sut-01 上 /var/log/demo-svc/app.log 里 ERROR 的行数。这一步放在 Agent dev-root-dev 上执行（被测机上只跑探测，不跑分析），日志从 sut-01 上读。

场景里原来的说明和注释框保持原样，新加的这一步也写好说明。改完跑一次，要跑通。
