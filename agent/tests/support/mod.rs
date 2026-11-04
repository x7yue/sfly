//! 测试支撑：可编程的假控制面（真实 tonic gRPC 服务端，监听随机端口）。

use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use sfly_agent::proto::agent_gateway_server::{AgentGateway, AgentGatewayServer};
use sfly_agent::proto::{AgentMessage, ServerMessage, Welcome, agent_message, server_message};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, oneshot};
use tokio_stream::wrappers::{ReceiverStream, TcpListenerStream};
use tokio_stream::{Stream, StreamExt};
use tonic::{Request, Response, Status, Streaming};

/// 假控制面：记录收到的全部 AgentMessage，对 Hello 回复 Welcome。
pub struct FakeControlPlane {
    pub url: String,
    received: Arc<Mutex<Vec<AgentMessage>>>,
    shutdown: Option<oneshot::Sender<()>>,
}

impl FakeControlPlane {
    pub async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr: SocketAddr = listener.local_addr().unwrap();
        let received = Arc::new(Mutex::new(Vec::new()));
        let service = Gateway {
            received: received.clone(),
        };
        let (tx, rx) = oneshot::channel::<()>();
        tokio::spawn(async move {
            tonic::transport::Server::builder()
                .add_service(AgentGatewayServer::new(service))
                .serve_with_incoming_shutdown(TcpListenerStream::new(listener), async {
                    let _ = rx.await;
                })
                .await
                .unwrap();
        });
        Self {
            url: format!("http://{addr}"),
            received,
            shutdown: Some(tx),
        }
    }

    pub fn received(&self) -> Vec<AgentMessage> {
        self.received.lock().unwrap().clone()
    }
}

impl Drop for FakeControlPlane {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
    }
}

struct Gateway {
    received: Arc<Mutex<Vec<AgentMessage>>>,
}

type ServerStream = Pin<Box<dyn Stream<Item = Result<ServerMessage, Status>> + Send>>;

#[tonic::async_trait]
impl AgentGateway for Gateway {
    type SessionStream = ServerStream;

    async fn session(
        &self,
        request: Request<Streaming<AgentMessage>>,
    ) -> Result<Response<Self::SessionStream>, Status> {
        let mut inbound = request.into_inner();
        let received = self.received.clone();
        let (tx, rx) = mpsc::channel(16);
        tokio::spawn(async move {
            while let Some(Ok(message)) = inbound.next().await {
                let is_hello = matches!(message.body, Some(agent_message::Body::Hello(_)));
                received.lock().unwrap().push(message);
                if is_hello {
                    let welcome = ServerMessage {
                        body: Some(server_message::Body::Welcome(Welcome {})),
                    };
                    if tx.send(Ok(welcome)).await.is_err() {
                        break;
                    }
                }
            }
        });
        Ok(Response::new(Box::pin(ReceiverStream::new(rx))))
    }
}
