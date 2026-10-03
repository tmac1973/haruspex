//! The bundled engine's image models, with licensing as a first-class field.
//!
//! Separate from [`crate::models`]'s registry rather than a `family` variant
//! inside it: an LLM entry carries a vision projector, an MTP source and a
//! KV-cache growth rate, none of which mean anything here, while an image
//! entry carries a licence and several files with distinct roles.
//!
//! Each entry is a SET of files — the diffusion model, its text encoder, its
//! VAE and, for Ming, a tokenizer — because both models this engine runs ship
//! them separately. SD1.5 and SDXL, the single-file checkpoints this catalogue
//! started with, are gone: their output was not worth shipping
//! (`plan/local-image-generation/measurements-phase-24-gguf.md`).
//!
//! The weights are GGUF, not the int8/bf16 safetensors ComfyUI uses. On Vulkan
//! without bf16 support those ran at ~40-120 s a step; GGUF runs a 1024 sheet
//! in about 35-50 s. Ming has no published GGUF, so ours is converted from
//! Comfy-Org's bf16 files and hosted on Hugging Face (MIT permits it).
//!
//! Downloads go through `ModelManager::download_into`, so progress, resume,
//! cancellation and the SHA-256 check behave exactly as they do for an LLM.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::AppHandle;

use crate::models::ModelManager;

/// Where image weights live, under the shared models directory. Each entry
/// gets its own folder beneath this.
pub const IMAGE_SUBDIR: &str = "image";

/// What a file is for. Each maps to one sd-server flag.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum ImageFileRole {
    Diffusion,
    TextEncoder,
    Vae,
    Tokenizer,
}

impl ImageFileRole {
    /// The sd-server flag that takes this file.
    pub fn flag(self) -> &'static str {
        match self {
            Self::Diffusion => "--diffusion-model",
            Self::TextEncoder => "--llm",
            Self::Vae => "--vae",
            Self::Tokenizer => "--tokenizer",
        }
    }
}

#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ImageModelFile {
    pub role: ImageFileRole,
    pub filename: String,
    pub url: String,
    pub sha256: String,
    #[ts(type = "number")]
    pub size_bytes: u64,
}

/// One downloadable model.
///
/// Every field here is read by something. `license` and `license_url` are
/// shown; `commercial_use` is acted on, because a licence string alone leaves
/// the judgement to whoever reads it and most users will not.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ImageModelInfo {
    pub id: String,
    /// The family `image/comfyui/families.ts` names: how a request is built.
    pub family: String,
    pub description: String,
    /// One short sentence, per the project's UI copy rule. The full text sits
    /// behind `license_url`.
    pub license: String,
    pub license_url: String,
    /// Acted on, not merely displayed: a `false` entry is never recommended
    /// and the UI asks for confirmation before downloading it.
    pub commercial_use: bool,
    /// The edge it generates at natively. Sheets are drawn at 1024.
    #[ts(type = "number")]
    pub native_edge: u32,
    /// Approximate VRAM to run it, for the recommendation and the warning.
    #[ts(type = "number")]
    pub vram_mb: u32,
    pub files: Vec<ImageModelFile>,
    /// Sum of `files`.
    #[ts(type = "number")]
    pub size_bytes: u64,
    /// True when every file is on disk.
    pub downloaded: bool,
}

const MING_GGUF: &str =
    "https://huggingface.co/voltaire321/Ming-Image-0.1-Design-GGUF/resolve/main";

fn file(role: ImageFileRole, url: &str, sha256: &str, size_bytes: u64) -> ImageModelFile {
    ImageModelFile {
        role,
        filename: url.rsplit('/').next().unwrap_or(url).to_string(),
        url: url.to_string(),
        sha256: sha256.to_string(),
        size_bytes,
    }
}

fn entry(
    id: &str,
    family: &str,
    description: &str,
    license: (&str, &str),
    commercial_use: bool,
    vram_mb: u32,
    files: Vec<ImageModelFile>,
) -> ImageModelInfo {
    ImageModelInfo {
        id: id.into(),
        family: family.into(),
        description: description.into(),
        license: license.0.into(),
        license_url: license.1.into(),
        commercial_use,
        native_edge: 1024,
        vram_mb,
        size_bytes: files.iter().map(|f| f.size_bytes).sum(),
        files,
        downloaded: false,
    }
}

/// The shipped catalogue. Every `sha256` and `size_bytes` was read from the
/// publisher's Hugging Face metadata (the LFS `oid`), and the GGUFs were
/// checked byte-for-byte against the files measured.
pub fn image_registry() -> Vec<ImageModelInfo> {
    use ImageFileRole::*;
    vec![
        entry(
            "ming",
            "ming",
            "Ming-Image 0.1 Design — transparent sprites, the default (~17 GB)",
            (
                "MIT — commercial use allowed.",
                "https://huggingface.co/inclusionAI/Ming-Image-0.1-Design",
            ),
            true,
            // Measured: 7.2 GB peak with the text encoder on the CPU, which
            // then needs ~10 GB of RAM.
            8_192,
            vec![
                file(
                    Diffusion,
                    &format!("{MING_GGUF}/ming_image_0.1_design-Q8_0.gguf"),
                    "260ded24503b35b80b6eb4a5949f664b26f6c00b46e8ec6e6d00942593eb120b",
                    6_541_979_808,
                ),
                file(
                    TextEncoder,
                    &format!("{MING_GGUF}/ming_ling_mini_2.0-Q4_K.gguf"),
                    "70f7ea31d3e1ffa917e70b961e5d422b2a8b19327c3522033a381b1a4b766002",
                    10_518_620_096,
                ),
                file(
                    Vae,
                    "https://huggingface.co/Comfy-Org/Ming-Image/resolve/main/vae/ming_image_vae_bf16.safetensors",
                    "7f5bed402dc8c77dc2e0ab1929a85d4df433b7cf7b599dfa8c353da98db0b90a",
                    253_816_696,
                ),
                file(
                    Tokenizer,
                    "https://huggingface.co/inclusionAI/Ming-Image-0.1-Design/resolve/main/mllm/tokenizer.json",
                    "e7ff01708d504f7bf4dbf7f5815adde57bab9a40e7f563ab6ad1acace4464917",
                    12_210_709,
                ),
            ],
        ),
        entry(
            "qwen21",
            "qwen21",
            "Qwen-Image 2.1 — transparent by prompt, non-commercial (~10 GB)",
            (
                "Qwen Research License — research and evaluation only.",
                "https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE",
            ),
            false,
            10_240,
            vec![
                file(
                    Diffusion,
                    "https://huggingface.co/leejet/Qwen-Image-2.1-GGUF/resolve/main/qwen_image_2.1-Q4_K.gguf",
                    "29f9c83c249ff0292fb2943fceddfa2319b446601866c82a4f8be062abea72c2",
                    4_197_494_816,
                ),
                file(
                    TextEncoder,
                    "https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct-GGUF/resolve/main/Qwen3VL-8B-Instruct-Q4_K_M.gguf",
                    "67d1659bfe71b89d50b45a4ad1a9e5b997e5bb16ce5da66a6a6167abd569e9e2",
                    5_027_784_800,
                ),
                file(
                    Vae,
                    "https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/vae/qwen_image_2.1_vae_bf16.safetensors",
                    "bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9",
                    675_509_688,
                ),
            ],
        ),
    ]
}

/// The entry to suggest. Only one can be: Qwen-Image-2.1 may not be used
/// commercially, and a model that cannot be is never recommended.
pub fn recommended_id(_vram_mb: u32) -> &'static str {
    "ming"
}

/// The folder an entry's files live in.
pub fn model_dir(models_dir: &Path, id: &str) -> PathBuf {
    models_dir.join(IMAGE_SUBDIR).join(id)
}

/// The catalogue with `downloaded` filled in from disk.
pub fn catalogue_with_state(models_dir: &Path) -> Vec<ImageModelInfo> {
    image_registry()
        .into_iter()
        .map(|mut m| {
            let dir = model_dir(models_dir, &m.id);
            m.downloaded = m.files.iter().all(|f| dir.join(&f.filename).is_file());
            m
        })
        .collect()
}

/// What sd-server needs to load an entry: each file's flag and path, plus the
/// entry's own options. `None` for an unknown id or a set not fully on disk.
pub fn engine_args(models_dir: &Path, id: &str) -> Option<Vec<String>> {
    let entry = image_registry().into_iter().find(|m| m.id == id)?;
    let dir = model_dir(models_dir, id);
    let mut args = Vec::new();
    for f in &entry.files {
        let path = dir.join(&f.filename);
        if !path.is_file() {
            return None;
        }
        args.push(f.role.flag().to_string());
        args.push(path.to_string_lossy().to_string());
    }
    // Flash attention in the diffusion model: measured with it for both.
    args.push("--diffusion-fa".to_string());
    // Ming's text encoder on the CPU. Faster, not slower: with it on the GPU
    // sd.cpp keeps its 9.3 GB of weights in RAM and copies them over each
    // time — 39 s a sheet and 9.4 GB of VRAM, against 27 s and 7.2 GB.
    if entry.family == "ming" {
        args.push("--backend".to_string());
        args.push("te=cpu".to_string());
    }
    // Qwen's VAE (Wan's) needs ~5.4 GB to ENCODE a 1024 image, and with Qwen's
    // weights loaded only ~4 GB is left on a 16 GB card: every img2img — the
    // seam pass on a texture — failed at once with "vae encode compute
    // failed". Tiled, it fits. txt2img never encodes, so sprites were fine.
    if entry.family == "qwen21" {
        args.push("--vae-tiling".to_string());
    }
    Some(args)
}

// Tauri commands

#[tauri::command]
pub async fn image_models(
    state: tauri::State<'_, ModelManager>,
) -> Result<Vec<ImageModelInfo>, ()> {
    Ok(catalogue_with_state(state.models_dir()))
}

#[tauri::command]
pub async fn image_model_recommended(vram_mb: u32) -> Result<String, ()> {
    Ok(recommended_id(vram_mb).to_string())
}

/// Download every file of one entry that is not already on disk, each
/// verified. Progress arrives as `download-progress` events, one file at a time.
#[tauri::command]
pub async fn download_image_model(
    app: AppHandle,
    state: tauri::State<'_, ModelManager>,
    id: String,
    proxy: Option<crate::proxy::ProxyConfig>,
) -> Result<(), String> {
    let entry = image_registry()
        .into_iter()
        .find(|m| m.id == id)
        .ok_or_else(|| format!("Unknown image model: {id}"))?;
    let _slot = state.begin_download(&format!("image:{id}"))?;
    let dir = model_dir(state.models_dir(), &id);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    state.set_proxy(proxy).await;
    state.reset_cancel().await;
    let count = entry.files.len();
    for (i, f) in entry.files.iter().enumerate() {
        // "2 of 4" in the label, so a screen can say which file it is on.
        let of = format!("{} of {count}: {}", i + 1, f.filename);
        state
            .download_into(
                &app,
                &f.url,
                &dir,
                &f.filename,
                f.size_bytes,
                &f.sha256,
                &format!("Downloading {of}"),
                &format!("Verifying {of}"),
            )
            .await?;
    }
    Ok(())
}

/// Delete an entry's files. Stopping the engine first is the caller's job —
/// the engine holds them open while it runs.
#[tauri::command]
pub async fn delete_image_model(
    state: tauri::State<'_, ModelManager>,
    id: String,
) -> Result<(), String> {
    if !image_registry().iter().any(|m| m.id == id) {
        return Err(format!("Unknown image model: {id}"));
    }
    let dir = model_dir(state.models_dir(), &id);
    if dir.is_dir() {
        std::fs::remove_dir_all(&dir)
            .map_err(|e| format!("Could not delete {}: {e}", dir.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_file_can_be_downloaded_and_verified() {
        // A missing checksum means an unverified multi-gigabyte download, and
        // a missing size means no progress bar.
        for m in image_registry() {
            assert!(!m.files.is_empty(), "{}", m.id);
            for f in &m.files {
                assert!(f.url.starts_with("https://huggingface.co/"), "{}", f.url);
                assert!(f.url.ends_with(&f.filename), "{}", f.url);
                assert_eq!(f.sha256.len(), 64, "{}", f.filename);
                assert!(f.sha256.chars().all(|c| c.is_ascii_hexdigit()));
                assert!(f.size_bytes > 0, "{}", f.filename);
            }
            assert_eq!(
                m.size_bytes,
                m.files.iter().map(|f| f.size_bytes).sum::<u64>()
            );
        }
    }

    #[test]
    fn every_entry_has_the_files_its_family_needs() {
        use ImageFileRole::*;
        for m in image_registry() {
            let roles: Vec<ImageFileRole> = m.files.iter().map(|f| f.role).collect();
            for need in [Diffusion, TextEncoder, Vae] {
                assert!(roles.contains(&need), "{}: {need:?}", m.id);
            }
            // Ming's Ling text encoder carries no tokenizer of its own.
            assert_eq!(m.family == "ming", roles.contains(&Tokenizer), "{}", m.id);
        }
    }

    #[test]
    fn every_entry_states_a_licence_and_whether_it_may_be_sold() {
        for m in image_registry() {
            assert!(!m.license.is_empty(), "{}", m.id);
            assert!(m.license_url.starts_with("https://"), "{}", m.id);
        }
        let r = image_registry();
        assert!(r.iter().find(|m| m.id == "ming").unwrap().commercial_use);
        assert!(!r.iter().find(|m| m.id == "qwen21").unwrap().commercial_use);
    }

    #[test]
    fn ids_are_unique() {
        let mut ids: Vec<String> = image_registry().into_iter().map(|m| m.id).collect();
        let before = ids.len();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), before);
    }

    #[test]
    fn a_model_that_cannot_be_sold_is_never_recommended() {
        for vram in [0u32, 8_192, 16_384, 65_536] {
            let id = recommended_id(vram);
            let entry = image_registry().into_iter().find(|m| m.id == id).unwrap();
            assert!(entry.commercial_use, "{id} was recommended at {vram} MB");
        }
    }

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("haruspex-img-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn an_entry_is_downloaded_only_when_every_file_is_there() {
        let dir = temp("partial");
        let m = image_registry()
            .into_iter()
            .find(|m| m.id == "ming")
            .unwrap();
        let sub = model_dir(&dir, "ming");
        std::fs::create_dir_all(&sub).unwrap();
        for f in &m.files[..m.files.len() - 1] {
            std::fs::write(sub.join(&f.filename), b"x").unwrap();
        }
        let ming = |d: &Path| {
            catalogue_with_state(d)
                .into_iter()
                .find(|m| m.id == "ming")
                .unwrap()
        };
        assert!(!ming(&dir).downloaded, "one file short");
        assert!(engine_args(&dir, "ming").is_none());
        std::fs::write(sub.join(&m.files.last().unwrap().filename), b"x").unwrap();
        assert!(ming(&dir).downloaded);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_engine_gets_one_flag_per_file_in_the_entrys_own_folder() {
        let dir = temp("args");
        let m = image_registry()
            .into_iter()
            .find(|m| m.id == "ming")
            .unwrap();
        let sub = model_dir(&dir, "ming");
        std::fs::create_dir_all(&sub).unwrap();
        for f in &m.files {
            std::fs::write(sub.join(&f.filename), b"x").unwrap();
        }
        let args = engine_args(&dir, "ming").unwrap();
        let after = |flag: &str| args[args.iter().position(|a| a == flag).unwrap() + 1].clone();
        assert!(after("--diffusion-model").ends_with("image/ming/ming_image_0.1_design-Q8_0.gguf"));
        assert!(after("--llm").ends_with("ming_ling_mini_2.0-Q4_K.gguf"));
        assert!(after("--vae").ends_with("ming_image_vae_bf16.safetensors"));
        assert!(after("--tokenizer").ends_with("tokenizer.json"));
        assert!(args.contains(&"--diffusion-fa".to_string()));
        assert_eq!(
            after("--backend"),
            "te=cpu",
            "Ming's text encoder runs on the CPU"
        );
        assert!(engine_args(&dir, "not-a-model").is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn qwen_encodes_in_tiles_and_ming_does_not() {
        // Qwen's VAE cannot encode a 1024 image untiled beside its weights on a
        // 16 GB card; every img2img (the seam pass) failed.
        let dir = temp("tiling");
        for id in ["ming", "qwen21"] {
            let m = image_registry().into_iter().find(|m| m.id == id).unwrap();
            let sub = model_dir(&dir, id);
            std::fs::create_dir_all(&sub).unwrap();
            for f in &m.files {
                std::fs::write(sub.join(&f.filename), b"x").unwrap();
            }
        }
        let tiles = |id: &str| {
            engine_args(&dir, id)
                .unwrap()
                .contains(&"--vae-tiling".into())
        };
        assert!(tiles("qwen21"));
        assert!(!tiles("ming"));
        std::fs::remove_dir_all(&dir).ok();
    }
}
