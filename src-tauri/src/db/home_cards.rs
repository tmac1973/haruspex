//! The Home tab's cards, and the recent-runs list its Jobs card shows.

use super::*;
use rusqlite::params;

/// One card on the Home tab. `config` and `last_result` are JSON text the
/// card type reads; the app does not look inside them here.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct HomeCard {
    pub id: String,
    pub card_type: String,
    #[ts(type = "number | null")]
    pub job_id: Option<i64>,
    #[ts(type = "number")]
    pub position: i64,
    /// `"normal"` or `"wide"`.
    pub size: String,
    pub config: String,
    pub notify: bool,
    pub last_result: Option<String>,
    #[ts(type = "number | null")]
    pub updated_at: Option<i64>,
    #[ts(type = "number")]
    pub created_at: i64,
}

/// A run of any job, with its job's name and type, for the Jobs card.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct RecentRun {
    #[ts(type = "number")]
    pub id: i64,
    #[ts(type = "number")]
    pub job_id: i64,
    pub job_name: String,
    pub job_type: String,
    pub status: String,
    pub trigger: String,
    #[ts(type = "number")]
    pub queued_at: i64,
    #[ts(type = "number | null")]
    pub started_at: Option<i64>,
    #[ts(type = "number | null")]
    pub finished_at: Option<i64>,
}

const CARD_COLS: &str = "id, card_type, job_id, position, size, config, notify, last_result,
     updated_at, created_at";

fn card_from_row(row: &rusqlite::Row) -> rusqlite::Result<HomeCard> {
    Ok(HomeCard {
        id: row.get(0)?,
        card_type: row.get(1)?,
        job_id: row.get(2)?,
        position: row.get(3)?,
        size: row.get(4)?,
        config: row.get(5)?,
        notify: row.get::<_, i64>(6)? != 0,
        last_result: row.get(7)?,
        updated_at: row.get(8)?,
        created_at: row.get(9)?,
    })
}

impl Database {
    /// Every card, in display order.
    pub fn list_home_cards(&self) -> Result<Vec<HomeCard>, String> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {CARD_COLS} FROM home_cards ORDER BY position, created_at"
            ))
            .map_err(|e| format!("Home cards query failed: {e}"))?;
        let rows = stmt
            .query_map([], card_from_row)
            .map_err(|e| format!("Home cards query failed: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Home card row read failed: {e}"))
    }

    /// Add a card at the end and return it.
    pub fn create_home_card(
        &self,
        id: &str,
        card_type: &str,
        job_id: Option<i64>,
        size: &str,
        config: &str,
    ) -> Result<HomeCard, String> {
        let conn = self.conn();
        conn.execute(
            "INSERT INTO home_cards (id, card_type, job_id, position, size, config, created_at)
             VALUES (?1, ?2, ?3,
                     (SELECT COALESCE(MAX(position), -1) + 1 FROM home_cards),
                     ?4, ?5, ?6)",
            params![id, card_type, job_id, size, config, chrono_now()],
        )
        .map_err(|e| format!("Home card insert failed: {e}"))?;
        conn.query_row(
            &format!("SELECT {CARD_COLS} FROM home_cards WHERE id = ?1"),
            params![id],
            card_from_row,
        )
        .map_err(|e| format!("Home card read failed: {e}"))
    }

    /// Change the fields given; `None` leaves a field as it is.
    pub fn update_home_card(
        &self,
        id: &str,
        size: Option<&str>,
        config: Option<&str>,
        notify: Option<bool>,
    ) -> Result<(), String> {
        self.conn()
            .execute(
                "UPDATE home_cards SET
                     size = COALESCE(?2, size),
                     config = COALESCE(?3, config),
                     notify = COALESCE(?4, notify)
                 WHERE id = ?1",
                params![id, size, config, notify.map(i64::from)],
            )
            .map_err(|e| format!("Home card update failed: {e}"))?;
        Ok(())
    }

    /// Store a fetched card's latest result (meetings, weather) and when it
    /// was fetched, so the card shows it at once on the next launch.
    pub fn set_home_card_result(
        &self,
        id: &str,
        last_result: &str,
        updated_at: i64,
    ) -> Result<(), String> {
        self.conn()
            .execute(
                "UPDATE home_cards SET last_result = ?2, updated_at = ?3 WHERE id = ?1",
                params![id, last_result, updated_at],
            )
            .map_err(|e| format!("Home card result update failed: {e}"))?;
        Ok(())
    }

    pub fn delete_home_card(&self, id: &str) -> Result<(), String> {
        self.conn()
            .execute("DELETE FROM home_cards WHERE id = ?1", params![id])
            .map_err(|e| format!("Home card delete failed: {e}"))?;
        Ok(())
    }

    /// Put the cards in the order given. A card left out of `ids` keeps its
    /// place relative to the others, after the ones listed.
    pub fn reorder_home_cards(&self, ids: &[String]) -> Result<(), String> {
        let mut conn = self.conn();
        let tx = conn
            .transaction()
            .map_err(|e| format!("Transaction failed: {e}"))?;
        tx.execute(
            "UPDATE home_cards SET position = position + ?1",
            params![ids.len() as i64],
        )
        .map_err(|e| format!("Home card reorder failed: {e}"))?;
        for (i, id) in ids.iter().enumerate() {
            tx.execute(
                "UPDATE home_cards SET position = ?1 WHERE id = ?2",
                params![i as i64, id],
            )
            .map_err(|e| format!("Home card reorder failed: {e}"))?;
        }
        tx.commit().map_err(|e| format!("Commit failed: {e}"))
    }

    /// The newest runs across every job, by when they last changed.
    pub fn list_recent_runs(&self, limit: i64) -> Result<Vec<RecentRun>, String> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare(
                "SELECT r.id, r.job_id, j.name, j.job_type, r.status, r.trigger, r.queued_at,
                        r.started_at, r.finished_at
                 FROM job_runs r JOIN jobs j ON j.id = r.job_id
                 ORDER BY COALESCE(r.finished_at, r.started_at, r.queued_at) DESC, r.id DESC
                 LIMIT ?1",
            )
            .map_err(|e| format!("Recent runs query failed: {e}"))?;
        let rows = stmt
            .query_map(params![limit], |row| {
                Ok(RecentRun {
                    id: row.get(0)?,
                    job_id: row.get(1)?,
                    job_name: row.get(2)?,
                    job_type: row.get(3)?,
                    status: row.get(4)?,
                    trigger: row.get(5)?,
                    queued_at: row.get(6)?,
                    started_at: row.get(7)?,
                    finished_at: row.get(8)?,
                })
            })
            .map_err(|e| format!("Recent runs query failed: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Recent run row read failed: {e}"))
    }
}
