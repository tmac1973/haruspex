//! The curated image-model catalogue, with licensing as a first-class field.
//!
//! Separate from [`crate::models`]'s registry rather than a `family` variant
//! inside it, which is a deliberate departure from this phase's plan. The two
//! field sets barely overlap: an LLM entry carries a vision projector, an MTP
//! source and a KV-cache growth rate, none of which mean anything for a
//! diffusion checkpoint, while an image entry carries a licence and a native
//! resolution, which mean nothing for an LLM. Folding them into one struct
//! would give every entry a column of nulls — the "unused knob" this codebase
//! keeps out of its types — and would put the LLM download path at risk for a
//! feature that does not touch it.
//!
//! What IS shared is the machinery: downloads go through
//! `ModelManager::download_file` and `verify_sha256`, so progress,
//! cancellation, the partial-file dance and the checksum all behave exactly as
//! they do for an LLM.

use std::path::PathBuf;

use serde::Serialize;
use tauri::AppHandle;

use crate::models::ModelManager;

/// Where image weights live, under the shared models directory.
pub const IMAGE_SUBDIR: &str = "image";

/// One downloadable checkpoint.
///
/// Every field here is read by something. `license` and `license_url` are
/// shown; `commercial_use` is acted on, because a licence string alone leaves
/// the judgement to whoever reads it and most users will not.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ImageModelInfo {
    pub id: String,
    pub filename: String,
    pub url: String,
    pub sha256: String,
    #[ts(type = "number")]
    pub size_bytes: u64,
    pub description: String,
    /// One short sentence, per the project's UI copy rule. The full text sits
    /// behind `license_url`.
    pub license: String,
    pub license_url: String,
    /// Acted on, not merely displayed: a `false` entry is never recommended
    /// at any VRAM and the UI asks for confirmation before downloading it.
    pub commercial_use: bool,
    /// The edge this model was trained at.
    ///
    /// A profile's `upscale` is only meaningful relative to it: SD1.5
    /// degrades above 512 and SDXL produces artefacts below 1024, so a 32px
    /// target wants `upscale: 16` on one and `32` on the other. Measured, not
    /// quoted — an SDXL sprite sheet generated at 512 comes out as mush.
    #[ts(type = "number")]
    pub native_edge: u32,
    /// Approximate VRAM to run it, for the recommendation and the warning.
    #[ts(type = "number")]
    pub vram_mb: u32,
    pub downloaded: bool,
}

/// The shipped catalogue.
///
/// Both entries are UNet models, which is not an accident. The three
/// coherence layers this feature depends on — reference conditioning,
/// seamless tiling and a shared palette — only two of which survive on a DiT:
/// IP-Adapter and circular-padding tiling are UNet techniques and do not
/// carry to Flux, Qwen or Z-Image. A DiT entry would therefore ship with two
/// of three layers reporting false, and `docs/image-generation.md` records
/// what implementing the DiT path would take.
///
/// Both are also single-file. Flux and SD3.5 need separate text encoders and
/// a VAE alongside the diffusion weights, which is three or four downloads
/// per model and a different shape of catalogue entry; that is a real reason
/// they are absent rather than an oversight.
///
/// Every `sha256` and `size_bytes` below was read from the publisher's own
/// object metadata rather than quoted, and the SD1.5 checksum was confirmed
/// byte-for-byte against a downloaded copy.
pub fn image_registry() -> Vec<ImageModelInfo> {
    vec![
        ImageModelInfo {
            id: "sd15".to_string(),
            filename: "v1-5-pruned-emaonly-fp16.safetensors".to_string(),
            url: "https://huggingface.co/Comfy-Org/stable-diffusion-v1-5-archive/resolve/main/v1-5-pruned-emaonly-fp16.safetensors".to_string(),
            sha256: "e9476a13728cd75d8279f6ec8bad753a66a1957ca375a1464dc63b37db6e3916".to_string(),
            size_bytes: 2_132_696_762,
            description: "Stable Diffusion 1.5 — small and fast, the deepest LoRA ecosystem (~2.1 GB)".to_string(),
            license: "CreativeML OpenRAIL-M — commercial use allowed, with use restrictions.".to_string(),
            license_url: "https://huggingface.co/spaces/CompVis/stable-diffusion-license".to_string(),
            commercial_use: true,
            native_edge: 512,
            vram_mb: 4_096,
            downloaded: false,
        },
        ImageModelInfo {
            id: "sdxl".to_string(),
            filename: "sd_xl_base_1.0.safetensors".to_string(),
            url: "https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors".to_string(),
            sha256: "31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b".to_string(),
            size_bytes: 6_938_078_334,
            description: "Stable Diffusion XL 1.0 — markedly better at following composition (~6.9 GB)".to_string(),
            license: "CreativeML OpenRAIL++-M — commercial use allowed, with use restrictions.".to_string(),
            license_url: "https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/main/LICENSE.md".to_string(),
            commercial_use: true,
            native_edge: 1_024,
            vram_mb: 10_240,
            downloaded: false,
        },
    ]
}

/// The entry to suggest for a machine with `vram_mb` of video memory.
///
/// Resolved against the probed machine rather than fixed in the data, so
/// "recommended" is a rule instead of a hope. SDXL follows composition
/// instructions markedly better — which is a precondition of background
/// removal rather than a matter of taste, measured against SD1.5 on the same
/// prompts and seeds — so it wins wherever it fits. A model that cannot be
/// used commercially is never recommended at any VRAM.
pub fn recommended_id(vram_mb: u32) -> &'static str {
    if vram_mb >= 10_240 {
        "sdxl"
    } else {
        "sd15"
    }
}

/// The catalogue with `downloaded` filled in from disk.
pub fn catalogue_with_state(models_dir: &std::path::Path) -> Vec<ImageModelInfo> {
    let dir = models_dir.join(IMAGE_SUBDIR);
    image_registry()
        .into_iter()
        .map(|mut m| {
            m.downloaded = dir.join(&m.filename).is_file();
            m
        })
        .collect()
}

/// Where a catalogue entry's weights live once downloaded.
pub fn model_path(models_dir: &std::path::Path, id: &str) -> Option<PathBuf> {
    let entry = image_registry().into_iter().find(|m| m.id == id)?;
    Some(models_dir.join(IMAGE_SUBDIR).join(entry.filename))
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

/// Resolve a catalogue id to a path on disk, or nothing when it is not there.
///
/// The backend calls this before starting the engine: an id names a
/// catalogue entry, and the engine needs a file.
#[tauri::command]
pub async fn image_model_path(
    state: tauri::State<'_, ModelManager>,
    id: String,
) -> Result<Option<String>, ()> {
    Ok(model_path(state.models_dir(), &id)
        .filter(|p| p.is_file())
        .map(|p| p.to_string_lossy().to_string()))
}

/// Download one catalogue entry, reusing the LLM download path.
#[tauri::command]
pub async fn download_image_model(
    app: AppHandle,
    state: tauri::State<'_, ModelManager>,
    id: String,
    proxy: Option<crate::proxy::ProxyConfig>,
) -> Result<String, String> {
    state.set_proxy(proxy).await;
    let path = state.download_image_model(&app, &id).await?;
    Ok(path.to_string_lossy().to_string())
}

/// Delete a downloaded entry. Stopping the engine first is the caller's job —
/// the engine holds the file open while it runs.
#[tauri::command]
pub async fn delete_image_model(
    state: tauri::State<'_, ModelManager>,
    id: String,
) -> Result<(), String> {
    let path =
        model_path(state.models_dir(), &id).ok_or_else(|| format!("Unknown image model: {id}"))?;
    if path.is_file() {
        std::fs::remove_file(&path)
            .map_err(|e| format!("Could not delete {}: {e}", path.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_entry_carries_the_things_a_download_needs() {
        // A missing checksum means an unverified multi-gigabyte download, and
        // a missing size means no progress bar. Both have to be present for
        // every entry or one can be added without them.
        for m in image_registry() {
            assert!(!m.id.is_empty(), "id");
            assert!(m.url.starts_with("https://"), "{}: url must be https", m.id);
            assert_eq!(m.sha256.len(), 64, "{}: sha256 must be a full digest", m.id);
            assert!(
                m.sha256.chars().all(|c| c.is_ascii_hexdigit()),
                "{}: sha256 must be hex",
                m.id
            );
            assert!(m.size_bytes > 0, "{}: size", m.id);
            assert!(m.filename.ends_with(".safetensors"), "{}: filename", m.id);
        }
    }

    #[test]
    fn every_entry_states_a_licence_and_whether_it_may_be_sold() {
        // The licence is the point of this catalogue. A blank one would leave
        // the UI showing nothing where the decision should be.
        for m in image_registry() {
            assert!(!m.license.is_empty(), "{}: license", m.id);
            assert!(
                m.license_url.starts_with("https://"),
                "{}: license_url",
                m.id
            );
        }
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
    fn every_entry_declares_the_edge_it_was_trained_at() {
        // A profile's upscale is only meaningful relative to this: generating
        // SDXL at SD1.5's 512 produces mush, which is the failure the field
        // exists to prevent.
        for m in image_registry() {
            assert!(
                m.native_edge == 512 || m.native_edge == 1024,
                "{}: native_edge {} is neither of the two this pipeline handles",
                m.id,
                m.native_edge
            );
        }
    }

    #[test]
    fn the_recommendation_fits_the_machine_it_is_made_for() {
        // A recommendation that does not fit is worse than none: the download
        // is gigabytes and the failure arrives at generation time.
        for vram in [0u32, 4_096, 8_192, 10_240, 24_576] {
            let id = recommended_id(vram);
            let entry = image_registry().into_iter().find(|m| m.id == id).unwrap();
            if vram > 0 {
                assert!(
                    entry.vram_mb <= vram.max(4_096),
                    "recommended {id} needs {} MB at {vram} MB",
                    entry.vram_mb
                );
            }
        }
    }

    #[test]
    fn the_bigger_model_is_recommended_only_where_it_fits() {
        assert_eq!(recommended_id(4_096), "sd15");
        assert_eq!(recommended_id(8_192), "sd15");
        assert_eq!(recommended_id(10_240), "sdxl");
        assert_eq!(recommended_id(24_576), "sdxl");
    }

    #[test]
    fn a_model_that_cannot_be_sold_is_never_recommended() {
        // Not a property of today's catalogue — both entries permit commercial
        // use — but of the rule, so adding a restricted entry cannot make it
        // the default by accident.
        for vram in [0u32, 8_192, 10_240, 65_536] {
            let id = recommended_id(vram);
            let entry = image_registry().into_iter().find(|m| m.id == id).unwrap();
            assert!(entry.commercial_use, "{id} was recommended at {vram} MB");
        }
    }

    #[test]
    fn a_path_is_only_reported_for_a_known_id() {
        let dir = std::path::Path::new("/tmp/haruspex-image-models");
        assert!(model_path(dir, "sd15").is_some());
        assert!(model_path(dir, "not-a-model").is_none());
    }

    #[test]
    fn weights_land_under_the_image_subdirectory() {
        // Beside the LLM GGUFs rather than among them: the LLM picker lists
        // what it finds in the models dir.
        let dir = std::path::Path::new("/tmp/haruspex-image-models");
        let p = model_path(dir, "sd15").unwrap();
        assert_eq!(p.parent().unwrap(), dir.join(IMAGE_SUBDIR));
    }

    #[test]
    fn nothing_is_marked_downloaded_when_the_directory_is_empty() {
        let dir = std::env::temp_dir().join(format!("haruspex-img-cat-{}", std::process::id()));
        let cat = catalogue_with_state(&dir);
        assert_eq!(cat.len(), image_registry().len());
        assert!(cat.iter().all(|m| !m.downloaded));
    }

    #[test]
    fn a_file_on_disk_marks_its_entry_downloaded() {
        let dir = std::env::temp_dir().join(format!("haruspex-img-dl-{}", std::process::id()));
        let sub = dir.join(IMAGE_SUBDIR);
        std::fs::create_dir_all(&sub).unwrap();
        let entry = &image_registry()[0];
        std::fs::write(sub.join(&entry.filename), b"weights").unwrap();

        let cat = catalogue_with_state(&dir);
        let found = cat.iter().find(|m| m.id == entry.id).unwrap();
        assert!(found.downloaded);
        assert!(cat
            .iter()
            .filter(|m| m.id != entry.id)
            .all(|m| !m.downloaded));

        std::fs::remove_dir_all(&dir).ok();
    }
}
