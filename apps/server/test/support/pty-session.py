"""在一个有控制终端的会话里运行命令（`pty.fork`）：子进程能打开 `/dev/tty`，它的 stdin、stdout、stderr 都是终端；
把终端上的输出原样写到我们自己的 stdout，退出码照搬。测试用：`install.sh` 在 `curl | sh` 时 stdin 是脚本，
有没有终端要看 `/dev/tty`（没有终端时直接失败、有终端时让人登录），要在真的终端会话里跑一遍。

用法：python3 pty-session.py <命令> [参数…]
"""

from __future__ import annotations

import os
import pty
import sys

pid, master = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
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
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
