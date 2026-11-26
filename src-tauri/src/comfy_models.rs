//! The files each ComfyUI model family needs, and putting them into a
//! ComfyUI on this machine.
//!
//! Separate from [`crate::image_models`], which is the bundled engine's
//! catalogue of single-file SD checkpoints. A DiT family here is three files —
//! the diffusion model, its text encoder and its VAE — each in its own ComfyUI
//! folder. The two lists do not overlap today; when the bundled engine runs
//! Ming (phase 24) they become one.
//!
//! Sizes and SHA-256 are Hugging Face's own (`/api/models/<repo>/tree`, the LFS
//! `oid`), so a download is verified against the publisher, not against a copy
//! we happened to have.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::comfy::{comfy_json, ComfyCall};
use crate::image_models::{
    filename_of, Licence, WeightFile, MING_LICENCE, MING_VAE, QWEN21_LICENCE, QWEN21_VAE, UPSCALER,
    UPSCALER_LICENCE,
};
use crate::models::{ModelManager, VerifiedFile};

/// A ComfyUI model folder kind, as `/internal/folder_paths` names it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum ComfyFolder {
    DiffusionModels,
    TextEncoders,
    Vae,
    UpscaleModels,
    Loras,
    AudioEncoders,
    Checkpoints,
    LatentUpscaleModels,
}

impl ComfyFolder {
    pub fn key(self) -> &'static str {
        match self {
            Self::DiffusionModels => "diffusion_models",
            Self::TextEncoders => "text_encoders",
            Self::Vae => "vae",
            Self::UpscaleModels => "upscale_models",
            Self::Loras => "loras",
            Self::AudioEncoders => "audio_encoders",
            Self::Checkpoints => "checkpoints",
            Self::LatentUpscaleModels => "latent_upscale_models",
        }
    }
}

#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ComfyModelFile {
    pub folder: ComfyFolder,
    pub filename: String,
    pub url: String,
    pub sha256: String,
    #[ts(type = "number")]
    pub size_bytes: u64,
}

/// What a set's model makes: Settings → Image generation lists one kind, Settings →
/// Video generation the other.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, ts_rs::TS)]
#[ts(export)]
#[serde(rename_all = "snake_case")]
pub enum ComfyModelKind {
    Image,
    Video,
}

/// Everything one family needs, with the licence a user decides by.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ComfyModelSet {
    /// The family `comfyui/families.ts` (or `videogen/comfyui/families.ts`)
    /// reads from a filename.
    pub family: String,
    pub kind: ComfyModelKind,
    pub label: String,
    pub license: String,
    pub license_url: String,
    /// Acted on: a `false` set asks for confirmation before anything downloads.
    pub commercial_use: bool,
    /// With the text encoder on the CPU, as the templates run it.
    #[ts(type = "number")]
    pub vram_mb: u32,
    #[ts(type = "number")]
    pub ram_mb: u32,
    pub files: Vec<ComfyModelFile>,
}

fn file(
    folder: ComfyFolder,
    repo: &str,
    path: &str,
    sha256: &str,
    size_bytes: u64,
) -> ComfyModelFile {
    let url = format!("https://huggingface.co/{repo}/resolve/main/{path}");
    ComfyModelFile {
        folder,
        filename: filename_of(&url),
        url,
        sha256: sha256.to_string(),
        size_bytes,
    }
}

/// A file both engines share, from `image_models`.
fn shared(folder: ComfyFolder, w: &WeightFile) -> ComfyModelFile {
    ComfyModelFile {
        folder,
        filename: filename_of(w.url),
        url: w.url.to_string(),
        sha256: w.sha256.to_string(),
        size_bytes: w.size_bytes,
    }
}

/// FLUX.2 klein 4B, the distilled model: ComfyUI only, for now.
pub const KLEIN_LICENCE: Licence = Licence {
    text: "Apache 2.0 — commercial use allowed.",
    url: "https://huggingface.co/black-forest-labs/FLUX.2-klein-4B",
    commercial_use: true,
};

/// Qwen-Image-Edit-2511: ComfyUI only, for now.
pub const QWEN_EDIT_LICENCE: Licence = Licence {
    text: "Apache 2.0 — commercial use allowed.",
    url: "https://huggingface.co/Qwen/Qwen-Image-Edit-2511",
    commercial_use: true,
};

/// The shipped sets: the files the templates were measured with.
pub fn comfy_model_sets() -> Vec<ComfyModelSet> {
    use ComfyFolder::*;
    const MING: &str = "Comfy-Org/Ming-Image";
    const QWEN: &str = "Comfy-Org/Qwen-Image-2.1";
    const KLEIN: &str = "Comfy-Org/Flux-2-Klein-4B";
    const QWEN_IMAGE: &str = "Comfy-Org/Qwen-Image";
    vec![
        ComfyModelSet {
            family: "ming".into(),
            kind: ComfyModelKind::Image,
            label: "Ming-Image 0.1 Design".into(),
            license: MING_LICENCE.text.into(),
            license_url: MING_LICENCE.url.into(),
            commercial_use: MING_LICENCE.commercial_use,
            // Phase 17 §5: ~7 GB VRAM, ~24 GB RAM with the encoder on the CPU.
            vram_mb: 8_192,
            ram_mb: 24_576,
            files: vec![
                file(
                    DiffusionModels,
                    MING,
                    "diffusion_models/ming_image_0.1_design_int8_convrot.safetensors",
                    "0d3f5bcc6d2cb830578ea6d0925b30b9fb66058bcb651cc8633e60760dceb1d0",
                    6_175_239_953,
                ),
                // w4a8, not int8: 12.8 GB against 19.5, and no difference to
                // alpha in the spike.
                file(
                    TextEncoders,
                    MING,
                    "text_encoders/ming_image_0.1_ling_mini_2.0_w4a8.safetensors",
                    "91de4cd0718bec1452b74ff3b0df0dfde280493dab384f0eb4007c18bf932ccd",
                    12_813_574_339,
                ),
                shared(Vae, &MING_VAE),
            ],
        },
        ComfyModelSet {
            family: "qwen21_turbo".into(),
            kind: ComfyModelKind::Image,
            label: "Qwen-Image 2.1 Turbo".into(),
            license: QWEN21_LICENCE.text.into(),
            license_url: QWEN21_LICENCE.url.into(),
            commercial_use: QWEN21_LICENCE.commercial_use,
            vram_mb: 10_240,
            ram_mb: 24_576,
            files: vec![
                // Turbo: 8 steps against the base model's 25, at no cost in
                // quality (`measurements-qwen-turbo.md`). A base model already
                // installed keeps running as `qwen21`.
                file(
                    DiffusionModels,
                    QWEN,
                    "diffusion_models/qwen_image_2.1_turbo_int8_convrot.safetensors",
                    "8144a0182964aa8403ad6dbc011db837304167d235161b9aabaa8532e967314c",
                    7_256_787_829,
                ),
                file(
                    TextEncoders,
                    QWEN,
                    "text_encoders/qwen3vl_8b_int8_convrot.safetensors",
                    "8bfd0f6e12abf2d2d697ecc888e5e90b0d6741d6708f05799f53afa560452e8f",
                    9_350_798_360,
                ),
                shared(Vae, &QWEN21_VAE),
            ],
        },
        ComfyModelSet {
            family: "flux2_klein".into(),
            kind: ComfyModelKind::Image,
            label: "FLUX.2 klein 4B".into(),
            license: KLEIN_LICENCE.text.into(),
            license_url: KLEIN_LICENCE.url.into(),
            commercial_use: KLEIN_LICENCE.commercial_use,
            vram_mb: 12_288,
            ram_mb: 16_384,
            files: vec![
                // BFL's own fp8, which ComfyUI's klein workflows load: half
                // the size of the bf16 Comfy-Org ships.
                file(
                    DiffusionModels,
                    "black-forest-labs/FLUX.2-klein-4b-fp8",
                    "flux-2-klein-4b-fp8.safetensors",
                    "97ed34fe0567e436200f2faee3939b88f2b5d99f8af2a4dc16532c4245c0ccb6",
                    4_070_624_520,
                ),
                file(
                    TextEncoders,
                    KLEIN,
                    "split_files/text_encoders/qwen_3_4b.safetensors",
                    "6c671498573ac2f7a5501502ccce8d2b08ea6ca2f661c458e708f36b36edfc5a",
                    8_044_982_048,
                ),
                // The klein repo's copy (Apache 2.0), not FLUX.2 dev's.
                file(
                    Vae,
                    KLEIN,
                    "split_files/vae/flux2-vae.safetensors",
                    "868fe7b343cc8f3a19dbcfcafbc3d5f888802be3f89bd81b65b3621a066ce8f3",
                    336_211_292,
                ),
            ],
        },
        ComfyModelSet {
            family: "qwen_edit_2511".into(),
            kind: ComfyModelKind::Image,
            label: "Qwen-Image-Edit-2511".into(),
            license: QWEN_EDIT_LICENCE.text.into(),
            license_url: QWEN_EDIT_LICENCE.url.into(),
            commercial_use: QWEN_EDIT_LICENCE.commercial_use,
            // A 20B model at int8: ComfyUI offloads what doesn't fit.
            vram_mb: 24_576,
            ram_mb: 32_768,
            files: vec![
                file(
                    DiffusionModels,
                    "Comfy-Org/Qwen-Image-Edit",
                    "split_files/diffusion_models/qwen_image_edit_2511_int8_convrot.safetensors",
                    "11b5af5ac601821d73930c84846c9a158e67177356daf927ce1c8d10f3963829",
                    20_499_083_824,
                ),
                file(
                    TextEncoders,
                    QWEN_IMAGE,
                    "split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors",
                    "cb5636d852a0ea6a9075ab1bef496c0db7aef13c02350571e388aea959c5c0b4",
                    9_384_670_680,
                ),
                file(
                    Vae,
                    QWEN_IMAGE,
                    "split_files/vae/qwen_image_vae.safetensors",
                    "a70580f0213e67967ee9c95f05bb400e8fb08307e017a924bf3441223e023d1f",
                    253_806_246,
                ),
                // 4 steps at CFG 1 instead of 20 at CFG 4 (Apache 2.0).
                file(
                    Loras,
                    "lightx2v/Qwen-Image-Edit-2511-Lightning",
                    "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors",
                    "22226e8d05d354bb356627d428809f5afd7819399b077238a2b70a82883a904f",
                    849_608_296,
                ),
            ],
        },
    ]
}

/// Wan 2.2, from the Comfy-Org repackaging its ComfyUI templates load.
pub const WAN22_LICENCE: Licence = Licence {
    text: "Apache 2.0 — commercial use allowed.",
    url: "https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B",
    commercial_use: true,
};

/// LTX-2.3: free for commercial use only below a revenue threshold, so not
/// counted as allowing it.
pub const LTX23_LICENCE: Licence = Licence {
    text: "LTX-2 Community License — commercial use only below its revenue threshold.",
    url: "https://huggingface.co/Lightricks/LTX-2.3",
    commercial_use: false,
};

/// The video sets, as `videogen/comfyui/families.ts` names their families:
/// the files ComfyUI 0.39's own Wan 2.2 and LTX-2.3 templates load. VRAM and
/// RAM are what a run needs with ComfyUI offloading what it can.
pub fn comfy_video_sets() -> Vec<ComfyModelSet> {
    use ComfyFolder::*;
    const WAN22: &str = "Comfy-Org/Wan_2.2_ComfyUI_Repackaged";
    const WAN21: &str = "Comfy-Org/Wan_2.1_ComfyUI_repackaged";
    let umt5 = || {
        file(
            TextEncoders,
            WAN21,
            "split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors",
            "c3355d30191f1f066b26d93fba017ae9809dce6c627dda5f6a66eaa651204f68",
            6_735_906_897,
        )
    };
    let wan21_vae = || {
        file(
            Vae,
            WAN22,
            "split_files/vae/wan_2.1_vae.safetensors",
            "2fc39d31359a4b0a64f55876d8ff7fa8d780956ae2cb13463b0223e15148976b",
            253_815_318,
        )
    };
    let wan = |family: &str, label: &str, vram_mb: u32, ram_mb: u32, files| ComfyModelSet {
        family: family.into(),
        kind: ComfyModelKind::Video,
        label: label.into(),
        license: WAN22_LICENCE.text.into(),
        license_url: WAN22_LICENCE.url.into(),
        commercial_use: WAN22_LICENCE.commercial_use,
        vram_mb,
        ram_mb,
        files,
    };
    vec![
        wan(
            "wan22_ti2v_5b",
            "Wan 2.2 TI2V 5B",
            12_288,
            24_576,
            vec![
                file(
                    DiffusionModels,
                    WAN22,
                    "split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors",
                    "456f901338bd9eadbded3828b819109a9b68e8a525ca5cf8d0049a69fcfeca1e",
                    9_999_658_848,
                ),
                umt5(),
                file(
                    Vae,
                    WAN22,
                    "split_files/vae/wan2.2_vae.safetensors",
                    "e40321bd36b9709991dae2530eb4ac303dd168276980d3e9bc4b6e2b75fed156",
                    1_409_400_960,
                ),
            ],
        ),
        wan(
            "wan22_i2v_14b",
            "Wan 2.2 I2V 14B",
            20_480,
            49_152,
            vec![
                file(
                    DiffusionModels,
                    WAN22,
                    "split_files/diffusion_models/wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors",
                    "6122e79d55e0f235698d11d657f3b196c5273c830da00b2b013c5a048d5e6a42",
                    14_294_742_832,
                ),
                file(
                    DiffusionModels,
                    WAN22,
                    "split_files/diffusion_models/wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors",
                    "5471a457b6ac404202a5fbe6c11595a3d5641fc766b00f38763f72303fffc21e",
                    14_294_742_832,
                ),
                umt5(),
                wan21_vae(),
                // Four steps instead of twenty (Apache 2.0).
                file(
                    Loras,
                    WAN22,
                    "split_files/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors",
                    "d176c808d6fc461999b68e321efcb7501b20b8c3797523ed0df14f7d1deff11e",
                    1_226_977_424,
                ),
                file(
                    Loras,
                    WAN22,
                    "split_files/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors",
                    "024f21de095bc8fad9809ded3e9e49a2e170dcf27075da8145ba7d60d8aab7f9",
                    1_226_977_424,
                ),
            ],
        ),
        wan(
            "wan22_s2v",
            "Wan 2.2 S2V",
            20_480,
            32_768,
            vec![
                file(
                    DiffusionModels,
                    WAN22,
                    "split_files/diffusion_models/wan2.2_s2v_14B_fp8_scaled.safetensors",
                    "140e75af5534ac3d91e710d9df756f7032addd64b341ba2c1c70e3e6da9aa216",
                    16_394_832_474,
                ),
                umt5(),
                wan21_vae(),
                file(
                    AudioEncoders,
                    WAN22,
                    "split_files/audio_encoders/wav2vec2_large_english_fp16.safetensors",
                    "f0017a43ea57ef6b3d4866be607844bbd8cada6d30966f7d70044ed0d63d3f9e",
                    630_997_322,
                ),
                file(
                    Loras,
                    WAN22,
                    "split_files/loras/wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors",
                    "698321cb86bd30c4af06c9b84e656a1048c8cb54e06d50694536fb5de37fde41",
                    1_226_977_424,
                ),
            ],
        ),
        ComfyModelSet {
            family: "ltx23".into(),
            kind: ComfyModelKind::Video,
            label: "LTX-2.3".into(),
            license: LTX23_LICENCE.text.into(),
            license_url: LTX23_LICENCE.url.into(),
            commercial_use: LTX23_LICENCE.commercial_use,
            vram_mb: 32_768,
            ram_mb: 49_152,
            files: vec![
                file(
                    Checkpoints,
                    "Lightricks/LTX-2.3-fp8",
                    "ltx-2.3-22b-dev-fp8.safetensors",
                    "28606c5b5a06ce56f896d4dfcb20f212739e07a68fbe48e53638188449d26450",
                    29_145_431_166,
                ),
                file(
                    TextEncoders,
                    "Comfy-Org/ltx-2",
                    "split_files/text_encoders/gemma_3_12B_it_fp4_mixed.safetensors",
                    "aaca463d11e6d8d2a4bdb0d6299214c15ef78a3f73e0ef8113d5a9d0219b3f6d",
                    9_447_702_218,
                ),
                file(
                    Loras,
                    "Comfy-Org/ltx-2.3",
                    "split_files/loras/ltx_2.3_22b_distilled_1.1_lora_dynamic_fro09_avg_rank_111_bf16.safetensors",
                    "31e0c0195fb841bf31af78e8b60858f489e87ddcea4a5239abc80943da65e3ac",
                    2_741_024_390,
                ),
                file(
                    LatentUpscaleModels,
                    "Lightricks/LTX-2.3",
                    "ltx-2.3-spatial-upscaler-x2-1.1.safetensors",
                    "5f416311fa8172b65af67530758964708d29a317b830d689a51143b7f91913ed",
                    995_743_560,
                ),
            ],
        },
    ]
}

/// Real-ESRGAN for `upscale_image`, the file the bundled engine runs, as a
/// set of its own: the Settings card installs it like a model, by any route.
pub const UPSCALER_FAMILY: &str = "upscaler";

pub fn comfy_upscaler_set() -> ComfyModelSet {
    ComfyModelSet {
        family: UPSCALER_FAMILY.into(),
        kind: ComfyModelKind::Image,
        label: "Upscaler — Real-ESRGAN x4plus".into(),
        license: UPSCALER_LICENCE.text.into(),
        license_url: UPSCALER_LICENCE.url.into(),
        commercial_use: UPSCALER_LICENCE.commercial_use,
        vram_mb: 1_024,
        ram_mb: 1_024,
        files: vec![shared(ComfyFolder::UpscaleModels, &UPSCALER)],
    }
}

/// Everything the Settings cards offer: the image families, the video
/// families, then the upscaler.
fn catalogue() -> Vec<ComfyModelSet> {
    let mut all = comfy_model_sets();
    all.extend(comfy_video_sets());
    all.push(comfy_upscaler_set());
    all
}

/// True for a base URL on this machine.
fn is_loopback(base_url: &str) -> bool {
    reqwest::Url::parse(base_url.trim()).is_ok_and(|url| {
        url.host_str()
            .is_some_and(crate::net_util::is_loopback_host)
    })
}

/// A directory this process can write into.
fn writable(dir: &Path) -> bool {
    if !dir.is_dir() {
        return false;
    }
    let probe = dir.join(format!(".haruspex-write-test-{}", std::process::id()));
    let ok = std::fs::write(&probe, b"").is_ok();
    let _ = std::fs::remove_file(&probe);
    ok
}

/// ComfyUI's folders for each kind we install into, from its own answer,
/// kept only where they exist here and can be written. `None` when the
/// server is not on this machine, or any model kind has no such folder — then
/// the direct route is not available and the caller goes through Manager.
/// The other folders (`upscale_models`, `loras`, and those only video models
/// use) are kept when they are here, and not asked for: a ComfyUI without
/// them still installs models directly.
///
/// A loopback URL is necessary but not enough: a ComfyUI in a container
/// answers on loopback with paths that mean nothing here. Requiring the path
/// to exist AND be writable catches that.
pub fn local_folders(answer: &serde_json::Value) -> Option<HashMap<ComfyFolder, Vec<PathBuf>>> {
    let mut out = HashMap::new();
    for kind in [
        ComfyFolder::DiffusionModels,
        ComfyFolder::TextEncoders,
        ComfyFolder::Vae,
    ] {
        let dirs: Vec<PathBuf> = answer
            .get(kind.key())?
            .as_array()?
            .iter()
            .filter_map(|v| v.as_str().map(PathBuf::from))
            .collect();
        if !dirs.first().is_some_and(|d| writable(d)) {
            return None;
        }
        out.insert(kind, dirs);
    }
    for kind in [
        ComfyFolder::UpscaleModels,
        ComfyFolder::Loras,
        ComfyFolder::AudioEncoders,
        ComfyFolder::Checkpoints,
        ComfyFolder::LatentUpscaleModels,
    ] {
        let dirs: Vec<PathBuf> = answer
            .get(kind.key())
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(PathBuf::from))
                    .collect()
            })
            .unwrap_or_default();
        if dirs.first().is_some_and(|d| writable(d)) {
            out.insert(kind, dirs);
        }
    }
    Some(out)
}

/// The files of `set` found in none of ComfyUI's folders of their kind.
pub fn missing<'a>(
    set: &'a ComfyModelSet,
    folders: &HashMap<ComfyFolder, Vec<PathBuf>>,
) -> Vec<&'a ComfyModelFile> {
    set.files
        .iter()
        .filter(|f| {
            !folders
                .get(&f.folder)
                .is_some_and(|dirs| dirs.iter().any(|d| d.join(&f.filename).is_file()))
        })
        .collect()
}

async fn folder_answer(base_url: &str, api_key: &str) -> Result<serde_json::Value, String> {
    comfy_json(ComfyCall {
        base_url: base_url.to_string(),
        api_key: api_key.to_string(),
        method: "GET".into(),
        path: "/internal/folder_paths".into(),
        body: None,
        timeout_ms: 10_000,
        id: None,
    })
    .await
    .map_err(|e| e.to_string())
}

// Tauri commands

#[tauri::command]
pub fn comfy_model_catalogue() -> Vec<ComfyModelSet> {
    catalogue()
}

/// Whether Haruspex can write the server's model folders directly.
#[tauri::command]
pub async fn comfy_can_install_directly(base_url: String, api_key: String) -> bool {
    if !is_loopback(&base_url) {
        return false;
    }
    match folder_answer(&base_url, &api_key).await {
        Ok(answer) => local_folders(&answer).is_some(),
        Err(_) => false,
    }
}

/// Download the files `family` is missing into the server's own folders,
/// verified, through the LLM download path (progress, resume, cancel, proxy).
/// Returns the filenames it installed.
#[tauri::command]
pub async fn comfy_install_direct(
    app: AppHandle,
    state: tauri::State<'_, ModelManager>,
    base_url: String,
    api_key: String,
    family: String,
    proxy: Option<crate::proxy::ProxyConfig>,
) -> Result<Vec<String>, String> {
    if !is_loopback(&base_url) {
        return Err("The image backend is not on this machine.".into());
    }
    let set = catalogue()
        .into_iter()
        .find(|s| s.family == family)
        .ok_or_else(|| format!("No model files are listed for {family}."))?;
    let answer = folder_answer(&base_url, &api_key).await?;
    let folders = local_folders(&answer)
        .ok_or("ComfyUI's model folders are not on this machine, or cannot be written.")?;
    let todo = missing(&set, &folders);
    let files = todo
        .iter()
        .map(|f| {
            let dir = folders
                .get(&f.folder)
                .and_then(|d| d.first())
                .ok_or_else(|| {
                    format!(
                        "ComfyUI's models/{} folder is not on this machine, or cannot be written.",
                        f.folder.key()
                    )
                })?;
            Ok(VerifiedFile {
                url: &f.url,
                dir,
                filename: &f.filename,
                size_bytes: f.size_bytes,
                sha256: &f.sha256,
            })
        })
        .collect::<Result<Vec<VerifiedFile>, String>>()?;
    state
        .download_set(&app, &format!("comfy:{family}"), proxy, &files)
        .await?;
    Ok(todo.into_iter().map(|f| f.filename.clone()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::{temp_dir, TestDir};

    #[test]
    fn both_engines_agree_on_each_familys_licence_and_vae() {
        let bundled = crate::image_models::image_registry();
        // klein and 2511 run on ComfyUI only.
        for set in comfy_model_sets()
            .into_iter()
            .filter(|s| s.family != "flux2_klein" && s.family != "qwen_edit_2511")
        {
            let entry = bundled
                .iter()
                .find(|m| m.family == set.family)
                .unwrap_or_else(|| panic!("{} has no bundled-engine entry", set.family));
            assert_eq!(set.license, entry.license, "{}", set.family);
            assert_eq!(set.license_url, entry.license_url, "{}", set.family);
            assert_eq!(set.commercial_use, entry.commercial_use, "{}", set.family);
            let vae = set
                .files
                .iter()
                .find(|f| f.folder == ComfyFolder::Vae)
                .unwrap();
            let bundled_vae = entry
                .files
                .iter()
                .find(|f| f.role == crate::image_models::ImageFileRole::Vae)
                .unwrap();
            assert_eq!(vae.url, bundled_vae.url);
            assert_eq!(vae.sha256, bundled_vae.sha256);
        }
    }

    #[test]
    fn every_file_can_be_downloaded_and_verified() {
        for s in comfy_model_sets() {
            assert!(s.files.len() >= 3, "{}: model, encoder, VAE", s.family);
            for f in &s.files {
                assert!(f.url.starts_with("https://huggingface.co/"), "{}", f.url);
                assert!(f.url.ends_with(&f.filename), "{}", f.url);
                assert_eq!(f.sha256.len(), 64);
                assert!(f.sha256.chars().all(|c| c.is_ascii_hexdigit()));
                assert!(f.size_bytes > 100_000_000, "{}", f.filename);
            }
        }
    }

    #[test]
    fn a_set_that_cannot_be_sold_says_so() {
        let sets = comfy_model_sets();
        assert!(
            sets.iter()
                .find(|s| s.family == "ming")
                .unwrap()
                .commercial_use
        );
        assert!(
            !sets
                .iter()
                .find(|s| s.family == "qwen21_turbo")
                .unwrap()
                .commercial_use
        );
        for family in ["flux2_klein", "qwen_edit_2511"] {
            assert!(
                sets.iter()
                    .find(|s| s.family == family)
                    .unwrap()
                    .commercial_use,
                "{family}"
            );
        }
    }

    #[test]
    fn loopback_is_this_machine_and_nothing_else_is() {
        assert!(is_loopback("http://127.0.0.1:8188"));
        assert!(is_loopback("http://localhost:8188/"));
        assert!(is_loopback("http://[::1]:8188"));
        assert!(is_loopback("http://comfy.localhost:8188"));
        assert!(!is_loopback("http://192.168.1.20:8188"));
        assert!(!is_loopback("http://localhost.example.com:8188"));
        assert!(!is_loopback("http://gpu-box:8188"));
        assert!(!is_loopback("not a url"));
    }

    /// One made folder per name, inside a fresh temp folder that goes when
    /// the guard drops.
    fn folders<const N: usize>(names: [&str; N]) -> (TestDir, [PathBuf; N]) {
        let root = temp_dir("comfy");
        let dirs = names.map(|n| {
            let d = root.join(n);
            std::fs::create_dir(&d).unwrap();
            d
        });
        (root, dirs)
    }

    #[test]
    fn folders_count_only_when_every_kind_is_here_and_writable() {
        let (_root, [dm, te, vae]) = folders(["dm", "te", "vae"]);
        let answer = serde_json::json!({
            "diffusion_models": [dm, "/nowhere"],
            "text_encoders": [te],
            "vae": [vae],
            "checkpoints": ["/nowhere"]
        });
        let f = local_folders(&answer).unwrap();
        assert_eq!(f[&ComfyFolder::DiffusionModels][0], dm);
        // No upscale_models folder: models still install directly.
        assert!(!f.contains_key(&ComfyFolder::UpscaleModels));
        // A container's paths: they mean nothing here.
        let elsewhere = serde_json::json!({
            "diffusion_models": ["/opt/ComfyUI/models/diffusion_models"],
            "text_encoders": [te],
            "vae": [vae]
        });
        assert!(local_folders(&elsewhere).is_none());
        assert!(local_folders(&serde_json::json!({ "vae": [vae] })).is_none());
    }

    #[test]
    fn the_upscaler_installs_into_upscale_models_when_it_is_here() {
        let (_root, [dm, te, vae, up]) = folders(["dm", "te", "vae", "up"]);
        let answer = serde_json::json!({
            "diffusion_models": [dm],
            "text_encoders": [te],
            "vae": [vae],
            "upscale_models": [up]
        });
        let f = local_folders(&answer).unwrap();
        assert_eq!(f[&ComfyFolder::UpscaleModels][0], up);
        let set = comfy_upscaler_set();
        assert_eq!(missing(&set, &f).len(), 1);
        std::fs::write(up.join(&set.files[0].filename), b"x").unwrap();
        assert!(missing(&set, &f).is_empty());
        // The bundled engine's file, so both verify against one checksum.
        assert_eq!(set.files[0].sha256, UPSCALER.sha256);
        assert!(set.commercial_use);
        assert_eq!(catalogue().last().unwrap().family, UPSCALER_FAMILY);
    }

    #[test]
    fn every_video_set_is_verified_and_named_as_the_front_end_reads_it() {
        let sets = comfy_video_sets();
        let families: Vec<&str> = sets.iter().map(|s| s.family.as_str()).collect();
        assert_eq!(
            families,
            ["wan22_ti2v_5b", "wan22_i2v_14b", "wan22_s2v", "ltx23"]
        );
        for set in &sets {
            assert_eq!(set.kind, ComfyModelKind::Video);
            for f in &set.files {
                assert_eq!(f.sha256.len(), 64, "{}", f.filename);
                assert!(f.sha256.chars().all(|c| c.is_ascii_hexdigit()));
                assert!(f.size_bytes > 0);
                assert!(f.url.ends_with(&f.filename));
            }
        }
        // No family is listed twice across image and video.
        let all = catalogue();
        let mut names: Vec<&str> = all.iter().map(|s| s.family.as_str()).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), all.len());
        assert!(comfy_model_sets()
            .iter()
            .all(|s| s.kind == ComfyModelKind::Image));
    }

    #[test]
    fn video_folders_are_kept_when_here_and_not_asked_for() {
        let (_root, [dm, te, vae, audio]) = folders(["dm", "te", "vae", "audio"]);
        let without = serde_json::json!({
            "diffusion_models": [dm],
            "text_encoders": [te],
            "vae": [vae]
        });
        assert!(local_folders(&without).is_some());
        let with = serde_json::json!({
            "diffusion_models": [dm],
            "text_encoders": [te],
            "vae": [vae],
            "audio_encoders": [audio]
        });
        assert_eq!(
            local_folders(&with).unwrap()[&ComfyFolder::AudioEncoders][0],
            audio
        );
    }

    #[test]
    fn a_file_in_any_folder_of_its_kind_is_not_missing() {
        let (_root, [dm, dm2, te, vae]) = folders(["dm", "dm2", "te", "vae"]);
        let set = comfy_model_sets()
            .into_iter()
            .find(|s| s.family == "ming")
            .unwrap();
        // The model sits in the second diffusion folder (ComfyUI's `unet`).
        std::fs::write(dm2.join(&set.files[0].filename), b"x").unwrap();
        let folders = HashMap::from([
            (ComfyFolder::DiffusionModels, vec![dm, dm2]),
            (ComfyFolder::TextEncoders, vec![te]),
            (ComfyFolder::Vae, vec![vae]),
        ]);
        let names: Vec<&str> = missing(&set, &folders)
            .iter()
            .map(|f| f.filename.as_str())
            .collect();
        assert_eq!(
            names,
            vec![
                set.files[1].filename.as_str(),
                set.files[2].filename.as_str()
            ]
        );
    }
}
