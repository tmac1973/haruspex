//! Lemonade (lemonade-server.ai) as an image server.
//!
//! Lemonade runs stable-diffusion.cpp — the engine the bundled image backend
//! runs — as its `sd-cpp` recipe, on a server the user keeps, so it runs the
//! bundled engine's own catalogue (`image_models.rs`): the same GGUF files,
//! registered on the server through `/api/v1/pull`.
//!
//! Its HTTP calls go through `comfy.rs`'s client, which sends no `Origin` and
//! carries the bearer key; Lemonade's `allowed_origins` is empty by default,
//! so the webview could not call it directly any more than it could ComfyUI.
//!
//! Two things Lemonade's sd-cpp recipe does not do for a model, which install
//! does instead by saving `sdcpp_args` on it:
//!
//! - It maps only the `main`, `text_encoder` and `vae` checkpoints to flags.
//!   Ming also needs `--tokenizer`, so the tokenizer is pulled as a fourth
//!   role (Lemonade downloads any role) and its path, in Lemonade's Hugging
//!   Face cache, is passed by hand. The path holds the snapshot's commit, which
//!   `/api/v1/models/{id}/files` does not report, so it is asked of Hugging
//!   Face and checked by loading the model.
//! - It adds `--diffusion-fa --vae-tiling` on Vulkan only. These models were
//!   measured with both, so they go in on every backend, with the rest of
//!   [`engine_options`].

use serde::Serialize;

use crate::comfy::{ComfyCall, ComfyError, ImageServer};
use crate::image_models::{engine_options, image_registry, ImageFileRole, ImageModelInfo};
use crate::proxy::ProxyConfig;

pub(crate) const LEMONADE: ImageServer = ImageServer {
    secret: "lemonade:key",
    name: "Lemonade",
};

/// A call whose answer is JSON (or text, or nothing). Cancelled with
/// `comfy_cancel`, whose table these calls share.
#[tauri::command]
pub async fn lemonade_json(call: ComfyCall) -> Result<serde_json::Value, ComfyError> {
    crate::comfy::json_from(call, LEMONADE).await
}

/// One catalogue entry, as Lemonade registers it.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct LemonadeModel {
    /// The catalogue id the setting holds: `ming` or `qwen21`.
    pub id: String,
    pub family: String,
    pub description: String,
    pub license: String,
    pub license_url: String,
    pub commercial_use: bool,
    #[ts(type = "number")]
    pub size_bytes: u64,
    /// The name it is registered under, `user.` and all; what a request names.
    pub name: String,
    /// The `/api/v1/pull` body that registers it, without `stream`.
    #[ts(type = "unknown")]
    pub pull: serde_json::Value,
}

/// The name an entry is registered under. Fixed rather than derived, because
/// it is how a server already set up is recognised.
fn registered_name(id: &str) -> String {
    match id {
        "ming" => "user.Ming-Image-0.1-Design-GGUF".into(),
        "qwen21" => "user.Qwen-Image-2.1-Turbo-GGUF".into(),
        other => format!("user.Haruspex-{other}"),
    }
}

/// `POST /api/v1/images/edits`: the form's fields as text parts, beside the
/// `image[]` pictures, read from the image cache here when named by hash.
#[tauri::command]
pub async fn lemonade_upload(
    app: tauri::AppHandle,
    db: tauri::State<'_, crate::db::Database>,
    call: ComfyCall,
    files: Vec<crate::comfy::UploadFile>,
) -> Result<serde_json::Value, ComfyError> {
    let parts = crate::comfy::resolve_uploads(
        &db,
        &crate::audio_cache::cache_dir(&app).map_err(|message| ComfyError::Invalid { message })?,
        &crate::image_cache::cache_dir(&app).map_err(|message| ComfyError::Invalid { message })?,
        files,
    )?;
    crate::comfy::upload_json(call, LEMONADE, parts, crate::comfy::FormShape::Fields).await
}

/// Lemonade's name for the checkpoint a role fills.
fn role_name(role: ImageFileRole) -> &'static str {
    match role {
        ImageFileRole::Diffusion => "main",
        ImageFileRole::TextEncoder => "text_encoder",
        ImageFileRole::Vae => "vae",
        ImageFileRole::Tokenizer => "tokenizer",
        ImageFileRole::Vision => "llm_vision",
    }
}

/// `owner/repo:path/in/repo` from a `huggingface.co/<owner>/<repo>/resolve/<rev>/<path>` URL.
fn checkpoint_of(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://huggingface.co/")?;
    let mut parts = rest.splitn(5, '/');
    let (owner, repo, resolve, _rev, path) = (
        parts.next()?,
        parts.next()?,
        parts.next()?,
        parts.next()?,
        parts.next()?,
    );
    (resolve == "resolve" && !path.is_empty()).then(|| format!("{owner}/{repo}:{path}"))
}

fn pull_body(entry: &ImageModelInfo) -> serde_json::Value {
    let checkpoints: serde_json::Map<String, serde_json::Value> = entry
        .files
        .iter()
        // Every file, the optional vision weights included: Lemonade pulls a
        // checkpoint of any role, and those it maps no flag to are passed by
        // path in `sdcpp_args` (see `lemonade_sdcpp_args`).
        .filter_map(|f| {
            let cp = checkpoint_of(&f.url)?;
            Some((role_name(f.role).to_string(), cp.into()))
        })
        .collect();
    serde_json::json!({
        "model_name": registered_name(&entry.id),
        "recipe": "sd-cpp",
        "labels": ["image"],
        "checkpoints": checkpoints,
    })
}

fn model_of(entry: &ImageModelInfo) -> LemonadeModel {
    LemonadeModel {
        id: entry.id.clone(),
        family: entry.family.clone(),
        description: entry.description.clone(),
        license: entry.license.clone(),
        license_url: entry.license_url.clone(),
        commercial_use: entry.commercial_use,
        // Everything the pull fetches, the optional vision weights too.
        size_bytes: entry.files.iter().map(|f| f.size_bytes).sum(),
        name: registered_name(&entry.id),
        pull: pull_body(entry),
    }
}

/// The models Lemonade can be given: the bundled engine's catalogue.
#[tauri::command]
pub fn lemonade_catalogue() -> Vec<LemonadeModel> {
    image_registry().iter().map(model_of).collect()
}

/// Where Lemonade's Hugging Face cache keeps `checkpoint` at `revision`, under
/// the server's model storage directory (`/api/v1/system-info`'s
/// `model_storage.path`). The layout is huggingface_hub's.
fn cached_path(storage: &str, checkpoint: &str, revision: &str) -> Option<String> {
    let (repo, path) = checkpoint.split_once(':')?;
    let (owner, name) = repo.split_once('/')?;
    let storage = storage.trim_end_matches(['/', '\\']);
    Some(format!(
        "{storage}/models--{owner}--{name}/snapshots/{revision}/{path}"
    ))
}

/// The commit a repo's `main` is at: the snapshot Lemonade pulled.
async fn main_revision(repo: &str, proxy: Option<&ProxyConfig>) -> Result<String, String> {
    let client = crate::proxy::apply_proxy(
        reqwest::Client::builder().timeout(std::time::Duration::from_secs(30)),
        proxy,
    )?
    .build()
    .map_err(|e| format!("Could not build an HTTP client: {e}"))?;
    let url = format!("https://huggingface.co/api/models/{repo}/revision/main");
    let res = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Could not ask Hugging Face about {repo}: {e}"))?;
    if !res.status().is_success() {
        return Err(format!(
            "Hugging Face answered {} about {repo}.",
            res.status()
        ));
    }
    let body: serde_json::Value = res
        .json()
        .await
        .map_err(|e| format!("Hugging Face's answer about {repo} was not JSON: {e}"))?;
    body.get("sha")
        .and_then(|s| s.as_str())
        .map(str::to_string)
        .ok_or_else(|| format!("Hugging Face did not say which commit {repo} is at."))
}

/// One argument for Lemonade's custom-argument parser: quoted when it holds
/// whitespace, as a path on a Windows server may.
fn arg(a: &str) -> String {
    if a.chars().any(char::is_whitespace) {
        format!("\"{a}\"")
    } else {
        a.to_string()
    }
}

/// The files sd-cpp has no checkpoint flag for, with where Lemonade put them:
/// Ming's tokenizer, and Qwen's vision weights, which it edits with.
const BY_PATH: [ImageFileRole; 2] = [ImageFileRole::Tokenizer, ImageFileRole::Vision];

fn sdcpp_args(entry: &ImageModelInfo, cached: &[(ImageFileRole, String)]) -> String {
    let mut args = Vec::new();
    for (role, path) in cached {
        args.push(role.flag().to_string());
        args.push(path.clone());
    }
    args.extend(engine_options(entry));
    args.iter().map(|a| arg(a)).collect::<Vec<_>>().join(" ")
}

/// The `sdcpp_args` to save on an entry once it is pulled. `storage` is the
/// server's model storage directory, which the tokenizer's and vision
/// weights' paths are under.
#[tauri::command]
pub async fn lemonade_sdcpp_args(
    id: String,
    storage: String,
    proxy: Option<ProxyConfig>,
) -> Result<String, String> {
    let entry = image_registry()
        .into_iter()
        .find(|m| m.id == id)
        .ok_or_else(|| format!("Unknown image model: {id}"))?;
    let mut cached = Vec::new();
    for f in entry.files.iter().filter(|f| BY_PATH.contains(&f.role)) {
        let cp = checkpoint_of(&f.url)
            .ok_or_else(|| format!("{} is not a Hugging Face file.", f.url))?;
        let repo = cp.split_once(':').map(|(r, _)| r).unwrap_or_default();
        let revision = main_revision(repo, proxy.as_ref()).await?;
        let path = cached_path(&storage, &cp, &revision)
            .ok_or_else(|| format!("Cannot place {cp} in Lemonade's cache."))?;
        cached.push((f.role, path));
    }
    Ok(sdcpp_args(&entry, &cached))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str) -> ImageModelInfo {
        image_registry().into_iter().find(|m| m.id == id).unwrap()
    }

    #[test]
    fn checkpoints_name_repo_and_path() {
        assert_eq!(
            checkpoint_of(
                "https://huggingface.co/Comfy-Org/Ming-Image/resolve/main/vae/ming_image_vae_bf16.safetensors"
            )
            .as_deref(),
            Some("Comfy-Org/Ming-Image:vae/ming_image_vae_bf16.safetensors")
        );
        assert_eq!(
            checkpoint_of("https://example.com/a/b/resolve/main/c"),
            None
        );
        assert_eq!(
            checkpoint_of("https://huggingface.co/a/b/blob/main/c"),
            None
        );
    }

    /// The body that registered Ming on asmodean by hand on 2026-10-23, and
    /// measured transparent: install must produce it, name and all, so a
    /// server set up that way is recognised as installed.
    #[test]
    fn ming_pulls_as_measured() {
        assert_eq!(
            pull_body(&entry("ming")),
            serde_json::json!({
                "model_name": "user.Ming-Image-0.1-Design-GGUF",
                "recipe": "sd-cpp",
                "labels": ["image"],
                "checkpoints": {
                    "main": "voltaire321/Ming-Image-0.1-Design-GGUF:ming_image_0.1_design-Q8_0.gguf",
                    "text_encoder": "voltaire321/Ming-Image-0.1-Design-GGUF:ming_ling_mini_2.0-Q4_K.gguf",
                    "vae": "Comfy-Org/Ming-Image:vae/ming_image_vae_bf16.safetensors",
                    "tokenizer": "inclusionAI/Ming-Image-0.1-Design:mllm/tokenizer.json"
                }
            })
        );
    }

    #[test]
    fn every_entry_maps_every_file() {
        for m in lemonade_catalogue() {
            let cps = m.pull["checkpoints"].as_object().unwrap();
            assert_eq!(cps.len(), entry(&m.id).files.len(), "{}", m.id);
            // Qwen's vision weights go in too, for editing.
            assert_eq!(cps.contains_key("llm_vision"), m.id == "qwen21", "{}", m.id);
            assert!(cps.contains_key("main"), "{}", m.id);
            assert!(m.name.starts_with("user."), "{}", m.id);
        }
    }

    #[test]
    fn the_tokenizer_is_found_in_the_hf_cache() {
        assert_eq!(
            cached_path(
                "/opt/var/lib/lemonade/.cache/huggingface/hub/",
                "inclusionAI/Ming-Image-0.1-Design:mllm/tokenizer.json",
                "c57c49689d12ef7d4e24a170014f1dc43d3ce258"
            )
            .as_deref(),
            Some(
                "/opt/var/lib/lemonade/.cache/huggingface/hub/models--inclusionAI--Ming-Image-0.1-Design/snapshots/c57c49689d12ef7d4e24a170014f1dc43d3ce258/mllm/tokenizer.json"
            )
        );
    }

    #[test]
    fn args_carry_the_tokenizer_and_the_engine_options() {
        let ming = entry("ming");
        let tok = [(ImageFileRole::Tokenizer, "/cache/tok.json".to_string())];
        let args = sdcpp_args(&ming, &tok);
        assert!(args.starts_with("--tokenizer /cache/tok.json "), "{args}");
        assert!(args.ends_with(&engine_options(&ming).join(" ")), "{args}");
        let vision = [(ImageFileRole::Vision, "/cache/mmproj.gguf".to_string())];
        let qwen = sdcpp_args(&entry("qwen21"), &vision);
        assert!(
            qwen.starts_with("--llm_vision /cache/mmproj.gguf "),
            "{qwen}"
        );
        assert!(!qwen.contains("--tokenizer"), "{qwen}");
        assert!(qwen.contains("--sigmas"), "{qwen}");
        let spaced = [(
            ImageFileRole::Tokenizer,
            "C:\\Lemonade Models\\tok.json".to_string(),
        )];
        assert_eq!(
            sdcpp_args(&ming, &spaced).split(' ').nth(1),
            Some("\"C:\\Lemonade")
        );
    }
}
