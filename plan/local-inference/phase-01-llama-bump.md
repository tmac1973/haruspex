# Phase 01 — llama.cpp v0.6.0 and build hardening

## Steps

### 1. Bump the pin
`LLAMA_CPP_VERSION` → `v0.6.0`. The version stamp (`build-sidecars.sh:38`,
`:212`) triggers the rebuild on dev machines and CI.

### 2. Fail on a missing tag
`build-sidecars.sh:220-221`: drop the fallback to `master`. A failed tag clone
exits non-zero with the tag name in the message. Same check for whisper if it
shares the pattern.

### 3. Audit every flag we emit against v0.6.0 `common/arg.cpp`
`build_args_for` (`server/mod.rs:102-182`) and `build_llama_args`
(`:412-434`): `--ctx-size`, `--n-gpu-layers`, `--cache-type-k/v`,
`--parallel`, `--jinja`, `--host`, `--flash-attn on|off`, `--ctx-checkpoints`,
`--model-draft`, `--spec-draft-ngl all`, `--spec-draft-n-max`,
`--spec-type draft-mtp`, `--mmproj`, `--no-mmproj-offload`. Record the result
in the commit message, as the v0.3.0 bump did.

### 4. Re-check the Windows checkpoint workaround
`--ctx-checkpoints 0` is for llama.cpp#27560. If it closed before v0.6.0, drop
the workaround and its test; otherwise update the comment's "still open as of".

### 5. whisper ABI check
whisper-server runs against llama.cpp's `libggml` (`build-sidecars.sh:255-263`,
`:333-356`). Confirm whisper v1.9.2 still loads and transcribes against the new
ggml; if not, bump `WHISPER_CPP_VERSION` in this phase.

### 6. Log classifier
Re-run the `log_classifier.rs` tests and skim a real v0.6.0 startup log for new
lines containing "gpu"/"fail"/"error" that would arm a false CPU fallback
(the d1800ef trap).

## Verify
- `cargo test`, `cargo clippy -D warnings`.
- Hand: start each shipped model once on Linux/Vulkan (MTP on for Gemma 12B
  and Qwen 3.8 27B, checking acceptance in the log), one voice transcription.
- CI's `build-sidecars.yml` green on all three platforms.

No user-visible change: label the PR `no-docs`.

## Results (2026-10-08, Linux, RX 7900 XTX, RADV)

- Every flag we emit is accepted by v0.6.0 `common/arg.cpp`; none are in the
  removed-arg list. `draft-mtp` is still the type name.
- #27560 is still open, but the reporter saw the crash stop at b11026 and
  v0.6.0 is b11429. Workaround kept until a Windows run confirms.
- v0.6.0 ships ggml 0.26.0. whisper v1.9.2 loads against it on Vulkan and
  transcribes correctly, so `WHISPER_CPP_VERSION` stays.
- Log format changed: lines are now `<time> <I|W|E> <tag> ...` and the default
  verbosity no longer prints device or tensor-offload lines. The classifier
  matches substrings, so it is unaffected; nothing else parses those lines. The
  fit-abort warning still appears and is still filtered.
- Smoke tests, with our exact flags:
  - Qwen3.5-4B IQ4_NL + mmproj at 32K: 152 tok/s.
  - Qwen3.8-27B UD-IQ4_XS with MTP at 8K: 108 tok/s, draft acceptance 95%.
- Not covered here: Gemma 12B sibling drafter (not downloaded), Windows, macOS.
