//! The camera watcher's log: one row per event, searchable by what was said
//! and by its caption through `camera_events_fts`.

use super::*;
use rusqlite::{params, params_from_iter, types::Value};

/// One event in the log, as lists return it. The thumbnail is fetched on its
/// own with `camera_event_thumb`.
#[derive(Clone, Debug, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct CameraEvent {
    #[ts(type = "number")]
    pub id: i64,
    pub camera_id: String,
    /// Epoch ms.
    #[ts(type = "number")]
    pub started_at: i64,
    #[ts(type = "number")]
    pub ended_at: i64,
    /// `"motion"`, `"sound"` or `"both"`; `"room"` for a room check that
    /// found the room changed (camera alerts).
    pub trigger: String,
    /// The recorded sound's loudness, RMS in dBFS; -120 is silence or none.
    pub level_db: f64,
    /// What was said; empty when nothing was.
    pub transcript: String,
    pub caption: Option<String>,
    /// `"pending"`, `"done"` or `"skipped"`.
    pub caption_status: String,
    pub has_thumb: bool,
    /// The camera-alerts judgement; `None` until judged, and always for a
    /// camera with alerts off.
    pub alert_level: Option<AlertLevel>,
    /// Why, in a sentence; empty when not judged.
    pub alert_reason: String,
    /// When the user dismissed it, epoch ms.
    #[ts(type = "number | null")]
    pub dismissed_at: Option<i64>,
    /// What they wrote when they did; empty for none.
    pub dismiss_note: String,
}

/// How much a camera event matters (camera alerts).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "lowercase")]
pub enum AlertLevel {
    Normal,
    Unusual,
    Urgent,
}

impl AlertLevel {
    fn as_str(self) -> &'static str {
        match self {
            AlertLevel::Normal => "normal",
            AlertLevel::Unusual => "unusual",
            AlertLevel::Urgent => "urgent",
        }
    }

    fn parse(s: &str) -> Option<AlertLevel> {
        match s {
            "normal" => Some(AlertLevel::Normal),
            "unusual" => Some(AlertLevel::Unusual),
            "urgent" => Some(AlertLevel::Urgent),
            _ => None,
        }
    }
}

/// Events per local hour of the day over a period, weekdays and weekends
/// apart, and on how many dates of each kind any event was logged: what
/// camera alerts learn a camera's quiet hours from.
#[derive(Clone, Debug, Default, PartialEq, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "camelCase")]
pub struct HourCounts {
    pub weekday: Vec<u32>,
    pub weekend: Vec<u32>,
    pub days_weekday: u32,
    pub days_weekend: u32,
}

/// What the watcher records when an event closes.
#[derive(Clone, Debug, PartialEq)]
pub struct NewCameraEvent {
    pub camera_id: String,
    pub started_at: i64,
    pub ended_at: i64,
    pub trigger: String,
    pub level_db: f64,
    pub transcript: String,
}

/// Which events a list or search covers.
#[derive(Clone, Debug, Default)]
pub struct CameraEventFilter {
    pub camera_id: Option<String>,
    /// Started at or after, epoch ms.
    pub since: Option<i64>,
    /// Started at or before, epoch ms.
    pub until: Option<i64>,
    pub limit: u32,
}

/// The most rows a list or search returns.
const MAX_LIMIT: u32 = 500;

const COLS: &str = "e.id, e.camera_id, e.started_at, e.ended_at, e.\"trigger\", e.level_db,
     e.transcript, e.caption, e.caption_status, e.thumb_path,
     e.alert_level, e.alert_reason, e.dismissed_at, e.dismiss_note";

fn event_from_row(row: &rusqlite::Row) -> rusqlite::Result<CameraEvent> {
    Ok(CameraEvent {
        id: row.get(0)?,
        camera_id: row.get(1)?,
        started_at: row.get(2)?,
        ended_at: row.get(3)?,
        trigger: row.get(4)?,
        level_db: row.get(5)?,
        transcript: row.get(6)?,
        caption: row.get(7)?,
        caption_status: row.get(8)?,
        has_thumb: !row.get::<_, String>(9)?.is_empty(),
        alert_level: row
            .get::<_, Option<String>>(10)?
            .as_deref()
            .and_then(AlertLevel::parse),
        alert_reason: row.get(11)?,
        dismissed_at: row.get(12)?,
        dismiss_note: row.get(13)?,
    })
}

/// `query` as an FTS5 expression: each word quoted (so `"`, `*`, `NEAR` and
/// the like are only words) and matched as a prefix; every word must match.
/// `None` when it has no words.
pub(crate) fn fts_query(query: &str) -> Option<String> {
    let words: Vec<String> = query
        .split(|c: char| !c.is_alphanumeric() && c != '\'')
        .map(|w| w.trim_matches('\''))
        .filter(|w| !w.is_empty())
        .map(|w| format!("\"{}\"*", w.replace('"', "")))
        .collect();
    (!words.is_empty()).then(|| words.join(" "))
}

/// The `WHERE` terms and their values for `f`, after any already bound.
fn filter_sql(f: &CameraEventFilter, sql: &mut String, values: &mut Vec<Value>) {
    if let Some(id) = &f.camera_id {
        values.push(Value::Text(id.clone()));
        sql.push_str(&format!(" AND e.camera_id = ?{}", values.len()));
    }
    if let Some(since) = f.since {
        values.push(Value::Integer(since));
        sql.push_str(&format!(" AND e.started_at >= ?{}", values.len()));
    }
    if let Some(until) = f.until {
        values.push(Value::Integer(until));
        sql.push_str(&format!(" AND e.started_at <= ?{}", values.len()));
    }
    values.push(Value::Integer(i64::from(f.limit.clamp(1, MAX_LIMIT))));
    sql.push_str(&format!(
        " ORDER BY e.started_at DESC, e.id DESC LIMIT ?{}",
        values.len()
    ));
}

impl Database {
    /// Add an event, without its thumbnail; its id.
    pub fn insert_camera_event(&self, e: &NewCameraEvent) -> Result<i64, String> {
        let conn = self.conn();
        conn.execute(
            "INSERT INTO camera_events
             (camera_id, started_at, ended_at, \"trigger\", level_db, transcript)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                e.camera_id,
                e.started_at,
                e.ended_at,
                e.trigger,
                e.level_db,
                e.transcript
            ],
        )
        .map_err(|e| format!("Saving the camera event failed: {e}"))?;
        Ok(conn.last_insert_rowid())
    }

    pub fn set_camera_event_thumb(&self, id: i64, path: &str) -> Result<(), String> {
        self.conn()
            .execute(
                "UPDATE camera_events SET thumb_path = ?1 WHERE id = ?2",
                params![path, id],
            )
            .map_err(|e| format!("Saving the thumbnail failed: {e}"))?;
        Ok(())
    }

    /// Save an event's caption: `Some` marks it done, `None` skipped (no
    /// picture, or a model that can't see). The update trigger re-indexes it.
    pub fn set_camera_event_caption(&self, id: i64, caption: Option<&str>) -> Result<(), String> {
        let caption = caption.map(str::trim).filter(|c| !c.is_empty());
        let status = if caption.is_some() { "done" } else { "skipped" };
        self.conn()
            .execute(
                "UPDATE camera_events SET caption = ?1, caption_status = ?2 WHERE id = ?3",
                params![caption, status, id],
            )
            .map_err(|e| format!("Saving the caption failed: {e}"))?;
        Ok(())
    }

    /// Save an event's caption and judgement together (camera alerts). A
    /// `None` caption marks it skipped, as `set_camera_event_caption` does.
    pub fn set_camera_event_judgement(
        &self,
        id: i64,
        caption: Option<&str>,
        level: AlertLevel,
        reason: &str,
    ) -> Result<(), String> {
        let caption = caption.map(str::trim).filter(|c| !c.is_empty());
        let status = if caption.is_some() { "done" } else { "skipped" };
        self.conn()
            .execute(
                "UPDATE camera_events
                 SET caption = ?1, caption_status = ?2, alert_level = ?3, alert_reason = ?4
                 WHERE id = ?5",
                params![caption, status, level.as_str(), reason.trim(), id],
            )
            .map_err(|e| format!("Saving the judgement failed: {e}"))?;
        Ok(())
    }

    /// Mark an event dismissed now, with the user's note.
    pub fn dismiss_camera_event(&self, id: i64, note: &str, now: i64) -> Result<(), String> {
        self.conn()
            .execute(
                "UPDATE camera_events SET dismissed_at = ?1, dismiss_note = ?2 WHERE id = ?3",
                params![now, note.trim(), id],
            )
            .map_err(|e| format!("Dismissing the event failed: {e}"))?;
        Ok(())
    }

    /// Events per local hour since `since` (epoch ms) for one camera, not
    /// counting room checks. `offset_ms` turns a start time into local time
    /// (`chrono::Local`'s offset, passed in so tests are fixed).
    pub fn camera_event_hour_counts(
        &self,
        camera_id: &str,
        since: i64,
        offset_ms: i64,
    ) -> Result<HourCounts, String> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare(
                "SELECT started_at FROM camera_events
                 WHERE camera_id = ?1 AND started_at >= ?2 AND \"trigger\" != 'room'",
            )
            .map_err(|e| format!("Query failed: {e}"))?;
        let starts = stmt
            .query_map(params![camera_id, since], |row| row.get::<_, i64>(0))
            .map_err(|e| format!("Query failed: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Query failed: {e}"))?;
        Ok(hour_counts(&starts, offset_ms))
    }

    /// The events still waiting for a caption, oldest first.
    pub fn pending_camera_events(&self, limit: u32) -> Result<Vec<CameraEvent>, String> {
        let sql = format!(
            "SELECT {COLS} FROM camera_events e WHERE e.caption_status = 'pending'
             ORDER BY e.started_at ASC, e.id ASC LIMIT ?1"
        );
        let limit = i64::from(limit.clamp(1, MAX_LIMIT));
        self.query_camera_events(&sql, vec![Value::Integer(limit)])
    }

    /// The newest events first.
    pub fn list_camera_events(&self, f: &CameraEventFilter) -> Result<Vec<CameraEvent>, String> {
        let mut sql = format!("SELECT {COLS} FROM camera_events e WHERE 1 = 1");
        let mut values = Vec::new();
        filter_sql(f, &mut sql, &mut values);
        self.query_camera_events(&sql, values)
    }

    /// The newest events whose transcript or caption has every word of
    /// `query`; none when it has no words.
    pub fn search_camera_events(
        &self,
        query: &str,
        f: &CameraEventFilter,
    ) -> Result<Vec<CameraEvent>, String> {
        let Some(fts) = fts_query(query) else {
            return Ok(Vec::new());
        };
        let mut sql = format!(
            "SELECT {COLS} FROM camera_events e
             WHERE e.id IN (SELECT rowid FROM camera_events_fts WHERE camera_events_fts MATCH ?1)"
        );
        let mut values = vec![Value::Text(fts)];
        filter_sql(f, &mut sql, &mut values);
        self.query_camera_events(&sql, values)
    }

    fn query_camera_events(
        &self,
        sql: &str,
        values: Vec<Value>,
    ) -> Result<Vec<CameraEvent>, String> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare(sql)
            .map_err(|e| format!("Query failed: {e}"))?;
        let rows = stmt
            .query_map(params_from_iter(values), event_from_row)
            .map_err(|e| format!("Query failed: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Reading camera events failed: {e}"));
        rows
    }

    /// The event's thumbnail file; `None` when there is no such event or it
    /// has none.
    pub fn camera_event_thumb_path(&self, id: i64) -> Result<Option<String>, String> {
        let conn = self.conn();
        let path: Option<String> = conn
            .query_row(
                "SELECT thumb_path FROM camera_events WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                e => Err(format!("Query failed: {e}")),
            })?;
        Ok(path.filter(|p| !p.is_empty()))
    }

    /// Delete the rows `condition` picks; how many, and the thumbnail files
    /// they had, for the caller to delete.
    fn delete_camera_events_where(
        &self,
        condition: &str,
        values: Vec<Value>,
    ) -> Result<(usize, Vec<String>), String> {
        let conn = self.conn();
        let thumbs = {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT thumb_path FROM camera_events WHERE {condition}"
                ))
                .map_err(|e| format!("Query failed: {e}"))?;
            let rows = stmt
                .query_map(params_from_iter(values.clone()), |row| {
                    row.get::<_, String>(0)
                })
                .map_err(|e| format!("Query failed: {e}"))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("Query failed: {e}"))?;
            rows
        };
        let count = conn
            .execute(
                &format!("DELETE FROM camera_events WHERE {condition}"),
                params_from_iter(values),
            )
            .map_err(|e| format!("Deleting camera events failed: {e}"))?;
        Ok((
            count,
            thumbs.into_iter().filter(|p| !p.is_empty()).collect(),
        ))
    }

    /// Delete one event; its thumbnail file, if it had one.
    pub fn delete_camera_event(&self, id: i64) -> Result<Vec<String>, String> {
        self.delete_camera_events_where("id = ?1", vec![Value::Integer(id)])
            .map(|(_, thumbs)| thumbs)
    }

    /// Delete one camera's events, or every camera's; how many, and their
    /// thumbnail files.
    pub fn clear_camera_events(
        &self,
        camera_id: Option<&str>,
    ) -> Result<(usize, Vec<String>), String> {
        match camera_id {
            Some(id) => {
                self.delete_camera_events_where("camera_id = ?1", vec![Value::Text(id.into())])
            }
            None => self.delete_camera_events_where("1 = 1", Vec::new()),
        }
    }

    /// Delete the events that started before `cutoff` (epoch ms); their
    /// thumbnail files.
    pub fn purge_camera_events_before(&self, cutoff: i64) -> Result<Vec<String>, String> {
        self.delete_camera_events_where("started_at < ?1", vec![Value::Integer(cutoff)])
            .map(|(_, thumbs)| thumbs)
    }
}

/// Bucket start times (epoch ms) by local hour, weekday or weekend.
fn hour_counts(starts: &[i64], offset_ms: i64) -> HourCounts {
    const DAY: i64 = 86_400_000;
    let mut out = HourCounts {
        weekday: vec![0; 24],
        weekend: vec![0; 24],
        ..Default::default()
    };
    let mut weekday_dates = std::collections::HashSet::new();
    let mut weekend_dates = std::collections::HashSet::new();
    for &t in starts {
        let local = t + offset_ms;
        let date = local.div_euclid(DAY);
        let hour = (local.rem_euclid(DAY) / 3_600_000) as usize;
        // 1970-01-01 was a Thursday: 0 = Thursday … 2 = Saturday, 3 = Sunday.
        let weekend = matches!(date.rem_euclid(7), 2 | 3);
        if weekend {
            out.weekend[hour] += 1;
            weekend_dates.insert(date);
        } else {
            out.weekday[hour] += 1;
            weekday_dates.insert(date);
        }
    }
    out.days_weekday = weekday_dates.len() as u32;
    out.days_weekend = weekend_dates.len() as u32;
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(camera: &str, started_at: i64, transcript: &str) -> NewCameraEvent {
        NewCameraEvent {
            camera_id: camera.into(),
            started_at,
            ended_at: started_at + 5_000,
            trigger: "sound".into(),
            level_db: -30.0,
            transcript: transcript.into(),
        }
    }

    fn all() -> CameraEventFilter {
        CameraEventFilter {
            limit: 100,
            ..Default::default()
        }
    }

    #[test]
    fn events_list_newest_first_and_filter() {
        let db = Database::open_in_memory();
        let a = db
            .insert_camera_event(&event("kitchen", 1_000, "hello"))
            .unwrap();
        let b = db.insert_camera_event(&event("hall", 2_000, "")).unwrap();
        let c = db
            .insert_camera_event(&event("kitchen", 3_000, "bye"))
            .unwrap();
        let ids = |v: Vec<CameraEvent>| v.into_iter().map(|e| e.id).collect::<Vec<_>>();
        assert_eq!(ids(db.list_camera_events(&all()).unwrap()), [c, b, a]);
        let kitchen = CameraEventFilter {
            camera_id: Some("kitchen".into()),
            ..all()
        };
        assert_eq!(ids(db.list_camera_events(&kitchen).unwrap()), [c, a]);
        let window = CameraEventFilter {
            since: Some(1_500),
            until: Some(2_500),
            ..all()
        };
        assert_eq!(ids(db.list_camera_events(&window).unwrap()), [b]);
        let one = CameraEventFilter { limit: 1, ..all() };
        assert_eq!(ids(db.list_camera_events(&one).unwrap()), [c]);
        let row = &db.list_camera_events(&kitchen).unwrap()[1];
        assert_eq!(row.caption_status, "pending");
        assert!(row.caption.is_none() && !row.has_thumb);
    }

    #[test]
    fn search_finds_transcript_words() {
        let db = Database::open_in_memory();
        let parcel = db
            .insert_camera_event(&event("door", 1_000, "Hi, I've got a parcel for you."))
            .unwrap();
        db.insert_camera_event(&event("door", 2_000, "Is anyone home?"))
            .unwrap();
        let found = db.search_camera_events("parcel", &all()).unwrap();
        assert_eq!(found.iter().map(|e| e.id).collect::<Vec<_>>(), [parcel]);
        // Prefixes match, every word must, and FTS syntax is only words.
        assert_eq!(db.search_camera_events("parc", &all()).unwrap().len(), 1);
        assert_eq!(
            db.search_camera_events("parcel home", &all())
                .unwrap()
                .len(),
            0
        );
        assert_eq!(
            db.search_camera_events("\"anyone\" OR NEAR(*", &all())
                .unwrap()
                .len(),
            0
        );
        assert_eq!(db.search_camera_events("anyone", &all()).unwrap().len(), 1);
        assert!(db.search_camera_events("  ?! ", &all()).unwrap().is_empty());
        // A deleted event leaves the index with it.
        db.delete_camera_event(parcel).unwrap();
        assert!(db
            .search_camera_events("parcel", &all())
            .unwrap()
            .is_empty());
    }

    #[test]
    fn deleting_returns_the_thumbnails() {
        let db = Database::open_in_memory();
        let old = db.insert_camera_event(&event("door", 1_000, "")).unwrap();
        let new = db.insert_camera_event(&event("door", 9_000, "")).unwrap();
        let other = db.insert_camera_event(&event("hall", 9_000, "")).unwrap();
        db.set_camera_event_thumb(old, "/t/old.jpg").unwrap();
        db.set_camera_event_thumb(new, "/t/new.jpg").unwrap();
        assert_eq!(
            db.camera_event_thumb_path(old).unwrap().as_deref(),
            Some("/t/old.jpg")
        );
        assert_eq!(db.camera_event_thumb_path(other).unwrap(), None);
        assert_eq!(db.camera_event_thumb_path(999).unwrap(), None);
        assert_eq!(
            db.purge_camera_events_before(5_000).unwrap(),
            ["/t/old.jpg"]
        );
        assert_eq!(
            db.clear_camera_events(Some("door")).unwrap(),
            (1, vec!["/t/new.jpg".to_string()])
        );
        assert_eq!(db.list_camera_events(&all()).unwrap().len(), 1);
        assert_eq!(db.clear_camera_events(None).unwrap(), (1, Vec::new()));
        assert!(db.list_camera_events(&all()).unwrap().is_empty());
    }

    #[test]
    fn captions_are_saved_searchable_and_leave_the_pending_list() {
        let db = Database::open_in_memory();
        let a = db.insert_camera_event(&event("door", 2_000, "")).unwrap();
        let b = db.insert_camera_event(&event("door", 1_000, "")).unwrap();
        let c = db.insert_camera_event(&event("door", 3_000, "")).unwrap();
        let pending = |db: &Database| {
            db.pending_camera_events(10)
                .unwrap()
                .into_iter()
                .map(|e| e.id)
                .collect::<Vec<_>>()
        };
        assert_eq!(pending(&db), [b, a, c]);
        db.set_camera_event_caption(a, Some(" A man holds a parcel. "))
            .unwrap();
        db.set_camera_event_caption(b, Some("  ")).unwrap();
        assert_eq!(pending(&db), [c]);
        let rows = db.list_camera_events(&all()).unwrap();
        let row = |id| rows.iter().find(|e| e.id == id).unwrap();
        assert_eq!(row(a).caption.as_deref(), Some("A man holds a parcel."));
        assert_eq!(row(a).caption_status, "done");
        assert_eq!(row(b).caption, None);
        assert_eq!(row(b).caption_status, "skipped");
        let found = db.search_camera_events("parcel", &all()).unwrap();
        assert_eq!(found.iter().map(|e| e.id).collect::<Vec<_>>(), [a]);
        db.set_camera_event_caption(c, None).unwrap();
        assert!(pending(&db).is_empty());
    }

    #[test]
    fn fts_queries_are_quoted_words() {
        assert_eq!(
            fts_query("parcel door").as_deref(),
            Some("\"parcel\"* \"door\"*")
        );
        assert_eq!(fts_query("I've").as_deref(), Some("\"I've\"*"));
        assert_eq!(fts_query("\"x\" OR"), Some("\"x\"* \"OR\"*".into()));
        assert_eq!(fts_query(" - "), None);
    }

    #[test]
    fn a_judgement_saves_with_the_caption_and_is_searchable() {
        let db = Database::open_in_memory();
        let id = db.insert_camera_event(&event("hall", 1_000, "")).unwrap();
        let row = &db.list_camera_events(&all()).unwrap()[0];
        assert_eq!(row.alert_level, None);
        assert!(row.alert_reason.is_empty() && row.dismissed_at.is_none());

        db.set_camera_event_judgement(
            id,
            Some("A person opens a drawer."),
            AlertLevel::Urgent,
            "Someone is searching the drawers.",
        )
        .unwrap();
        let row = &db.list_camera_events(&all()).unwrap()[0];
        assert_eq!(row.alert_level, Some(AlertLevel::Urgent));
        assert_eq!(row.caption_status, "done");
        assert_eq!(row.alert_reason, "Someone is searching the drawers.");
        // The reason is in the search index.
        assert_eq!(
            db.search_camera_events("searching", &all()).unwrap().len(),
            1
        );
        assert!(db.pending_camera_events(10).unwrap().is_empty());

        db.dismiss_camera_event(id, " me tidying ", 5_000).unwrap();
        let row = &db.list_camera_events(&all()).unwrap()[0];
        assert_eq!(row.dismissed_at, Some(5_000));
        assert_eq!(row.dismiss_note, "me tidying");
    }

    #[test]
    fn hour_counts_bucket_by_local_hour_and_day_kind() {
        const H: i64 = 3_600_000;
        const DAY: i64 = 24 * H;
        // Day 0 is a Thursday, day 2 a Saturday.
        let starts = [3 * H, 3 * H + 60_000, DAY + 14 * H, 2 * DAY + 23 * H];
        let c = hour_counts(&starts, 0);
        assert_eq!(c.weekday[3], 2);
        assert_eq!(c.weekday[14], 1);
        assert_eq!(c.weekend[23], 1);
        assert_eq!((c.days_weekday, c.days_weekend), (2, 1));
        // Two hours ahead moves 23:00 Saturday to 01:00 Sunday.
        let c = hour_counts(&starts, 2 * H);
        assert_eq!(c.weekend[1], 1);
        assert_eq!(c.weekday[5], 2);
    }

    #[test]
    fn hour_counts_leave_out_room_checks_and_other_cameras() {
        let db = Database::open_in_memory();
        db.insert_camera_event(&event("hall", 1_000, "")).unwrap();
        db.insert_camera_event(&event("door", 1_000, "")).unwrap();
        db.insert_camera_event(&NewCameraEvent {
            trigger: "room".into(),
            ..event("hall", 2_000, "")
        })
        .unwrap();
        let c = db.camera_event_hour_counts("hall", 0, 0).unwrap();
        assert_eq!(c.weekday.iter().sum::<u32>(), 1);
    }

    #[test]
    fn an_older_two_column_index_is_widened_and_refilled() {
        let db = Database::open_in_memory();
        let id = db
            .insert_camera_event(&event("hall", 1_000, "a parcel came"))
            .unwrap();
        // Put back the index every database had before camera alerts.
        db.conn()
            .execute_batch(
                "DROP TRIGGER camera_events_fts_insert;
                 DROP TRIGGER camera_events_fts_delete;
                 DROP TRIGGER camera_events_fts_update;
                 DROP TABLE camera_events_fts;
                 CREATE VIRTUAL TABLE camera_events_fts USING fts5(
                     transcript, caption, content='camera_events', content_rowid='id');",
            )
            .unwrap();
        db.migrate().unwrap();
        assert_eq!(db.search_camera_events("parcel", &all()).unwrap().len(), 1);
        db.set_camera_event_judgement(id, Some("A courier."), AlertLevel::Normal, "A delivery.")
            .unwrap();
        assert_eq!(
            db.search_camera_events("delivery", &all()).unwrap().len(),
            1
        );
        assert_eq!(db.search_camera_events("parcel", &all()).unwrap().len(), 1);
        // Running it again changes nothing.
        db.migrate().unwrap();
        assert_eq!(db.search_camera_events("courier", &all()).unwrap().len(), 1);
    }
}
