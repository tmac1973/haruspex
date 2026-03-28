// llama-server sidecar lifecycle management
// Implementation: Phase 2

use serde::Serialize;

#[derive(Clone, Serialize)]
pub enum ServerStatus {
    Stopped,
    Starting,
    Ready,
    Error(String),
}

pub struct LlamaServer {
    _status: ServerStatus,
}

impl LlamaServer {
    pub fn new() -> Self {
        Self {
            _status: ServerStatus::Stopped,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_server_is_stopped() {
        let server = LlamaServer::new();
        assert!(matches!(server._status, ServerStatus::Stopped));
    }
}
