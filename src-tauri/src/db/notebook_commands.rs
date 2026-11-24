//! Tauri commands for notebooks. Each runs its database work off the main
//! thread (`on_pool`). A stale `expected_version` fails with `"conflict"`.

use super::commands::on_pool;
use super::notebook_revisions::{CardHistoryEntry, CardSnapshot};
use super::notebook_rows::RowOp;
use super::notebook_search::NotebookSearchHit;
use super::notebooks::{
    NewCard, NotebookCard, NotebookDetail, NotebookRow, NotebookSummary, NotebookTrash,
};
use super::*;

type Db<'a> = tauri::State<'a, Database>;

#[tauri::command]
pub async fn notebook_list(
    state: Db<'_>,
    include_deleted: bool,
) -> Result<Vec<NotebookSummary>, String> {
    let db = state.inner().clone();
    on_pool(db, move |db| db.notebook_list(include_deleted)).await
}

#[tauri::command]
pub async fn notebook_get(state: Db<'_>, id: String) -> Result<NotebookDetail, String> {
    let db = state.inner().clone();
    on_pool(db, move |db| db.notebook_get(&id)).await
}

#[tauri::command]
pub async fn notebook_create(
    state: Db<'_>,
    title: String,
    tags: Vec<String>,
) -> Result<NotebookSummary, String> {
    let db = state.inner().clone();
    on_pool(db, move |db| db.notebook_create(&title, &tags)).await
}

#[tauri::command]
pub async fn notebook_update(
    state: Db<'_>,
    id: String,
    title: Option<String>,
    pinned: Option<bool>,
    tags: Option<Vec<String>>,
) -> Result<NotebookSummary, String> {
    let db = state.inner().clone();
    on_pool(db, move |db| {
        db.notebook_update(&id, title.as_deref(), pinned, tags.as_deref())
    })
    .await
}

/// Move a notebook to Trash.
#[tauri::command]
pub async fn notebook_delete(state: Db<'_>, id: String) -> Result<(), String> {
    let db = state.inner().clone();
    on_pool(db, move |db| db.notebook_set_deleted(&id, true)).await
}

#[tauri::command]
pub async fn notebook_restore(state: Db<'_>, id: String) -> Result<(), String> {
    let db = state.inner().clone();
    on_pool(db, move |db| db.notebook_set_deleted(&id, false)).await
}

/// Delete a notebook for good.
#[tauri::command]
pub async fn notebook_purge(state: Db<'_>, id: String) -> Result<(), String> {
    let db = state.inner().clone();
    on_pool(db, move |db| db.notebook_purge(&id)).await
}

/// The id of the conversation a notebook's agent chat is kept in.
#[tauri::command]
pub async fn notebook_conversation(state: Db<'_>, notebook_id: String) -> Result<String, String> {
    let db = state.inner().clone();
    on_pool(db, move |db| db.conversation_for_notebook(&notebook_id)).await
}

/// One card, deleted or not, with its first 200 rows.
#[tauri::command]
pub async fn notebook_card_get(state: Db<'_>, card_id: String) -> Result<NotebookCard, String> {
    let db = state.inner().clone();
    on_pool(db, move |db| db.notebook_card_get(&card_id)).await
}

#[tauri::command]
pub async fn notebook_card_add(
    state: Db<'_>,
    notebook_id: String,
    after_card_id: Option<String>,
    card: NewCard,
    source: String,
) -> Result<NotebookCard, String> {
    let db = state.inner().clone();
    on_pool(db, move |db| {
        db.notebook_card_add(&notebook_id, after_card_id.as_deref(), &card, &source)
    })
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn notebook_card_update(
    state: Db<'_>,
    card_id: String,
    expected_version: i64,
    title: Option<String>,
    body: Option<String>,
    meta: Option<String>,
    source: String,
) -> Result<NotebookCard, String> {
    let db = state.inner().clone();
    on_pool(db, move |db| {
        db.notebook_card_update(
            &card_id,
            expected_version,
            title.as_deref(),
            body.as_deref(),
            meta.as_deref(),
            &source,
        )
    })
    .await
}

/// Put a card right after `after_card_id`, or first when it is absent.
#[tauri::command]
pub async fn notebook_card_move(
    state: Db<'_>,
    card_id: String,
    after_card_id: Option<String>,
) -> Result<(), String> {
    let db = state.inner().clone();
    on_pool(db, move |db| {
        db.notebook_card_move(&card_id, after_card_id.as_deref())
    })
    .await
}

/// Move a card to Trash.
#[tauri::command]
pub async fn notebook_card_delete(state: Db<'_>, card_id: String) -> Result<(), String> {
    let db = state.inner().clone();
    on_pool(db, move |db| db.notebook_card_set_deleted(&card_id, true)).await
}

#[tauri::command]
pub async fn notebook_card_restore(state: Db<'_>, card_id: String) -> Result<(), String> {
    let db = state.inner().clone();
    on_pool(db, move |db| db.notebook_card_set_deleted(&card_id, false)).await
}

#[tauri::command]
pub async fn notebook_card_purge(state: Db<'_>, card_id: String) -> Result<(), String> {
    let db = state.inner().clone();
    on_pool(db, move |db| db.notebook_card_purge(&card_id)).await
}

#[tauri::command]
pub async fn notebook_rows_get(
    state: Db<'_>,
    card_id: String,
    offset: i64,
    limit: i64,
) -> Result<Vec<NotebookRow>, String> {
    let db = state.inner().clone();
    on_pool(db, move |db| db.notebook_rows_get(&card_id, offset, limit)).await
}

#[tauri::command]
pub async fn notebook_rows_apply(
    state: Db<'_>,
    card_id: String,
    expected_version: i64,
    ops: Vec<RowOp>,
    source: String,
) -> Result<NotebookCard, String> {
    let db = state.inner().clone();
    on_pool(db, move |db| {
        db.notebook_rows_apply(&card_id, expected_version, &ops, &source)
    })
    .await
}

#[tauri::command]
pub async fn notebook_columns_set(
    state: Db<'_>,
    card_id: String,
    expected_version: i64,
    columns: String,
    source: String,
) -> Result<NotebookCard, String> {
    let db = state.inner().clone();
    on_pool(db, move |db| {
        db.notebook_columns_set(&card_id, expected_version, &columns, &source)
    })
    .await
}

#[tauri::command]
pub async fn notebook_card_history(
    state: Db<'_>,
    card_id: String,
) -> Result<Vec<CardHistoryEntry>, String> {
    let db = state.inner().clone();
    on_pool(db, move |db| db.notebook_card_history(&card_id)).await
}

#[tauri::command]
pub async fn notebook_card_revision(
    state: Db<'_>,
    revision_id: i64,
) -> Result<CardSnapshot, String> {
    let db = state.inner().clone();
    on_pool(db, move |db| db.notebook_card_revision(revision_id)).await
}

#[tauri::command]
pub async fn notebook_card_rollback(
    state: Db<'_>,
    card_id: String,
    revision_id: i64,
    source: String,
) -> Result<NotebookCard, String> {
    let db = state.inner().clone();
    on_pool(db, move |db| {
        db.notebook_card_rollback(&card_id, revision_id, &source)
    })
    .await
}

#[tauri::command]
pub async fn notebook_search_keyword(
    state: Db<'_>,
    query: String,
    limit: i64,
) -> Result<Vec<NotebookSearchHit>, String> {
    let db = state.inner().clone();
    on_pool(db, move |db| db.notebook_search_keyword(&query, limit)).await
}

#[tauri::command]
pub async fn notebook_trash_list(state: Db<'_>) -> Result<NotebookTrash, String> {
    let db = state.inner().clone();
    on_pool(db, move |db| db.notebook_trash_list()).await
}

/// Where the embedding model lives (shared with Memory).
fn embed_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    Ok(crate::memory::embedder::cache_dir(&data))
}

/// Notebook search: keyword hits, merged with meaning-based ones when
/// `semantic` is on and the model is there. Semantic trouble falls back to
/// keyword alone.
#[tauri::command]
pub async fn notebook_search(
    app: tauri::AppHandle,
    state: Db<'_>,
    query: String,
    limit: i64,
    semantic: bool,
) -> Result<Vec<NotebookSearchHit>, String> {
    let db = state.inner().clone();
    let dir = embed_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let limit = limit.clamp(1, 200);
        let keyword = db.notebook_search_keyword(&query, limit)?;
        if !semantic || !crate::memory::embedder::model_present(&dir) {
            return Ok(keyword);
        }
        let embed = |t: &[String]| crate::memory::embedder::embed(&dir, t);
        match db.notebook_search_semantic(
            &embed,
            crate::memory::embedder::EMBEDDING_MODEL_NAME,
            &query,
            limit as usize,
        ) {
            Ok(sem) => Ok(super::notebook_semantic::merge_hits(
                keyword,
                sem,
                limit as usize,
            )),
            Err(e) => {
                log::warn!("notebook semantic search failed: {e}");
                Ok(keyword)
            }
        }
    })
    .await
    .map_err(|e| format!("search task panicked: {e}"))?
}

/// Embed up to `limit` changed cards; returns how many still wait.
#[tauri::command]
pub async fn notebook_embed_pending(
    app: tauri::AppHandle,
    state: Db<'_>,
    limit: i64,
) -> Result<i64, String> {
    let db = state.inner().clone();
    let dir = embed_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        if !crate::memory::embedder::model_present(&dir) {
            return Err("The embedding model isn't downloaded.".to_string());
        }
        let embed = |t: &[String]| crate::memory::embedder::embed(&dir, t);
        db.notebook_embed_pending(
            &embed,
            crate::memory::embedder::EMBEDDING_MODEL_NAME,
            limit.clamp(1, 64) as usize,
        )
        .map(|n| n as i64)
    })
    .await
    .map_err(|e| format!("embed task panicked: {e}"))?
}

/// Semantic search's state, for Settings → Notebooks.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct NotebookSemanticStatus {
    pub model_present: bool,
    #[ts(type = "number")]
    pub pending: i64,
}

#[tauri::command]
pub async fn notebook_semantic_status(
    app: tauri::AppHandle,
    state: Db<'_>,
) -> Result<NotebookSemanticStatus, String> {
    let db = state.inner().clone();
    let dir = embed_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        Ok(NotebookSemanticStatus {
            model_present: crate::memory::embedder::model_present(&dir),
            pending: db
                .notebook_embed_pending_count(crate::memory::embedder::EMBEDDING_MODEL_NAME)?
                as i64,
        })
    })
    .await
    .map_err(|e| format!("status task panicked: {e}"))?
}
