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
