//! Mutex locking that survives a panic elsewhere.

use std::sync::{Mutex, MutexGuard};

/// `lock_or_recover` for `std::sync::Mutex`.
///
/// A panic inside any critical section poisons the mutex, and with a bare
/// `.lock().unwrap()` every later caller panics too: one bad request takes
/// the remote server, the audio recorder or the search stats down for the
/// rest of the session. The data behind these locks is plain in-memory state
/// that is never left half-written in a way worse than losing the feature,
/// so recovering the guard is the better failure. `db::Database::conn` made
/// the same call for the SQLite handle.
pub trait LockExt<T> {
    fn lock_or_recover(&self) -> MutexGuard<'_, T>;
}

impl<T> LockExt<T> for Mutex<T> {
    fn lock_or_recover(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(|poisoned| {
            log::warn!("recovered from a poisoned mutex");
            poisoned.into_inner()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn a_poisoned_lock_still_hands_out_its_data() {
        let m = Arc::new(Mutex::new(1));
        let m2 = Arc::clone(&m);
        let _ = std::thread::spawn(move || {
            let _g = m2.lock().unwrap();
            panic!("poison it");
        })
        .join();
        assert!(m.is_poisoned());
        *m.lock_or_recover() += 1;
        assert_eq!(*m.lock_or_recover(), 2);
    }
}
