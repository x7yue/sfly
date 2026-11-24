//! 假控制面的端口：关掉的假控制面用过的端口，不再随机发给同一个测试进程里别的假控制面（#718）。
//!
//! 下线又恢复的用例（`drop(cp)`，等一会儿，`FakeControlPlane::start_on(port)`）里，Agent 在下线期间每隔一阵重连。
//! 并行的别的用例这时起假控制面，系统若把这个刚空出来的端口给了它，Agent 就连上了别人的假控制面。
//! 随机端口系统不会按需再给一次，所以挑端口的逻辑用一个事先排好的端口序列来测。

mod support;

use std::collections::HashSet;
use std::io;

use support::{FakeControlPlane, pick_unused_port, port_was_used_by_a_fake_control_plane};

/// 按给定顺序一个个返回端口的 `bind`，记下被调用了几次。
fn scripted(
    ports: &[u16],
) -> (
    impl FnMut() -> io::Result<(u16, ())>,
    std::rc::Rc<std::cell::Cell<usize>>,
) {
    let calls = std::rc::Rc::new(std::cell::Cell::new(0));
    let seen = calls.clone();
    let ports = ports.to_vec();
    (
        move || {
            let n = calls.get();
            calls.set(n + 1);
            Ok((ports[n], ()))
        },
        seen,
    )
}

#[test]
fn a_port_that_a_fake_control_plane_used_is_skipped_and_the_next_free_one_is_taken() {
    // 系统先把刚空出来的 10 000 又给了一次，再给 10 001。
    let mut used = HashSet::from([10_000]);
    let (bind, calls) = scripted(&[10_000, 10_000, 10_001]);
    let (port, ()) = pick_unused_port(&mut used, bind).unwrap();
    assert_eq!(port, 10_001);
    assert_eq!(calls.get(), 3, "撞上用过的端口就放掉重绑");
    assert!(used.contains(&10_000) && used.contains(&10_001));
}

#[test]
fn a_port_that_is_picked_is_recorded_so_the_next_pick_skips_it() {
    let mut used = HashSet::new();
    let (bind, _) = scripted(&[7, 7]);
    let (first, ()) = pick_unused_port(&mut used, bind).unwrap();
    assert_eq!(first, 7);
    let (bind, calls) = scripted(&[7, 8]);
    let (second, ()) = pick_unused_port(&mut used, bind).unwrap();
    assert_eq!((second, calls.get()), (8, 2));
}

#[test]
fn a_bind_that_never_gives_a_fresh_port_is_an_error_not_an_endless_loop() {
    let mut used = HashSet::from([5]);
    let result = pick_unused_port(&mut used, || Ok((5, ())));
    assert!(result.is_err());
}

#[test]
fn a_bind_error_is_passed_on() {
    let mut used = HashSet::new();
    let result: io::Result<(u16, ())> = pick_unused_port(&mut used, || {
        Err(io::Error::new(io::ErrorKind::PermissionDenied, "no"))
    });
    assert_eq!(result.unwrap_err().kind(), io::ErrorKind::PermissionDenied);
}

/// 真的假控制面起来时就把端口记进去了（`start`、`start_on` 都是），关掉之后仍然记着：
/// 挑端口的逻辑接在这上面，别的假控制面起来时才会避开它。
#[tokio::test]
async fn a_fake_control_plane_keeps_its_port_registered_after_it_is_gone() {
    let cp = FakeControlPlane::start().await;
    let port = cp.port;
    assert!(port_was_used_by_a_fake_control_plane(port));
    drop(cp);
    assert!(
        port_was_used_by_a_fake_control_plane(port),
        "关掉之后还记着"
    );
    // 在同一个端口上再起（下线又恢复）照常可以。
    let again = FakeControlPlane::start_on(port).await;
    assert_eq!(again.port, port);
    assert!(port_was_used_by_a_fake_control_plane(port));
}

/// 显式指定的端口（不是 `start` 给的）起来之后也记进去：之后别的假控制面随机挑端口时同样避开它。
#[tokio::test]
async fn a_fake_control_plane_started_on_a_given_port_registers_it_too() {
    let port = {
        let spare = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        spare.local_addr().unwrap().port()
    };
    assert!(!port_was_used_by_a_fake_control_plane(port));
    let cp = FakeControlPlane::start_on(port).await;
    assert!(port_was_used_by_a_fake_control_plane(port));
    drop(cp);
}
