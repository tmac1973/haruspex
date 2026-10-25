//! llama-toolchest as an image server (and, next, a music server).
//!
//! Toolchest runs stable-diffusion.cpp and ACE-Step instances behind its own
//! port and queue, and speaks OpenAI images (`/v1/images/generations`) plus
//! its own job API (`/v1/images/jobs`, `/v1/music/jobs`). Calls go through
//! `comfy.rs`'s client like ComfyUI's and Lemonade's: no `Origin`, no proxy
//! (a LAN server), one cancel table and one log.
//!
//! The key is not ours to keep. Toolchest's key is usually the one the user
//! already saved for it as an inference server, in the named-key store
//! (Settings → Inference → API Keys), so the webview resolves it and sends it
//! inline; `secret` is empty, and the store is never asked.

use tauri::ipc::Response;

use crate::comfy::{ComfyCall, ComfyError, ImageServer};

pub(crate) const TOOLCHEST: ImageServer = ImageServer {
    secret: "",
    name: "llama-toolchest",
};

/// A call whose answer is JSON (or text, or nothing). Cancelled with
/// `comfy_cancel`, whose table these calls share.
#[tauri::command]
pub async fn toolchest_json(call: ComfyCall) -> Result<serde_json::Value, ComfyError> {
    crate::comfy::json_from(call, TOOLCHEST).await
}

/// A call whose answer is bytes: a finished job's image.
#[tauri::command]
pub async fn toolchest_bytes(call: ComfyCall) -> Result<Response, ComfyError> {
    crate::comfy::bytes_from(call, TOOLCHEST).await
}

/// A music job with songs: `POST /v1/music/jobs` as multipart, the body in
/// a `request` part and each song in its own (`audio`, `ref_audio`).
#[tauri::command]
pub async fn toolchest_upload(
    app: tauri::AppHandle,
    db: tauri::State<'_, crate::db::Database>,
    call: ComfyCall,
    files: Vec<crate::comfy::UploadFile>,
) -> Result<serde_json::Value, ComfyError> {
    let dir =
        crate::audio_cache::cache_dir(&app).map_err(|message| ComfyError::Invalid { message })?;
    let parts = crate::comfy::resolve_uploads(&db, &dir, files)?;
    crate::comfy::upload_json(call, TOOLCHEST, parts).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderMap;
    use axum::routing::{delete, get};

    /// `/v1/models` answers only with `Bearer k`; `DELETE /v1/images/jobs/x`
    /// answers 204.
    async fn serve() -> String {
        let app = axum::Router::new()
            .route(
                "/v1/models",
                get(|headers: HeaderMap| async move {
                    match headers.get("authorization").and_then(|v| v.to_str().ok()) {
                        Some("Bearer k") => Ok(axum::Json(serde_json::json!({ "data": [] }))),
                        _ => Err(axum::http::StatusCode::UNAUTHORIZED),
                    }
                }),
            )
            .route(
                "/v1/images/jobs/x",
                delete(|| async { axum::http::StatusCode::NO_CONTENT }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}")
    }

    fn call(base: &str, method: &str, path: &str, key: &str) -> ComfyCall {
        ComfyCall {
            base_url: base.into(),
            api_key: key.into(),
            method: method.into(),
            path: path.into(),
            body: None,
            timeout_ms: 5000,
            id: None,
        }
    }

    #[tokio::test]
    async fn the_inline_key_is_sent_and_no_store_is_asked() {
        let base = serve().await;
        let ok = toolchest_json(call(&base, "GET", "/v1/models", "k")).await;
        assert_eq!(ok.unwrap()["data"], serde_json::json!([]));
        // With no key there is nothing to fall back to: the server refuses.
        let refused = toolchest_json(call(&base, "GET", "/v1/models", "")).await;
        assert!(matches!(
            refused,
            Err(ComfyError::Rejected { status: 401, .. })
        ));
    }

    /// The body goes in a `request` part and each file in a part of its own.
    #[tokio::test]
    async fn an_upload_is_multipart_with_the_request_and_its_files() {
        let app = axum::Router::new().route(
            "/v1/music/jobs",
            axum::routing::post(|headers: HeaderMap, body: String| async move {
                let ctype = headers["content-type"].to_str().unwrap().to_string();
                axum::Json(serde_json::json!({ "type": ctype, "body": body }))
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let mut c = call(&format!("http://{addr}"), "POST", "/v1/music/jobs", "");
        c.body = Some(serde_json::json!({ "task_type": "cover" }));
        let files = vec![crate::comfy::FilePart {
            field: "audio".into(),
            filename: "song.mp3".into(),
            bytes: b"MP3".to_vec(),
        }];
        let out = crate::comfy::upload_json(c, TOOLCHEST, files)
            .await
            .unwrap();
        assert!(out["type"]
            .as_str()
            .unwrap()
            .starts_with("multipart/form-data"));
        let body = out["body"].as_str().unwrap();
        for want in [
            "name=\"request\"\r\n\r\n{\"task_type\":\"cover\"}",
            "name=\"audio\"; filename=\"song.mp3\"",
            "\r\n\r\nMP3\r\n",
        ] {
            assert!(body.contains(want), "{want:?} missing from {body:?}");
        }
    }

    #[tokio::test]
    async fn a_job_can_be_cancelled_with_delete() {
        let base = serve().await;
        let out = toolchest_json(call(&base, "DELETE", "/v1/images/jobs/x", "")).await;
        assert_eq!(out.unwrap(), serde_json::Value::Null);
    }
}
