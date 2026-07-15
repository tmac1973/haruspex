//! Classify llama-server log lines into the small set of signals the
//! supervisor cares about: "is this a GPU-init failure?" (the
//! supervisor stashes the line as the CPU-fallback reason and respawns
//! on CPU after the child exits) and "is this a context/KV-cache
//! allocation failure?" (the supervisor backs the context size down
//! one ladder rung and retries on the same device).
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

/// Known-benign lines that contain error words but signal nothing wrong.
/// llama.cpp's auto-fit step (`common_fit_params`) logs "failed to fit
/// params to free device memory: n_gpu_layers already set by user to 99,
/// abort" on every start because we pass --n-gpu-layers explicitly — the
/// "abort" is the fit *step* declining to override our value, after which
/// loading proceeds normally. Without this exclusion the line matches the
/// GPU patterns ("gpu" + "fail") and arms a spurious CPU fallback.
const BENIGN_PATTERNS: &[&str] = &["common_fit_params", "failed to fit params"];

/// Substring patterns that flag a line as a *context-dependent*
/// allocation failure — the KV cache and compute buffers are the parts
/// of llama-server's memory footprint that scale with `--ctx-size`, so
/// these are the failures a smaller context can actually fix. Weights
/// that don't fit fail earlier with device-alloc lines that match only
/// the GPU patterns, and keep going straight to CPU fallback.
const CTX_ALLOC_ERROR_PATTERNS: &[&str] = &[
    "kv cache",
    "kv buffer",
    "compute buffer",
    "failed to initialize the context",
    "failed to create context",
];

/// What a log line means to the supervisor. `None` is the common case
/// (plain progress logs flow straight to the ring buffer without
/// triggering any state change).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum LogSignal {
    /// Line contains a context-allocation pattern AND a generic error
    /// word. The supervisor backs the context size down one rung and
    /// retries. Checked before `GpuError` — KV-cache failure lines
    /// (e.g. "failed to initialize the context") also match the GPU
    /// patterns, and retrying with a smaller context on the GPU beats
    /// falling back to CPU.
    CtxAllocError,
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
    let has_error_word =
        lower.contains("error") || lower.contains("fail") || lower.contains("not found");
    if !has_error_word {
        return LogSignal::None;
    }
    if BENIGN_PATTERNS.iter().any(|p| lower.contains(p)) {
        return LogSignal::None;
    }
    if CTX_ALLOC_ERROR_PATTERNS.iter().any(|p| lower.contains(p)) {
        return LogSignal::CtxAllocError;
    }
    if GPU_ERROR_PATTERNS.iter().any(|p| lower.contains(p)) {
        return LogSignal::GpuError;
    }
    LogSignal::None
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
    fn detect_ctx_alloc_error() {
        assert_eq!(
            classify("llama_kv_cache_unified: failed to allocate buffer for kv cache"),
            LogSignal::CtxAllocError
        );
        assert_eq!(
            classify("llama_init_from_model: failed to initialize the context"),
            LogSignal::CtxAllocError
        );
        assert_eq!(
            classify(
                "ggml_gallocr_reserve_n: failed to allocate Vulkan0 compute buffer of size 12345"
            ),
            LogSignal::CtxAllocError
        );
        assert_eq!(
            classify("common_init_from_params: failed to create context with model 'foo.gguf'"),
            LogSignal::CtxAllocError
        );
    }

    #[test]
    fn ctx_alloc_takes_priority_over_gpu() {
        // A KV-cache failure on a GPU backend matches both pattern sets;
        // the context signal must win so the supervisor retries smaller
        // on the GPU instead of falling back to CPU.
        assert_eq!(
            classify("ggml_vulkan: failed to allocate buffer for kv cache"),
            LogSignal::CtxAllocError
        );
        // Weights-don't-fit device alloc stays a plain GPU error.
        assert_eq!(
            classify("ggml_vulkan: Device memory allocation of size 999 failed"),
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
        assert_eq!(
            classify("llama_kv_cache: size = 1024.00 MiB"),
            LogSignal::None,
            "KV-cache progress line without an error word should not match"
        );
    }

    #[test]
    fn fit_params_abort_is_benign() {
        // Logged on every start by newer llama.cpp builds because we pass
        // --n-gpu-layers explicitly; the model loads fine afterwards. Must
        // not arm the CPU fallback (it contains "gpu" + "fail").
        assert_eq!(
            classify(
                "common_fit_params: failed to fit params to free device memory: \
                 n_gpu_layers already set by user to 99, abort"
            ),
            LogSignal::None
        );
    }
}
