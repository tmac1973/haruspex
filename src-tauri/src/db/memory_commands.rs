//! IPC surface for agentic memory.
//!
//! Kept apart from `commands.rs` (already ~400 lines of conversation, job and
//! run wrappers) because these differ in one important way: they embed as
//! well as query. Embedding is ONNX inference — CPU-bound, hundreds of
//! milliseconds on a cold session — so every command here runs inside
//! `spawn_blocking`, never on the main thread. The arboard freeze is the
//! precedent: blocking the main thread wedges WebKitGTK.
//!
//! The frontend never sees or supplies a vector. It sends text; Rust owns
//! embed, store and search.

use super::commands::on_pool;
use super::*;
use crate::memory::embedder;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Where this install caches the ONNX weights.
fn model_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?;
    Ok(embedder::cache_dir(&data_dir))
}

/// Run memory work off the main thread, with the model cache dir resolved.
async fn on_pool_with_model<T, F>(app: &AppHandle, db: Database, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(Database, PathBuf) -> Result<T, String> + Send + 'static,
{
    let dir = model_cache_dir(app)?;
    tauri::async_runtime::spawn_blocking(move || f(db, dir))
        .await
        .map_err(|e| format!("memory task panicked: {e}"))?
}

fn now_ms() -> i64 {
    chrono_now()
}

/// Whether the embedding model is on disk. Pure file check — the Settings UI
/// calls it on render, so it must not initialize ONNX or touch the network.
#[tauri::command]
pub async fn memory_model_present(app: AppHandle) -> Result<bool, String> {
    let dir = model_cache_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || embedder::model_present(&dir))
        .await
        .map_err(|e| format!("memory task panicked: {e}"))
}

/// Download the embedding model. Only the consent flow calls this.
#[tauri::command]
pub async fn memory_download_model(app: AppHandle) -> Result<(), String> {
    let dir = model_cache_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || embedder::ensure_model(&dir))
        .await
        .map_err(|e| format!("memory task panicked: {e}"))?
}

/// Release the loaded ONNX session. Called when memory is switched off — an
/// idle session is tens of MB resident for nothing.
#[tauri::command]
pub async fn memory_unload_model() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(embedder::unload)
        .await
        .map_err(|e| format!("memory task panicked: {e}"))
}

/// Embed and store one fact. Returns the new memory's id.
#[tauri::command]
pub async fn memory_add(
    app: AppHandle,
    state: tauri::State<'_, Database>,
    content: String,
    category: String,
    source_conversation_id: Option<String>,
    origin: Option<String>,
) -> Result<String, String> {
    let db = state.inner().clone();
    // Anything but the one known alternative records as "extracted": the
    // background pass is the default writer, and an unrecognised value must not
    // let a row claim the user asked for it.
    let origin = match origin.as_deref() {
        Some("explicit") => "explicit",
        _ => "extracted",
    };
    on_pool_with_model(&app, db, move |db, dir| {
        let vector = embed_one(&dir, &content)?;
        db.insert_memory(
            &content,
            &category,
            &vector,
            embedder::EMBEDDING_MODEL_NAME,
            source_conversation_id.as_deref(),
            origin,
            now_ms(),
        )
    })
    .await
}

/// Embed `query` and return the top-k most relevant memories.
///
/// One IPC round trip for embed + scan + rerank: splitting it would mean
/// shipping a 384-float vector to the frontend and back for no purpose.
#[tauri::command]
pub async fn memory_search(
    app: AppHandle,
    state: tauri::State<'_, Database>,
    query: String,
    k: usize,
    min_similarity: f32,
) -> Result<Vec<MemoryHit>, String> {
    let db = state.inner().clone();
    on_pool_with_model(&app, db, move |db, dir| {
        let vector = embed_one(&dir, &query)?;
        db.search_memories(
            &vector,
            embedder::EMBEDDING_MODEL_NAME,
            k,
            min_similarity,
            now_ms(),
        )
    })
    .await
}

/// The closest stored memory to `content`, if any is at least `threshold`
/// similar. The dedupe check extraction runs per candidate fact.
#[tauri::command]
pub async fn memory_find_similar(
    app: AppHandle,
    state: tauri::State<'_, Database>,
    content: String,
    threshold: f32,
) -> Result<Option<MemoryHit>, String> {
    let db = state.inner().clone();
    on_pool_with_model(&app, db, move |db, dir| {
        let vector = embed_one(&dir, &content)?;
        db.find_similar(&vector, embedder::EMBEDDING_MODEL_NAME, threshold, now_ms())
    })
    .await
}

/// Record that a memory was seen again — bumps recency and use count.
#[tauri::command]
pub async fn memory_touch(state: tauri::State<'_, Database>, id: String) -> Result<(), String> {
    let db = state.inner().clone();
    on_pool(db, move |db| db.touch_memory(&id, chrono_now())).await
}

#[tauri::command]
pub async fn memory_list(
    state: tauri::State<'_, Database>,
    offset: i64,
    limit: i64,
    filter: Option<String>,
) -> Result<Vec<MemoryMeta>, String> {
    let db = state.inner().clone();
    on_pool(db, move |db| {
        db.list_memories(offset, limit, filter.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn memory_count(state: tauri::State<'_, Database>) -> Result<i64, String> {
    let db = state.inner().clone();
    on_pool(db, move |db| db.count_memories()).await
}

/// Edit a memory's text. Re-embeds, because the vector is the other half of
/// the same fact — leaving it stale would recall the row for the old wording
/// and then show the new one.
#[tauri::command]
pub async fn memory_update(
    app: AppHandle,
    state: tauri::State<'_, Database>,
    id: String,
    content: String,
) -> Result<bool, String> {
    let db = state.inner().clone();
    on_pool_with_model(&app, db, move |db, dir| {
        let vector = embed_one(&dir, &content)?;
        db.update_memory_content(&id, &content, &vector, embedder::EMBEDDING_MODEL_NAME)
    })
    .await
}

#[tauri::command]
pub async fn memory_delete(state: tauri::State<'_, Database>, id: String) -> Result<bool, String> {
    let db = state.inner().clone();
    on_pool(db, move |db| db.delete_memory(&id)).await
}

#[tauri::command]
pub async fn memory_delete_all(state: tauri::State<'_, Database>) -> Result<i64, String> {
    let db = state.inner().clone();
    on_pool(db, move |db| db.delete_all_memories()).await
}

#[tauri::command]
pub async fn conversation_memory_cursor(
    state: tauri::State<'_, Database>,
    conversation_id: String,
) -> Result<MemoryCursor, String> {
    let db = state.inner().clone();
    on_pool(db, move |db| db.get_memory_cursor(&conversation_id)).await
}

#[tauri::command]
pub async fn conversation_set_memory_enabled(
    state: tauri::State<'_, Database>,
    conversation_id: String,
    enabled: bool,
) -> Result<(), String> {
    let db = state.inner().clone();
    on_pool(db, move |db| {
        db.set_memory_enabled(&conversation_id, enabled)
    })
    .await
}

#[tauri::command]
pub async fn conversation_set_memory_extracted_to(
    state: tauri::State<'_, Database>,
    conversation_id: String,
    sort_order: i64,
) -> Result<(), String> {
    let db = state.inner().clone();
    on_pool(db, move |db| {
        db.set_memory_extracted_to(&conversation_id, sort_order)
    })
    .await
}

/// Embed a single string, failing loudly on the empty-batch case.
///
/// fastembed returns a vector per input; an empty result here would mean the
/// model silently produced nothing, and storing a zero-length embedding would
/// make the row permanently unmatchable rather than merely wrong.
fn embed_one(cache_dir: &std::path::Path, text: &str) -> Result<Vec<f32>, String> {
    let mut vectors = embedder::embed(cache_dir, &[text.to_string()])?;
    if vectors.is_empty() {
        return Err("The embedding model returned no vector.".to_string());
    }
    Ok(vectors.remove(0))
}
