"""后台线程的 `Cancelled` 交给主线程重新抛出时，随后送达的 SIGTERM 不再抛第二次（#678）。

取消时 Agent 先写取消标记、再发 SIGTERM。节点在后台线程里等东西（例如 `sfly_std` 的监听），线程里的
调用先收到 `cancelled`，把 `Cancelled` 放进队列、由主线程重新抛出：这条路不经过
`sfly.context.cancelled_error`，「主线程里已经抛出过」没有记上，随后送达的 SIGTERM 不能在主线程
清理到一半时再抛一次。
"""

from __future__ import annotations

import queue
import signal
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

import sfly
from sfly.context import DeferCancel, _Sigterm, cancelled_error, on_sigterm


def _cancelled_from_a_background_thread() -> sfly.Cancelled:
    """后台线程里（不是主线程）构造出来的 `Cancelled`：这时主线程还不知道任务在取消。"""
    box: list[sfly.Cancelled] = []
    thread = threading.Thread(
        target=lambda: box.append(cancelled_error("任务正在收尾，调用已放弃"))
    )
    thread.start()
    thread.join(10)
    assert len(box) == 1
    return box[0]


def test_a_sigterm_during_the_cleanup_of_a_relayed_cancelled_does_not_interrupt_it() -> None:
    relay: queue.Queue[BaseException] = queue.Queue()
    relay.put(_cancelled_from_a_background_thread())
    assert _Sigterm.raised is False
    cleaned = False

    with pytest.raises(sfly.Cancelled, match="调用已放弃"):
        try:
            raise relay.get()
        except sfly.Cancelled:
            on_sigterm(signal.SIGTERM, None)  # 清理到一半，SIGTERM 送达
            cleaned = True
            raise

    assert cleaned


def test_the_same_in_a_finally_that_runs_because_of_the_relayed_cancelled() -> None:
    cleaned = False

    with pytest.raises(sfly.Cancelled):
        try:
            raise _cancelled_from_a_background_thread()
        finally:
            on_sigterm(signal.SIGTERM, None)
            cleaned = True

    assert cleaned


def test_a_cancelled_that_comes_back_through_a_future_is_handled_the_same_way() -> None:
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(lambda: (_ for _ in ()).throw(cancelled_error("后台")))
        cleaned = False
        with pytest.raises(sfly.Cancelled):
            try:
                future.result(10)
            except sfly.Cancelled:
                on_sigterm(signal.SIGTERM, None)
                cleaned = True
                raise
    assert cleaned


def test_a_sigterm_held_back_by_defer_cancel_is_dropped_while_a_cancelled_is_handled() -> None:
    cleaned = False

    with pytest.raises(sfly.Cancelled):
        try:
            raise _cancelled_from_a_background_thread()
        except sfly.Cancelled:
            with DeferCancel():
                on_sigterm(signal.SIGTERM, None)  # 推迟到离开这一段
            cleaned = True  # 离开 DeferCancel 时不再抛
            raise

    assert cleaned


def test_a_sigterm_in_a_nested_except_of_the_cleanup_of_a_relayed_cancelled_is_dropped() -> None:
    """清理里逐个停东西、每个外面包一层 `except Exception: 记一句`：执行到里面那个块时，最里面正在
    处理的是停东西时出的错，不是 `Cancelled`；它是在处理 `Cancelled` 的过程中抛出的，链上有它。"""
    relay: queue.Queue[BaseException] = queue.Queue()
    relay.put(_cancelled_from_a_background_thread())
    logged: list[str] = []
    stopped: list[str] = []

    with pytest.raises(sfly.Cancelled, match="调用已放弃"):
        try:
            raise relay.get()
        except sfly.Cancelled:
            for name in ("a", "b"):
                try:
                    raise OSError(f"停不下来 {name}")
                except Exception as error:
                    on_sigterm(signal.SIGTERM, None)  # 里面这个块在执行时 SIGTERM 送达
                    logged.append(str(error))
                stopped.append(name)
            raise

    assert logged == ["停不下来 a", "停不下来 b"]
    assert stopped == ["a", "b"]


def test_the_same_when_the_nested_except_is_in_a_finally_and_in_a_called_function() -> None:
    def stop_it() -> None:
        try:
            raise ConnectionError("对端已经关了")
        except OSError:
            on_sigterm(signal.SIGTERM, None)

    cleaned = False
    with pytest.raises(sfly.Cancelled):
        try:
            raise _cancelled_from_a_background_thread()
        finally:
            stop_it()
            cleaned = True

    assert cleaned


def test_the_cancelled_may_be_several_exceptions_further_out_in_the_chain() -> None:
    cleaned = False
    with pytest.raises(sfly.Cancelled):
        try:
            raise _cancelled_from_a_background_thread()
        except sfly.Cancelled:
            try:
                raise OSError("第一层")
            except OSError:
                try:
                    raise ValueError("第二层")
                except ValueError:
                    on_sigterm(signal.SIGTERM, None)
                    cleaned = True
            raise

    assert cleaned


def test_a_sigterm_in_the_defer_cancel_of_a_nested_except_is_dropped_too() -> None:
    cleaned = False
    with pytest.raises(sfly.Cancelled):
        try:
            raise _cancelled_from_a_background_thread()
        except sfly.Cancelled:
            try:
                raise OSError("停不下来")
            except OSError:
                with DeferCancel():
                    on_sigterm(signal.SIGTERM, None)
                cleaned = True  # 离开 DeferCancel 时不再抛
            raise

    assert cleaned


def test_a_sigterm_raises_when_the_chain_of_what_is_handled_has_no_cancelled() -> None:
    """对照：节点自己的错里套着别的错（链上没有 `Cancelled`），SIGTERM 照常抛。"""
    with pytest.raises(sfly.Cancelled, match="SIGTERM"):
        try:
            raise KeyError("原来的错")
        except KeyError:
            try:
                raise ValueError("清理里又出的错")
            except ValueError:
                on_sigterm(signal.SIGTERM, None)


def test_a_cancelled_that_was_already_handled_and_left_behind_is_not_in_the_chain() -> None:
    """对照：之前处理过一个 `Cancelled`、已经处理完离开了；后来的错和它无关，SIGTERM 照常抛。"""
    try:
        raise _cancelled_from_a_background_thread()
    except sfly.Cancelled:
        pass

    with pytest.raises(sfly.Cancelled, match="SIGTERM"):
        try:
            raise ValueError("后来的错")
        except ValueError:
            on_sigterm(signal.SIGTERM, None)


def test_a_chain_that_loops_back_on_itself_ends_the_search() -> None:
    """别的库手工接出来的 `__context__` 可能成环：找下去不能不停（SIGTERM 的处理函数里卡住，任务
    就收不了尾）。"""
    first, second = ValueError("一"), KeyError("二")
    first.__context__ = second
    second.__context__ = first

    with pytest.raises(sfly.Cancelled, match="SIGTERM"):
        try:
            raise first
        except ValueError:
            on_sigterm(signal.SIGTERM, None)


def test_a_sigterm_still_raises_when_what_is_being_handled_is_not_a_cancelled() -> None:
    """正在处理的是别的异常（节点自己出错了在清理）：SIGTERM 照常抛出，这一条不改。"""
    with pytest.raises(sfly.Cancelled, match="SIGTERM"):
        try:
            raise ValueError("节点自己的错")
        except ValueError:
            on_sigterm(signal.SIGTERM, None)


def test_a_sigterm_with_nothing_being_handled_raises_once_as_before() -> None:
    with pytest.raises(sfly.Cancelled, match="SIGTERM"):
        on_sigterm(signal.SIGTERM, None)
    on_sigterm(signal.SIGTERM, None)  # 主线程已经收到过：不再抛
