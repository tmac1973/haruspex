//! Classify llama-server log lines into the small set of signals the
//! supervisor cares about. Today that's just "is this a GPU-init
//! failure?" — when the answer is yes, the supervisor stashes the
//! line as the CPU-fallback reason and respawns on CPU after the
//! child exits.
//!
//! Extracted as a free function so the output-reader task in mod.rs
//! can match on a typed enum instead of an ad-hoc boolean, and so
//! the pattern list can be unit-tested without the rest of the
//! lifecycle machinery.

/// Substring patterns that — combined with a generic error word —
/// flag a stderr line as a GPU-init failure. Case-insensitive: the
/// classifier lowercases the line before matching.
const GPU_ERROR_PATTERNS: &[&str] = &[
    "vulkan",
    "vk_",
    "GGML_CUDA",
    "metal",
    "gpu",
    "failed to initialize",
    "no device found",
    "out of memory",
];

/// What a log line means to the supervisor. `None` is the common case
/// (plain progress logs flow straight to the ring buffer without
/// triggering any state change).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum LogSignal {
    /// Line contains a GPU-init pattern AND a generic error word
    /// ("error" / "fail" / "not found"). The supervisor uses this to
    /// (a) flag the current start as having tripped GPU init, and (b)
    /// preserve the first such line as the CPU-fallback reason.
    GpuError,
    /// Nothing actionable — just append to the log ring buffer.
    None,
}

/// Classify a single line of llama-server stderr/stdout.
pub(super) fn classify(line: &str) -> LogSignal {
    let lower = line.to_lowercase();
    let has_gpu_keyword = GPU_ERROR_PATTERNS.iter().any(|p| lower.contains(p));
    let has_error_word =
        lower.contains("error") || lower.contains("fail") || lower.contains("not found");
    if has_gpu_keyword && has_error_word {
        LogSignal::GpuError
    } else {
        LogSignal::None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_gpu_error_vulkan() {
        assert_eq!(
            classify("vulkan: failed to initialize device"),
            LogSignal::GpuError
        );
        assert_eq!(
            classify("VK_ERROR_OUT_OF_DEVICE_MEMORY: vulkan failed"),
            LogSignal::GpuError
        );
    }

    #[test]
    fn detect_gpu_error_metal() {
        assert_eq!(classify("metal device not found"), LogSignal::GpuError);
        assert_eq!(
            classify("Metal error: failed to compile"),
            LogSignal::GpuError
        );
    }

    #[test]
    fn detect_gpu_error_no_false_positives() {
        assert_eq!(classify("loading model from file"), LogSignal::None);
        assert_eq!(classify("server listening on port 8765"), LogSignal::None);
        assert_eq!(
            classify("error parsing config file"),
            LogSignal::None,
            "generic 'error' without a GPU keyword should not match"
        );
        assert_eq!(
            classify("vulkan extension supported"),
            LogSignal::None,
            "GPU keyword without an error word should not match"
        );
    }
}
