//! On-device text embeddings (fastembed / ONNX Runtime, BGE-small-en-v1.5).
//!
//! One process-wide model, loaded lazily and kept warm: the first embed pays
//! a few hundred milliseconds of ONNX session setup, every later one is
//! milliseconds. `TextEmbedding::embed` takes `&mut self` and there is a
//! single ONNX session behind it, so the model lives inside a `Mutex` and
//! calls serialize — which is also what we want, since the callers are
//! background extraction and per-send recall, never a hot loop.
//!
//! Everything here is CPU-bound and must only ever be called from
//! `spawn_blocking` (see the arboard lesson in `maintenance.md`: blocking the
//! main thread freezes WebKitGTK).
//!
//! The model is NOT downloaded implicitly. `embed` fails when it is absent;
//! the consent flow (Phase 02) is the only thing that calls `ensure_model`.
//! For a privacy-focused app, a background HTTP fetch from Hugging Face is
//! not something to do on the user's behalf without asking.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use fastembed::{EmbeddingModel, TextEmbedding, TextInitOptions};

/// Written to `memories.embedding_model` on every insert, and matched on at
/// search time — a future model swap then degrades to "older memories are
/// invisible until re-embedded" rather than to garbage cosine scores between
/// vectors from different embedding spaces.
pub const EMBEDDING_MODEL_NAME: &str = "bge-small-en-v1.5-q";

/// The Hugging Face repo fastembed pulls the ONNX weights from, mirrored here
/// so `model_present` can answer without initializing anything.
///
/// The QUANTIZED build, deliberately. The fp32 variant fastembed calls
/// `BGESmallENV15` is a 127 MB download; this one is 67 MB for the same 384
/// dimensions, and the accuracy it gives up is invisible in the job it does
/// here — ranking a few thousand short facts by relevance. The download is
/// something the user has to agree to, so halving it is worth more than the
/// last percent of retrieval quality.
const MODEL_REPO: &str = "Qdrant/bge-small-en-v1.5-onnx-Q";

/// hf-hub's on-disk name for that repo: `models--<org>--<name>`.
const MODEL_REPO_DIR: &str = "models--Qdrant--bge-small-en-v1.5-onnx-Q";

/// The weights file inside that repo — what `model_present` looks for.
const MODEL_FILE: &str = "model_optimized.onnx";

static EMBEDDER: Mutex<Option<TextEmbedding>> = Mutex::new(None);

/// Where the ONNX weights live, given the app data dir.
pub fn cache_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("models").join("embeddings")
}

/// The directory fastembed will actually use.
///
/// `HF_HOME` wins over the configured cache dir inside fastembed, so
/// `model_present` has to honour it too — otherwise the presence check and
/// the loader would disagree on a machine that sets it, and the app would
/// report a missing model it can see perfectly well.
fn effective_cache_dir(configured: &Path) -> PathBuf {
    std::env::var_os("HF_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| configured.to_path_buf())
}

/// Whether the weights are on disk. Pure file check — no ONNX init, no
/// network, safe to call on every settings render.
pub fn model_present(cache_dir: &Path) -> bool {
    let repo = effective_cache_dir(cache_dir).join(MODEL_REPO_DIR);
    // hf-hub stores blobs under snapshots/<revision>/…, and the revision is
    // not knowable without the network, so look for the file rather than
    // reconstructing the path.
    find_model_file(&repo, 0)
}

/// Depth-bounded search for the weights file under an hf-hub repo directory.
///
/// Bounded because this runs on a directory the user could have put anything
/// in; `snapshots/<rev>/onnx/model.onnx` is three levels, so four is plenty
/// and a symlink loop cannot walk forever.
fn find_model_file(dir: &Path, depth: usize) -> bool {
    if depth > 4 {
        return false;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if find_model_file(&path, depth + 1) {
                return true;
            }
        } else if path.file_name().is_some_and(|n| n == MODEL_FILE) {
            return true;
        }
    }
    false
}

/// Download the weights if they aren't already cached, and load them.
///
/// The only function here that may touch the network, and it is called from
/// exactly one place: the explicit consent flow. Blocking and slow (~65 MB)
/// — `spawn_blocking` only.
pub fn ensure_model(cache_dir: &Path) -> Result<(), String> {
    let mut guard = lock();
    if guard.is_some() {
        return Ok(());
    }
    *guard = Some(load(cache_dir, true)?);
    Ok(())
}

/// Embed one or more texts, loading the model on first use.
///
/// Fails rather than downloading when the weights are absent: the caller is
/// a background pass or a chat send, neither of which is a moment to start a
/// 65 MB fetch the user never agreed to.
pub fn embed(cache_dir: &Path, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }
    let mut guard = lock();
    if guard.is_none() {
        if !model_present(cache_dir) {
            return Err(
                "The embedding model has not been downloaded yet — enable memory in Settings."
                    .to_string(),
            );
        }
        *guard = Some(load(cache_dir, false)?);
    }
    let model = guard
        .as_mut()
        .expect("embedder was just initialized above or returned early");
    model
        .embed(texts, None)
        .map_err(|e| format!("Embedding failed: {e}"))
}

/// Drop the loaded model, freeing its ONNX session.
///
/// Used when memory is switched off: an idle ONNX session is tens of MB of
/// resident memory doing nothing, on a machine the user may have told us is
/// short of it.
pub fn unload() {
    *lock() = None;
}

fn load(cache_dir: &Path, allow_download: bool) -> Result<TextEmbedding, String> {
    let dir = effective_cache_dir(cache_dir);
    if allow_download {
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Could not create the embedding model cache dir: {e}"))?;
    }
    let options = TextInitOptions::new(EmbeddingModel::BGESmallENV15Q)
        .with_cache_dir(dir)
        // Progress is reported through the consent flow's own UI, not by
        // scribbling a bar into a terminal nobody is looking at.
        .with_show_download_progress(false);
    TextEmbedding::try_new(options).map_err(|e| {
        format!("Could not load the embedding model ({MODEL_REPO}) — {e}. Re-download it from Settings if the cache is damaged.")
    })
}

fn lock() -> std::sync::MutexGuard<'static, Option<TextEmbedding>> {
    // A panic inside an embed would otherwise poison this for the rest of the
    // session, turning one bad input into permanently broken memory. The
    // model itself stays valid across an unwind.
    EMBEDDER.lock().unwrap_or_else(|poisoned| {
        log::warn!("recovered from a poisoned embedder mutex");
        poisoned.into_inner()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn cache_dir_is_under_the_app_data_dir() {
        let dir = cache_dir(Path::new("/home/u/.local/share/haruspex"));
        assert!(dir.ends_with("models/embeddings"));
    }

    #[test]
    fn model_present_is_false_for_an_empty_or_missing_dir() {
        assert!(!model_present(Path::new(
            "/nonexistent/haruspex/embeddings"
        )));
        let tmp = std::env::temp_dir().join("haruspex-embed-empty");
        let _ = fs::create_dir_all(&tmp);
        assert!(!model_present(&tmp));
    }

    #[test]
    fn model_present_finds_the_weights_under_an_hf_hub_snapshot() {
        let tmp = std::env::temp_dir().join("haruspex-embed-present");
        let snapshot = tmp.join(MODEL_REPO_DIR).join("snapshots").join("abc123");
        fs::create_dir_all(&snapshot).unwrap();
        fs::write(snapshot.join(MODEL_FILE), b"not really onnx").unwrap();
        assert!(model_present(&tmp));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn model_present_ignores_other_files_in_the_repo_dir() {
        // A half-finished download leaves the tokenizer and config behind
        // without the weights; reporting that as present would send the user
        // to a load error instead of the download button.
        let tmp = std::env::temp_dir().join("haruspex-embed-partial");
        let snapshot = tmp.join(MODEL_REPO_DIR).join("snapshots").join("abc123");
        fs::create_dir_all(&snapshot).unwrap();
        fs::write(snapshot.join("tokenizer.json"), b"{}").unwrap();
        assert!(!model_present(&tmp));
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn embedding_an_empty_slice_needs_no_model() {
        // Callers batch; an empty batch must not be an error, and must not
        // drag the ONNX session in on a machine that has no model at all.
        assert_eq!(embed(Path::new("/nonexistent"), &[]).unwrap().len(), 0);
    }

    #[test]
    fn embed_refuses_rather_than_downloading_when_the_model_is_absent() {
        let err = embed(
            Path::new("/nonexistent/haruspex/embeddings"),
            &["hello".to_string()],
        )
        .unwrap_err();
        assert!(err.contains("not been downloaded"), "got: {err}");
    }

    /// Needs the real ~65 MB model, so it is not part of `cargo test`.
    /// Run with: `cargo test -- --ignored embeds_paraphrases_closer`
    #[test]
    #[ignore = "requires the downloaded ONNX model"]
    fn embeds_paraphrases_closer_than_unrelated_text() {
        let dir = cache_dir(Path::new(
            &std::env::var("HARUSPEX_APP_DATA").expect("set HARUSPEX_APP_DATA to the app data dir"),
        ));
        let vectors = embed(
            &dir,
            &[
                "I prefer tabs over spaces for indentation".to_string(),
                "My indentation preference is tabs, not spaces".to_string(),
                "The capital of France is Paris".to_string(),
            ],
        )
        .unwrap();
        assert_eq!(vectors[0].len(), crate::memory::EMBEDDING_DIM);

        let paraphrase = crate::memory::cosine_similarity(&vectors[0], &vectors[1]).unwrap();
        let unrelated = crate::memory::cosine_similarity(&vectors[0], &vectors[2]).unwrap();
        assert!(
            paraphrase > unrelated,
            "paraphrase {paraphrase} should beat unrelated {unrelated}"
        );
    }
}
