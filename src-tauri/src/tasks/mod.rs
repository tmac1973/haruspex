//! Background tasks: long work a Chat conversation or a Code session started
//! that runs on after the turn (a video render, an upload, later a
//! generation job), with its progress, its result, and whether its owner has
//! heard how it ended.
//!
//! Rust holds the records so every window sees the same list and nothing is
//! lost on a reload: each task is a row in `background_tasks`, kept in memory
//! here, and every change goes out as a `task://changed` event. Progress
//! (percent, ETA, phase, queue position) is memory-only.
//!
//! A task is followed either here (`TaskFollower::Rust`: the video module's
//! renders and uploads) or by the main window (`Frontend`: phase 06's
//! generation runner, through `task_update`). At launch a Rust task that was
//! still running has died with the app, so it ends as failed, and its owner
//! hears about it.

pub mod commands;

use crate::db::Database;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Ended tasks are kept this long, then pruned at launch.
pub const KEEP_ENDED: Duration = Duration::from_secs(30 * 24 * 60 * 60);

/// Progress events at most this often per task.
const PROGRESS_EVERY: Duration = Duration::from_millis(500);

/// What a Rust task that was running when the app closed ends with.
pub const ENDED_WITH_APP: &str = "Ended when the app closed.";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum TaskKind {
    VideoRender,
    YoutubeUpload,
    Image,
    Music,
    Video,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum TaskState {
    Pending,
    Running,
    Done,
    Failed,
    Cancelled,
}

impl TaskState {
    pub fn ended(self) -> bool {
        matches!(
            self,
            TaskState::Done | TaskState::Failed | TaskState::Cancelled
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum TaskFollower {
    /// Run and followed in this process.
    Rust,
    /// Followed by the main window's task runner.
    Frontend,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundTask {
    pub id: String,
    pub kind: TaskKind,
    /// `chat:<conversation id>` or `code:<session id>`: where its notice goes.
    pub owner: String,
    /// "Rendering ep012".
    pub label: String,
    pub state: TaskState,
    pub follower: TaskFollower,
    pub percent: Option<f64>,
    pub eta_secs: Option<f64>,
    pub phase: Option<String>,
    pub queue_position: Option<u32>,
    /// What to run and where; per kind.
    #[ts(type = "unknown")]
    pub spec: serde_json::Value,
    /// The server's reference to the job, once it has one.
    #[ts(type = "unknown")]
    pub handle: Option<serde_json::Value>,
    /// Per kind; set when it is done.
    #[ts(type = "unknown")]
    pub result: Option<serde_json::Value>,
    pub error: Option<String>,
    pub log_tail: Option<String>,
    #[ts(type = "number")]
    pub started_ms: u64,
    #[ts(type = "number | null")]
    pub ended_ms: Option<u64>,
    /// Its owner has taken the notice of how it ended.
    pub notice_delivered: bool,
}

/// The fields `task_update` may change. Unset ones are left alone.
#[derive(Clone, Debug, Default, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskPatch {
    pub state: Option<TaskState>,
    pub percent: Option<f64>,
    pub eta_secs: Option<f64>,
    pub phase: Option<String>,
    pub queue_position: Option<u32>,
    #[ts(type = "unknown")]
    pub handle: Option<serde_json::Value>,
    #[ts(type = "unknown")]
    pub result: Option<serde_json::Value>,
    pub error: Option<String>,
    pub log_tail: Option<String>,
}

impl TaskPatch {
    /// Only progress: kept in memory and sent out, not written to the database.
    fn progress_only(&self) -> bool {
        self.state.is_none()
            && self.handle.is_none()
            && self.result.is_none()
            && self.error.is_none()
            && self.log_tail.is_none()
    }

    fn apply(self, t: &mut BackgroundTask, now_ms: u64) {
        if let Some(p) = self.percent {
            t.percent = Some(p);
        }
        if let Some(e) = self.eta_secs {
            t.eta_secs = Some(e);
        }
        if let Some(p) = self.phase {
            t.phase = Some(p);
        }
        if let Some(q) = self.queue_position {
            t.queue_position = Some(q);
        }
        if let Some(h) = self.handle {
            t.handle = Some(h);
        }
        if let Some(r) = self.result {
            t.result = Some(r);
        }
        if let Some(e) = self.error {
            t.error = Some(e);
        }
        if let Some(l) = self.log_tail {
            t.log_tail = Some(l);
        }
        if let Some(s) = self.state {
            t.state = s;
            if s.ended() {
                t.ended_ms.get_or_insert(now_ms);
                t.eta_secs = None;
                t.queue_position = None;
                if s == TaskState::Done {
                    t.percent = Some(100.0);
                }
            }
        }
    }
}

/// The error `update` gives for a task that no longer exists (its owner was
/// deleted). A frontend follower treats it as a cancel.
pub const TASK_GONE: &str = "TaskGone";

/// Where changes go: `task://changed` in the app, anything in tests.
pub type Emit = Arc<dyn Fn(&BackgroundTask) + Send + Sync>;
/// How a frontend task is asked to stop: `task://cancel` in the app.
pub type EmitCancel = Arc<dyn Fn(&str) + Send + Sync>;

struct Entry {
    task: BackgroundTask,
    /// A Rust task's stop, while it runs; taking it cancels.
    cancel: Option<tokio::sync::oneshot::Sender<()>>,
    last_progress: Option<Instant>,
}

#[derive(Clone)]
pub struct BackgroundTasks {
    inner: Arc<Inner>,
}

struct Inner {
    tasks: Mutex<HashMap<String, Entry>>,
    db: Option<Database>,
    emit: Emit,
    emit_cancel: EmitCancel,
}

impl BackgroundTasks {
    /// Load the saved tasks, ending the Rust ones that died with the last run
    /// and pruning ended ones past `KEEP_ENDED`.
    pub fn new(db: Option<Database>, emit: Emit, emit_cancel: EmitCancel) -> Self {
        let now = crate::time_util::now_ms_u64();
        let keep_after = now.saturating_sub(KEEP_ENDED.as_millis() as u64);
        let mut map = HashMap::new();
        let saved = db
            .as_ref()
            .map(|db| db.load_tasks())
            .transpose()
            .unwrap_or_else(|e| {
                log::warn!("background tasks: {e}");
                None
            })
            .unwrap_or_default();
        for mut task in saved {
            if task.state.ended() && task.ended_ms.unwrap_or(task.started_ms) < keep_after {
                if let Some(db) = &db {
                    let _ = db.delete_task(&task.id);
                }
                continue;
            }
            if task.follower == TaskFollower::Rust && !task.state.ended() {
                task.state = TaskState::Failed;
                task.error = Some(ENDED_WITH_APP.into());
                task.ended_ms = Some(now);
                task.notice_delivered = false;
                if let Some(db) = &db {
                    let _ = db.save_task(&task);
                }
            }
            map.insert(
                task.id.clone(),
                Entry {
                    task,
                    cancel: None,
                    last_progress: None,
                },
            );
        }
        BackgroundTasks {
            inner: Arc::new(Inner {
                tasks: Mutex::new(map),
                db,
                emit,
                emit_cancel,
            }),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Entry>> {
        self.inner.tasks.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn save(&self, t: &BackgroundTask) {
        if let Some(db) = &self.inner.db {
            if let Err(e) = db.save_task(t) {
                log::warn!("background task {}: {e}", t.id);
            }
        }
    }

    /// Record a new task and announce it.
    pub fn create(
        &self,
        kind: TaskKind,
        owner: &str,
        label: &str,
        follower: TaskFollower,
        spec: serde_json::Value,
    ) -> BackgroundTask {
        let prefix = match kind {
            TaskKind::VideoRender => "render",
            TaskKind::YoutubeUpload => "upload",
            TaskKind::Image => "image",
            TaskKind::Music => "music",
            TaskKind::Video => "video",
        };
        let task = BackgroundTask {
            id: format!("{prefix}-{}", uuid::Uuid::new_v4().simple()),
            kind,
            owner: owner.into(),
            label: label.into(),
            // A Rust task is started by whoever creates it; a frontend one
            // waits for the runner.
            state: match follower {
                TaskFollower::Rust => TaskState::Running,
                TaskFollower::Frontend => TaskState::Pending,
            },
            follower,
            percent: None,
            eta_secs: None,
            phase: None,
            queue_position: None,
            spec,
            handle: None,
            result: None,
            error: None,
            log_tail: None,
            started_ms: crate::time_util::now_ms_u64(),
            ended_ms: None,
            notice_delivered: false,
        };
        self.save(&task);
        self.lock().insert(
            task.id.clone(),
            Entry {
                task: task.clone(),
                cancel: None,
                last_progress: None,
            },
        );
        (self.inner.emit)(&task);
        task
    }

    /// Give a running Rust task its stop.
    pub fn attach_cancel(&self, id: &str, cancel: tokio::sync::oneshot::Sender<()>) {
        if let Some(e) = self.lock().get_mut(id) {
            e.cancel = Some(cancel);
        }
    }

    /// Change a task. Progress alone is not saved, and goes out at most every
    /// half second; anything else is saved and goes out at once.
    pub fn update(&self, id: &str, patch: TaskPatch) -> Result<BackgroundTask, String> {
        let progress_only = patch.progress_only();
        let now = Instant::now();
        let (task, send) = {
            let mut map = self.lock();
            let e = map.get_mut(id).ok_or(TASK_GONE)?;
            if e.task.state.ended() && !progress_only {
                // An ended task stays as it ended; a late follower's write is dropped.
                return Ok(e.task.clone());
            }
            patch.apply(&mut e.task, crate::time_util::now_ms_u64());
            if e.task.state.ended() {
                e.cancel = None;
            }
            let send = !progress_only
                || e.last_progress
                    .is_none_or(|t| now.duration_since(t) >= PROGRESS_EVERY);
            if send {
                e.last_progress = Some(now);
            }
            (e.task.clone(), send)
        };
        if !progress_only {
            self.save(&task);
        }
        if send {
            (self.inner.emit)(&task);
        }
        Ok(task)
    }

    pub fn get(&self, id: &str) -> Option<BackgroundTask> {
        self.lock().get(id).map(|e| e.task.clone())
    }

    /// Every task, or one owner's, oldest first.
    pub fn list(&self, owner: Option<&str>) -> Vec<BackgroundTask> {
        let mut all: Vec<BackgroundTask> = self
            .lock()
            .values()
            .filter(|e| owner.is_none_or(|o| e.task.owner == o))
            .map(|e| e.task.clone())
            .collect();
        all.sort_by_key(|t| t.started_ms);
        all
    }

    /// A task of this kind that hasn't ended, if any.
    pub fn running(&self, kind: TaskKind) -> Option<String> {
        self.lock()
            .values()
            .find(|e| e.task.kind == kind && !e.task.state.ended())
            .map(|e| e.task.id.clone())
    }

    /// Ask a task to stop. A Rust task is stopped here; a frontend one is
    /// asked through `task://cancel`, and its follower ends it. False when it
    /// isn't running.
    pub fn cancel(&self, id: &str) -> bool {
        let (follower, sender) = {
            let mut map = self.lock();
            let Some(e) = map.get_mut(id) else {
                return false;
            };
            if e.task.state.ended() {
                return false;
            }
            (e.task.follower, e.cancel.take())
        };
        match follower {
            TaskFollower::Rust => sender.is_some_and(|s| s.send(()).is_ok()),
            TaskFollower::Frontend => {
                (self.inner.emit_cancel)(id);
                true
            }
        }
    }

    /// Stop every Rust task still running (app exit).
    pub fn cancel_all(&self) {
        let senders: Vec<_> = self
            .lock()
            .values_mut()
            .filter_map(|e| e.cancel.take())
            .collect();
        for s in senders {
            let _ = s.send(());
        }
    }

    /// The owner's ended tasks it hasn't heard about, marked heard. Marked on
    /// the take, so a notice is never delivered twice; a crash before its
    /// turn runs loses it, and the task's card still shows the result.
    pub fn take_notices(&self, owner: &str) -> Vec<BackgroundTask> {
        let taken: Vec<BackgroundTask> = {
            let mut map = self.lock();
            let mut taken: Vec<BackgroundTask> = map
                .values_mut()
                .filter(|e| {
                    e.task.owner == owner && e.task.state.ended() && !e.task.notice_delivered
                })
                .map(|e| {
                    e.task.notice_delivered = true;
                    e.task.clone()
                })
                .collect();
            taken.sort_by_key(|t| t.ended_ms.unwrap_or(t.started_ms));
            taken
        };
        for t in &taken {
            self.save(t);
            // Every window's mirror learns the notice has gone.
            (self.inner.emit)(t);
        }
        taken
    }

    /// Every owner starting `prefix` is gone (`chat:`: every conversation cleared).
    pub fn remove_owners_with_prefix(&self, prefix: &str) {
        let mut owners: Vec<String> = self
            .lock()
            .values()
            .filter(|e| e.task.owner.starts_with(prefix))
            .map(|e| e.task.owner.clone())
            .collect();
        owners.sort();
        owners.dedup();
        for owner in owners {
            self.remove_owner(&owner);
        }
    }

    /// The owner is gone: stop its tasks and forget them.
    pub fn remove_owner(&self, owner: &str) {
        let ids: Vec<String> = self
            .lock()
            .values()
            .filter(|e| e.task.owner == owner)
            .map(|e| e.task.id.clone())
            .collect();
        for id in &ids {
            self.cancel(id);
        }
        self.lock().retain(|_, e| e.task.owner != owner);
        if let Some(db) = &self.inner.db {
            if let Err(e) = db.delete_tasks_for_owner(owner) {
                log::warn!("background tasks for {owner}: {e}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    type Seen = Arc<Mutex<Vec<BackgroundTask>>>;

    fn registry(db: Option<Database>) -> (BackgroundTasks, Seen, Arc<Mutex<Vec<String>>>) {
        let seen: Seen = Arc::default();
        let cancels: Arc<Mutex<Vec<String>>> = Arc::default();
        let (s, c) = (seen.clone(), cancels.clone());
        let tasks = BackgroundTasks::new(
            db,
            Arc::new(move |t| s.lock().unwrap().push(t.clone())),
            Arc::new(move |id| c.lock().unwrap().push(id.into())),
        );
        (tasks, seen, cancels)
    }

    fn done() -> TaskPatch {
        TaskPatch {
            state: Some(TaskState::Done),
            result: Some(serde_json::json!({ "path": "out.mp4" })),
            ..Default::default()
        }
    }

    #[test]
    fn a_task_ends_and_its_owner_takes_the_notice_once() {
        let (tasks, seen, _) = registry(None);
        let t = tasks.create(
            TaskKind::VideoRender,
            "chat:a",
            "Rendering ep1",
            TaskFollower::Rust,
            serde_json::json!({}),
        );
        assert_eq!(t.state, TaskState::Running);
        tasks
            .update(
                &t.id,
                TaskPatch {
                    percent: Some(40.0),
                    ..Default::default()
                },
            )
            .unwrap();
        let ended = tasks.update(&t.id, done()).unwrap();
        assert_eq!(ended.state, TaskState::Done);
        assert_eq!(ended.percent, Some(100.0));
        assert!(ended.ended_ms.is_some());

        assert!(tasks.take_notices("chat:b").is_empty());
        let notices = tasks.take_notices("chat:a");
        assert_eq!(notices.len(), 1);
        assert!(notices[0].notice_delivered);
        assert!(tasks.take_notices("chat:a").is_empty());
        // Created, progress, done, and the notice taken.
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 4);
        assert!(seen[3].notice_delivered);
    }

    #[test]
    fn progress_is_throttled_and_changes_are_not() {
        let (tasks, seen, _) = registry(None);
        let t = tasks.create(
            TaskKind::Image,
            "code:s",
            "Drawing",
            TaskFollower::Frontend,
            serde_json::json!({}),
        );
        for p in 1..10 {
            tasks
                .update(
                    &t.id,
                    TaskPatch {
                        percent: Some(p as f64),
                        ..Default::default()
                    },
                )
                .unwrap();
        }
        // Created, and the first progress; the rest come within half a second.
        assert_eq!(seen.lock().unwrap().len(), 2);
        assert_eq!(tasks.get(&t.id).unwrap().percent, Some(9.0));
        tasks
            .update(
                &t.id,
                TaskPatch {
                    state: Some(TaskState::Running),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(seen.lock().unwrap().len(), 3);
    }

    #[test]
    fn an_ended_task_keeps_how_it_ended() {
        let (tasks, _, _) = registry(None);
        let t = tasks.create(
            TaskKind::Image,
            "chat:a",
            "Drawing",
            TaskFollower::Frontend,
            serde_json::json!({}),
        );
        tasks
            .update(
                &t.id,
                TaskPatch {
                    state: Some(TaskState::Cancelled),
                    ..Default::default()
                },
            )
            .unwrap();
        let late = tasks.update(&t.id, done()).unwrap();
        assert_eq!(late.state, TaskState::Cancelled);
    }

    #[test]
    fn cancel_stops_a_rust_task_and_asks_a_frontend_one() {
        let (tasks, _, cancels) = registry(None);
        let r = tasks.create(
            TaskKind::VideoRender,
            "chat:a",
            "R",
            TaskFollower::Rust,
            serde_json::json!({}),
        );
        let (tx, mut rx) = tokio::sync::oneshot::channel();
        tasks.attach_cancel(&r.id, tx);
        assert!(tasks.cancel(&r.id));
        assert!(rx.try_recv().is_ok());

        let f = tasks.create(
            TaskKind::Image,
            "chat:a",
            "F",
            TaskFollower::Frontend,
            serde_json::json!({}),
        );
        assert!(tasks.cancel(&f.id));
        assert_eq!(*cancels.lock().unwrap(), vec![f.id.clone()]);

        tasks
            .update(
                &f.id,
                TaskPatch {
                    state: Some(TaskState::Cancelled),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(!tasks.cancel(&f.id));
        assert!(!tasks.cancel("nope"));
    }

    #[test]
    fn launch_fails_rust_tasks_that_died_with_the_app_and_keeps_frontend_ones() {
        let db = Database::open_in_memory();
        let (tasks, _, _) = registry(Some(db.clone()));
        let r = tasks.create(
            TaskKind::VideoRender,
            "chat:a",
            "R",
            TaskFollower::Rust,
            serde_json::json!({}),
        );
        let f = tasks.create(
            TaskKind::Image,
            "chat:a",
            "F",
            TaskFollower::Frontend,
            serde_json::json!({}),
        );
        tasks
            .update(
                &f.id,
                TaskPatch {
                    state: Some(TaskState::Running),
                    handle: Some(serde_json::json!({ "jobId": "j1" })),
                    ..Default::default()
                },
            )
            .unwrap();

        let (again, _, _) = registry(Some(db));
        let r = again.get(&r.id).unwrap();
        assert_eq!(r.state, TaskState::Failed);
        assert_eq!(r.error.as_deref(), Some(ENDED_WITH_APP));
        assert!(!r.notice_delivered);
        let f = again.get(&f.id).unwrap();
        assert_eq!(f.state, TaskState::Running);
        assert_eq!(f.handle, Some(serde_json::json!({ "jobId": "j1" })));
        assert_eq!(again.take_notices("chat:a").len(), 1);
    }

    #[test]
    fn launch_prunes_tasks_that_ended_long_ago() {
        let db = Database::open_in_memory();
        let (tasks, _, _) = registry(Some(db.clone()));
        let old = tasks.create(
            TaskKind::Image,
            "chat:a",
            "Old",
            TaskFollower::Frontend,
            serde_json::json!({}),
        );
        let mut t = tasks.update(&old.id, done()).unwrap();
        t.ended_ms = Some(1);
        db.save_task(&t).unwrap();
        let recent = tasks.create(
            TaskKind::Image,
            "chat:a",
            "New",
            TaskFollower::Frontend,
            serde_json::json!({}),
        );
        tasks.update(&recent.id, done()).unwrap();

        let (again, _, _) = registry(Some(db.clone()));
        assert!(again.get(&old.id).is_none());
        assert!(again.get(&recent.id).is_some());
        assert_eq!(db.load_tasks().unwrap().len(), 1);
    }

    #[test]
    fn removing_an_owner_stops_and_forgets_its_tasks() {
        let db = Database::open_in_memory();
        let (tasks, _, cancels) = registry(Some(db.clone()));
        let a = tasks.create(
            TaskKind::Image,
            "chat:a",
            "A",
            TaskFollower::Frontend,
            serde_json::json!({}),
        );
        let b = tasks.create(
            TaskKind::Image,
            "chat:b",
            "B",
            TaskFollower::Frontend,
            serde_json::json!({}),
        );
        tasks.remove_owner("chat:a");
        assert_eq!(*cancels.lock().unwrap(), vec![a.id.clone()]);
        assert!(tasks.get(&a.id).is_none());
        assert_eq!(tasks.update(&a.id, done()).unwrap_err(), TASK_GONE);
        assert_eq!(
            tasks.list(None).iter().map(|t| &t.id).collect::<Vec<_>>(),
            vec![&b.id]
        );
        assert_eq!(db.load_tasks().unwrap().len(), 1);
    }

    #[test]
    fn enums_serialise_snake_case() {
        let v = serde_json::to_value(TaskKind::YoutubeUpload).unwrap();
        assert_eq!(v, "youtube_upload");
        assert_eq!(
            serde_json::to_value(TaskFollower::Frontend).unwrap(),
            "frontend"
        );
    }
}
