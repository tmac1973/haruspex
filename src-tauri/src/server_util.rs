//! What the two HTTPS servers (`owner::server`, `remote::server`) share.

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

/// A boxed future, for the servers' trait objects (`Dispatch`, `Host`): this
/// crate has no async-trait dependency.
pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// How long a stopping server may wait for its connections to finish before
/// they are cut. Event streams end by themselves on shutdown, so this is only
/// for a request still in flight.
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);

/// Wait up to [`SHUTDOWN_GRACE`] for a server's task to end, then abort it,
/// and return once it has: the caller may bind the same port next, and doing
/// that before the old server let go fails with "address already in use".
pub async fn join_or_abort(task: &mut tokio::task::JoinHandle<()>) {
    join_within(task, SHUTDOWN_GRACE).await;
}

async fn join_within(task: &mut tokio::task::JoinHandle<()>, grace: Duration) {
    if tokio::time::timeout(grace, &mut *task).await.is_err() {
        task.abort();
        let _ = task.await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn aborts_a_task_that_outlives_the_grace() {
        let mut task = tokio::spawn(std::future::pending::<()>());
        join_within(&mut task, Duration::from_millis(10)).await;
        assert!(task.is_finished());
    }

    #[tokio::test]
    async fn waits_for_a_task_that_ends_in_time() {
        let mut task = tokio::spawn(async {});
        join_or_abort(&mut task).await;
        assert!(task.is_finished());
    }
}
