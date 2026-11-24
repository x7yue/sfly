"""在一个伪终端里运行命令，让它的 stdout 是终端（`isatty()` 为真）：把它写到终端上的字节原样写到我们自己的
stdout，stderr 继承，退出码照搬。测试用：`sfly` 在终端上和在管道里的输出不一样（#670），要用真的命令行在终端上看一遍。

用法：python3 pty-run.py <命令> [参数…]
"""

from __future__ import annotations

import os
import pty
import subprocess
import sys

master, slave = pty.openpty()
process = subprocess.Popen(
    sys.argv[1:], stdin=subprocess.DEVNULL, stdout=slave, stderr=None, close_fds=True
)
os.close(slave)
out = sys.stdout.buffer
while True:
    try:
        chunk = os.read(master, 65536)
    except OSError:  # 子进程退出之后，Linux 上从 master 读会报 EIO
        break
    if not chunk:
        break
    out.write(chunk)
out.flush()
sys.exit(process.wait())
