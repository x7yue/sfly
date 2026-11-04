mod support;

use sfly_agent::proto::agent_message;
use sfly_agent::{Config, connect};
use support::FakeControlPlane;

#[tokio::test]
async fn agent_sends_hello_and_receives_welcome() {
    let control_plane = FakeControlPlane::start().await;

    let config = Config {
        token: Some("secret".into()),
        ..Config::new(control_plane.url.clone(), "agent-a")
    };
    let connection = connect(&config, Vec::new(), Vec::new(), Vec::new())
        .await
        .expect("handshake");
    drop(connection);

    let received = control_plane.received();
    let Some(agent_message::Body::Hello(hello)) = received.first().and_then(|m| m.body.clone())
    else {
        panic!("first message should be Hello, got {received:?}");
    };
    assert_eq!(hello.name, "agent-a");
    assert_eq!(hello.token, "secret");
    assert_eq!(hello.agent_version, env!("CARGO_PKG_VERSION"));
}

#[tokio::test]
async fn connect_fails_when_control_plane_is_unreachable() {
    let config = Config::new("http://127.0.0.1:1", "agent-b");
    assert!(
        connect(&config, Vec::new(), Vec::new(), Vec::new())
            .await
            .is_err()
    );
}
