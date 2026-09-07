//! Screen capture.
//!
//! # This is never polled
//!
//! There is no timer, no interval, no watcher and no background variant
//! anywhere in this module. Every capture starts from a call the user made:
//! either they pressed the capture button in the composer, or they asked the
//! assistant a question and it called `capture_screen` in reply. A test in this
//! file reads the module's own source and fails if a timer ever appears, so
//! that guarantee survives the next person to edit it.
//!
//! The gate is enforced twice on the frontend — the tool is dropped from the
//! model's tool list when the Settings toggle is off, *and* `executeTool`
//! refuses it before dispatch — because a small model will occasionally emit a
//! call for a tool it was never offered.
//!
//! # Per platform
//!
//! - **Linux** — the XDG desktop portal, via [`linux`]. The portal's own picker
//!   is not an obstacle to work around: it *is* the user-initiated guarantee,
//!   enforced by the compositor rather than promised by us. A bare X11 session
//!   with no portal running falls back to reading the root window directly.
//! - **macOS / Windows** — [`xcap`], via [`external`]. Deviation from the plan,
//!   which named ScreenCaptureKit and Win32 directly: xcap's backends are
//!   exactly those APIs, and taking them as a dependency trades a page of
//!   unsafe code that cannot be tested from here for one that is exercised by
//!   everyone else who uses the crate. It is *not* used on Linux, where it
//!   would drag in pipewire and libwayshot for no gain over the portal.

pub mod screenshot;

#[cfg(target_os = "linux")]
mod linux;

#[cfg(any(target_os = "macos", target_os = "windows"))]
mod external;

#[cfg(test)]
mod tests {
    /// Every source file in this module, for the never-polled check below.
    ///
    /// Read unconditionally, including the platform files this build does not
    /// compile: the guarantee is about the module, and a timer added to the
    /// macOS path should fail on the Linux machine where it was written.
    const SOURCES: [(&str, &str); 4] = [
        ("mod.rs", include_str!("mod.rs")),
        ("screenshot.rs", include_str!("screenshot.rs")),
        ("linux.rs", include_str!("linux.rs")),
        ("external.rs", include_str!("external.rs")),
    ];

    /// Capture is never on a timer, and the source proves it.
    ///
    /// The point of this test is not that a timer would be a bug — it is that
    /// "the app only looks at your screen when you ask it to" has to be
    /// checkable by reading the code, and stay true after the next edit. A
    /// spawned task or an interval here would break that promise quietly.
    #[test]
    fn nothing_in_this_module_runs_on_a_timer() {
        // Written apart so this test does not trip over its own needles when
        // it reads mod.rs, which it does.
        let forbidden = [
            concat!("interval", "("),
            concat!("sleep", "("),
            concat!("spawn", "("),
            concat!("set", "Interval"),
            concat!("set", "Timeout"),
        ];
        for (name, source) in SOURCES {
            // Strip comments: this file discusses timers at length, and a
            // comment saying "there is no timer here" is not a timer.
            let code: String = source
                .lines()
                .filter(|l| !l.trim_start().starts_with("//"))
                .collect::<Vec<_>>()
                .join("\n");
            for needle in forbidden {
                assert!(
                    !code.contains(needle),
                    "{name} contains `{needle}` — screen capture must only ever \
                     happen because the user just asked for it"
                );
            }
        }
    }
}
