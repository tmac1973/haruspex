//! Running a detected browser headless, and cleaning up after it.
//!
//! Every flag here was earned during investigation; the comments say which
//! failure each one prevents, because all of them fail *silently* — the wrong
//! flag set produces an empty page rather than an error, which reads exactly
//! like a site that returned nothing.

use super::detect::DetectedBrowser;
use log::{info, warn};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// How long to wait for the browser to write its DevToolsActivePort file and
/// answer on the debugging port. Generous: a cold Chrome on a slow disk is the
/// worst case, and measured warm start is 0.19s.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);

/// Prefix for the throwaway profile directory. Also the marker used to sweep
/// browsers left behind by a crash — matching on this rather than on the
/// process name is what keeps the user's own Chrome untouched.
pub(crate) const PROFILE_PREFIX: &str = "haruspex-browser-";

/// A running headless browser, owned by the caller. Dropping it kills the
/// process and removes the profile.
pub(super) struct BrowserProcess {
    child: Option<Child>,
    profile_dir: PathBuf,
    /// Debugging port the browser actually bound (never assumed).
    pub(super) port: u16,
    /// Set once `close()` has run, so `Drop` does not repeat the work.
    closed: bool,
}

/// A plausible desktop Chrome user-agent for the detected version.
///
/// **Load-bearing, not cosmetic.** Without `--user-agent` the browser
/// advertises `HeadlessChrome/...`, and Startpage responds by silently
/// redirecting to its homepage: zero results, no error, nothing in the logs to
/// explain it. With an ordinary Chrome UA the identical URL renders ten
/// results. The major version is taken from the browser we actually launched
/// so the claim stays plausible as it updates, rather than pinning a number
/// that ages into a lie.
pub(super) fn user_agent_for(version_line: &str) -> String {
    let major = version_line
        .split_whitespace()
        .find_map(|token| token.split('.').next()?.parse::<u32>().ok())
        .unwrap_or(151);
    #[cfg(target_os = "windows")]
    let platform = "Windows NT 10.0; Win64; x64";
    #[cfg(target_os = "macos")]
    let platform = "Macintosh; Intel Mac OS X 10_15_7";
    #[cfg(all(unix, not(target_os = "macos")))]
    let platform = "X11; Linux x86_64";
    format!(
        "Mozilla/5.0 ({platform}) AppleWebKit/537.36 (KHTML, like Gecko) \
         Chrome/{major}.0.0.0 Safari/537.36"
    )
}

impl BrowserProcess {
    /// Launch `browser` headless and wait until its debugging port answers.
    pub(super) fn launch(browser: &DetectedBrowser) -> Result<Self, String> {
        let profile_dir = std::env::temp_dir().join(format!(
            "{PROFILE_PREFIX}{}",
            std::process::id()
                .wrapping_mul(2_654_435_761)
                .wrapping_add(Instant::now().elapsed().subsec_nanos())
        ));
        std::fs::create_dir_all(&profile_dir)
            .map_err(|e| format!("could not create browser profile dir: {e}"))?;

        let child = Command::new(&browser.path)
            .arg("--headless=new")
            .arg("--disable-gpu")
            // Never the user's profile: Chrome refuses to open one already in
            // use, and inheriting their cookies would leak session state to
            // every site we scrape.
            .arg(format!("--user-data-dir={}", profile_dir.display()))
            // 0 = let the OS choose; the real port is read back from
            // DevToolsActivePort rather than guessed, so we can't race another
            // process for a hard-coded number.
            .arg("--remote-debugging-port=0")
            // Chrome >=111 rejects the CDP WebSocket handshake with a 403
            // without this.
            .arg("--remote-allow-origins=*")
            .arg(format!("--user-agent={}", user_agent_for(&browser.version)))
            .arg("--no-first-run")
            .arg("--no-default-browser-check")
            .arg("--disable-extensions")
            .arg("--disable-background-networking")
            .arg("about:blank")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("could not launch {}: {e}", browser.path))?;

        let mut process = Self {
            child: Some(child),
            profile_dir,
            port: 0,
            closed: false,
        };
        process.port = process.wait_for_port()?;
        info!(
            "browser search: launched {} on debug port {}",
            browser.path, process.port
        );
        Ok(process)
    }

    /// Read the port the browser bound, from the file it writes into the
    /// profile once the debugging server is listening.
    fn wait_for_port(&mut self) -> Result<u16, String> {
        let port_file = self.profile_dir.join("DevToolsActivePort");
        let deadline = Instant::now() + STARTUP_TIMEOUT;
        loop {
            if let Some(child) = self.child.as_mut() {
                if let Ok(Some(status)) = child.try_wait() {
                    return Err(format!("browser exited during startup ({status})"));
                }
            }
            if let Ok(contents) = std::fs::read_to_string(&port_file) {
                if let Some(port) = parse_devtools_port(&contents) {
                    return Ok(port);
                }
            }
            if Instant::now() >= deadline {
                return Err("browser did not open a debugging port in time".to_string());
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }
}

impl BrowserProcess {
    /// Ask the browser to shut itself down, and wait for it to go.
    ///
    /// Killing the child handle is not enough and never was: Chrome re-execs
    /// during startup, so the process we spawned exits almost immediately and
    /// the real browser runs on reparented to init. `kill()` then lands on a
    /// pid that is already gone, and ten processes holding a gigabyte survive
    /// — observed directly after an integration run.
    ///
    /// `Browser.close` goes to the browser itself over CDP, which tears down
    /// its own tree (zygotes, renderers, GPU process) the way a user quitting
    /// it would. `Drop` keeps the kill as a backstop for the case where the
    /// browser is already unreachable.
    pub(super) async fn close(&mut self) {
        let closed = self.request_close().await;
        if let Err(e) = &closed {
            warn!("browser search: graceful close failed ({e}) — falling back to kill");
        }
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        remove_profile_with_retry(&self.profile_dir);
        self.closed = true;
    }

    async fn request_close(&self) -> Result<(), String> {
        let version: serde_json::Value =
            reqwest::get(format!("http://127.0.0.1:{}/json/version", self.port))
                .await
                .map_err(|e| format!("browser not answering: {e}"))?
                .json()
                .await
                .map_err(|e| format!("no version info: {e}"))?;
        let ws = version
            .get("webSocketDebuggerUrl")
            .and_then(|v| v.as_str())
            .ok_or("no debugger URL")?;
        let mut conn = super::cdp::CdpConnection::connect(ws).await?;
        // Browser.close returns as the browser is going away, so a transport
        // error here is success rather than failure.
        let _ = conn.call("Browser.close", serde_json::json!({})).await;

        // Give the tree a moment to actually exit before the caller decides
        // whether to kill.
        for _ in 0..40 {
            tokio::time::sleep(Duration::from_millis(50)).await;
            if reqwest::get(format!("http://127.0.0.1:{}/json/version", self.port))
                .await
                .is_err()
            {
                return Ok(());
            }
        }
        Err("browser still listening after close".to_string())
    }
}

/// First line of `DevToolsActivePort` is the port; the second is the browser's
/// WebSocket path. A truncated file mid-write must read as "not ready yet"
/// rather than as an error, so parsing failure is `None`.
pub(super) fn parse_devtools_port(contents: &str) -> Option<u16> {
    contents.lines().next()?.trim().parse().ok()
}

impl Drop for BrowserProcess {
    fn drop(&mut self) {
        if self.closed {
            return;
        }
        // Backstop only. `close()` is the real path — see its doc comment for
        // why killing the child handle alone leaves the browser running.
        warn!("browser search: dropped without a graceful close; killing");
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        remove_profile_with_retry(&self.profile_dir);
    }
}

/// Remove a profile directory, retrying briefly.
///
/// Waiting on the parent is not the same as the profile being closed: Chrome
/// runs a tree of zygote and renderer processes that keep writing for a
/// fraction of a second after the parent dies, and `remove_dir_all` then fails
/// with "directory not empty". Observed leaving ~250 MB behind on the first
/// implementation, which is what `sweep_stale_profiles` was meant to be a
/// backstop for rather than the primary mechanism.
fn remove_profile_with_retry(dir: &std::path::Path) {
    const ATTEMPTS: usize = 8;
    for attempt in 0..ATTEMPTS {
        match std::fs::remove_dir_all(dir) {
            Ok(()) => return,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
            Err(e) if attempt + 1 == ATTEMPTS => {
                // Not fatal: the next start's sweep collects it. Worth a line,
                // because these are hundreds of MB each.
                warn!(
                    "browser search: could not remove profile {} after {ATTEMPTS} attempts: {e}",
                    dir.display()
                );
            }
            Err(_) => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}

/// Remove profile directories left by a previous run that crashed before it
/// could clean up. Each is hundreds of MB, and nothing else will ever collect
/// them.
///
/// Matches on the profile-name prefix, never on process name: the user's own
/// Chrome must never be a candidate for cleanup.
pub(crate) fn sweep_stale_profiles() {
    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.starts_with(PROFILE_PREFIX) {
            continue;
        }
        // A profile in use has a live DevToolsActivePort; one from a dead run
        // does not, but we cannot tell cheaply and reliably here — age is the
        // safe proxy, and an hour is far longer than any search burst.
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .map(|t| {
                t.elapsed()
                    .map(|d| d > Duration::from_secs(3600))
                    .unwrap_or(false)
            })
            .unwrap_or(false);
        if stale {
            if let Err(e) = std::fs::remove_dir_all(entry.path()) {
                warn!("browser search: stale profile cleanup failed: {e}");
            } else {
                info!(
                    "browser search: removed stale profile {}",
                    entry.path().display()
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn devtools_port_reads_the_first_line() {
        assert_eq!(
            parse_devtools_port("57321\n/devtools/browser/abc-123\n"),
            Some(57321)
        );
    }

    /// The file is written in two steps, so a read can land mid-write. That
    /// has to read as "not ready", never as a failure.
    #[test]
    fn devtools_port_tolerates_a_partial_file() {
        assert_eq!(parse_devtools_port(""), None);
        assert_eq!(parse_devtools_port("\n"), None);
        assert_eq!(parse_devtools_port("not-a-port\n"), None);
    }

    /// Without this the browser announces HeadlessChrome and Startpage
    /// silently serves its homepage instead of results.
    #[test]
    fn user_agent_is_plausible_and_tracks_the_detected_version() {
        let ua = user_agent_for("Google Chrome 151.0.7922.137");
        assert!(ua.contains("Chrome/151.0.0.0"), "{ua}");
        assert!(!ua.contains("Headless"), "{ua}");
        assert!(ua.starts_with("Mozilla/5.0 ("), "{ua}");
    }

    #[test]
    fn user_agent_falls_back_when_the_version_is_unparseable() {
        let ua = user_agent_for("some unexpected output");
        assert!(ua.contains("Chrome/151.0.0.0"), "{ua}");
    }

    #[test]
    fn user_agent_handles_other_vendors() {
        // Chromium and Brave report differently; the major version is still
        // the first number in the line.
        assert!(user_agent_for("Chromium 151.0.7922.71").contains("Chrome/151"));
        assert!(user_agent_for("Brave Browser 1.93.134").contains("Chrome/1."));
    }
}
