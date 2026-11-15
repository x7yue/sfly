"""动作与标记测试用的节点（`test_actions.py` 通过 `sfly.testing.run_node` 执行）。"""

from __future__ import annotations

import asyncio
import threading
import time
from typing import Any

from sfly import Context, node


@node(outputs=[])
def outcomes(ctx: Context) -> None:
    """成功、`fail()`、抛异常、`start` 后 `end()` 或 `fail()` 各一个。"""
    with ctx.action("成功", 订单="1001"):
        pass
    with ctx.action("业务失败") as a:
        a.fail("拒单：余额不足")
        ctx.log.info("fail 之后动作还在进行")
    try:
        with ctx.action("抛异常"):
            raise ValueError("价格不能为负")
    except ValueError:
        ctx.log.info("异常照常往外抛")
    try:
        with ctx.action("无消息的异常"):
            raise KeyError
    except KeyError:
        pass
    ctx.action.start("手动成功").end()
    ctx.action.start("手动失败").fail("网关超时")


@node(outputs=[])
def wait_in_action(ctx: Context) -> None:
    """在一个动作里等着，直到被取消。"""
    with ctx.action("等待回报"):
        time.sleep(60)


@node(outputs=[])
def fail_then_wait(ctx: Context) -> None:
    """已经 `fail()` 的动作之后被取消，仍然是失败。"""
    with ctx.action("先失败再取消") as a:
        a.fail("已经拒单")
        time.sleep(60)


@node(outputs=[])
def nesting(ctx: Context) -> None:
    """同线程嵌套、`start()` 不自动成为父动作、`parent=`、标记属于最内层的动作。"""
    with ctx.action("外层"):
        with ctx.action("中层"):
            with ctx.action("内层") as inner:
                ctx.mark("深处的标记")
            handle = ctx.action.start("手动开始")
            with ctx.action("中层的另一个孩子"):
                pass
            ctx.action.start("挂在句柄下", parent=handle).end()
            ctx.mark("挂在内层下", parent=inner)
            handle.end()
        ctx.mark("外层的标记")
    with ctx.action("第二个最外层"):
        pass


@node(outputs=[])
def concurrency(ctx: Context) -> None:
    """asyncio 任务里自动嵌套、互不串；新线程从最外层开始，`parent=` 可以挂回去。"""

    async def order(n: int) -> None:
        with ctx.action("下单", 编号=n):
            await asyncio.sleep(0.01)
            with ctx.action("风控", 编号=n):
                await asyncio.sleep(0.01)

    async def main() -> None:
        with ctx.action("并发下单"):
            await asyncio.gather(order(1), order(2))

    asyncio.run(main())

    def worker(parent: Any) -> None:
        with ctx.action("线程里没有指定父动作"):
            pass
        with ctx.action("线程里") as a:
            a.note(线程="t")
        ctx.action.start("线程里指定了父动作", parent=parent).end()

    with ctx.action("保持") as hold:
        thread = threading.Thread(target=worker, args=(hold,))
        thread.start()
        thread.join()


@node(outputs=[])
def annotate(ctx: Context) -> None:
    """`note` 补充字段、与开始时的字段合计不超过 8 个、同名覆盖。"""
    with ctx.action("下单", 订单="1001", 价格="9.9") as a:
        a.note(回报="已成交")
        a.note(价格="10.5")
    handle = ctx.action.start("手动", 甲="1")
    handle.note(乙="2")
    handle.end()
    ctx.mark("标记", 数量=3, 比例=0.5, 备注=None)


@node(outputs=[])
def invalid_name(ctx: Context, how: str, name: Any) -> None:
    """用不合法的名称调用，错误在调用时立即抛出。"""
    ctx.log.info("调用之前")
    if how == "action":
        ctx.action(name)
    elif how == "start":
        ctx.action.start(name)
    else:
        ctx.mark(name)
    ctx.log.info("不会走到这里")


@node(outputs=[])
def invalid_parent(ctx: Context) -> None:
    ctx.mark("标记", parent="不是动作")  # type: ignore[arg-type]


@node(outputs=[])
def truncation(ctx: Context) -> None:
    """名称、字段个数、字段值超过限制时截断，每种原因只警告一次。"""
    long_name = "名" * 70
    many = {f"字段{i}": i for i in range(10)}
    for _ in range(2):
        with ctx.action(long_name, 内容="长" * 300, **many):
            pass
    ctx.mark("长" * 65, 长值="值" * 257)


@node(outputs=[])
def ended_twice(ctx: Context) -> None:
    """同一个句柄结束两次，第二次忽略并警告一次。"""
    handle = ctx.action.start("重复结束")
    handle.end()
    handle.end()
    handle.fail("也被忽略")
    handle.note(晚了="是")
    with ctx.action("with 里的动作") as a:
        pass
    a.fail("with 结束以后")


@node(outputs=[])
def many_names(ctx: Context, count: int) -> None:
    for i in range(count):
        ctx.mark(f"订单{i}")


@node(outputs=[])
def summary_while_running(ctx: Context) -> None:
    """先做几个短的动作，再停在一个长的动作里（被取消时结束）：摘要里有正在做的、最近的和失败的。"""
    for i in range(3):
        with ctx.action("下单", 订单=i):
            pass
    with ctx.action("下单", 订单=3) as failed:
        failed.fail("拒单")
    with ctx.action("保持", 时长="4h") as hold:
        ctx.mark("进入保持")
        handle = ctx.action.start("等回报", parent=hold, 订单=4)
        hold.note(阶段="加压")
        time.sleep(60)
        handle.end()


@node(outputs=[])
def leave_unfinished(ctx: Context) -> None:
    """没有结束的动作：节点返回时还没结束。"""
    ctx.action.start("从不结束", 订单="1001")
    with ctx.action("正常结束"):
        pass
