use futures_util::StreamExt;
use log::info;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::fs;
use tokio::sync::Mutex;

const GGUF_MAGIC: [u8; 4] = [0x47, 0x47, 0x55, 0x46]; // "GGUF"
                                                      // Reserved for future use when implementing chunked progress
#[allow(dead_code)]
const DOWNLOAD_CHUNK_SIZE: usize = 64 * 1024;

/// Where a model's multi-token-prediction head comes from. Distinguishing
/// these matters for VRAM: a bundled head is already inside `size_bytes`,
/// while a sibling drafter is a whole extra file that has to be downloaded
/// and loaded on top of the target model.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum MtpSource {
    /// No head. `--spec-type draft-mtp` must not be passed — llama-server
    /// fails the start rather than degrading.
    #[default]
    None,
    /// The head ships inside the weights file. llama-server drafts against
    /// the target model itself, so there is no second file and no extra
    /// weights to account for.
    Bundled,
    /// The head ships as a separate drafter GGUF (Unsloth publishes these
    /// under `MTP/` for the models whose main quants don't carry one). It has
    /// to be downloaded alongside the weights and passed via `--model-draft`,
    /// and its weights are VRAM *on top of* `size_bytes`.
    ///
    /// Gemma 4 12B is the one lineup model that uses this. The drafter is
    /// fetched with the weights, but a model downloaded before it was wired
    /// up won't have the file — `find_mtp_draft_for_model` then returns
    /// `None` and the server starts without the flag rather than failing.
    Sibling {
        filename: String,
        url: String,
        size_bytes: u64,
        sha256: String,
    },
}

impl MtpSource {
    /// Whether `--spec-type draft-mtp` can be driven for this model at all.
    pub fn is_supported(&self) -> bool {
        !matches!(self, MtpSource::None)
    }

    /// VRAM the drafter's own weights occupy on top of the target model.
    /// Zero for a bundled head, which `ModelInfo::size_bytes` already covers
    /// — the distinction the flat `MTP_OVERHEAD_BYTES` estimate misses.
    pub fn draft_weight_bytes(&self) -> u64 {
        match self {
            MtpSource::Sibling { size_bytes, .. } => *size_bytes,
            _ => 0,
        }
    }
}

/// Keeps the wire shape at `mtp: boolean` while Rust carries the richer
/// [`MtpSource`], so the frontend contract is unchanged.
fn serialize_mtp_supported<S: serde::Serializer>(
    source: &MtpSource,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.serialize_bool(source.is_supported())
}

#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct ModelInfo {
    pub id: String,
    pub filename: String,
    pub url: String,
    pub sha256: String,
    #[ts(type = "number")]
    pub size_bytes: u64,
    pub description: String,
    pub downloaded: bool,
    /// True for models that are no longer part of the recommended lineup but
    /// remain supported: still listed (when on disk), switchable, and
    /// re-downloadable. New installs never see these unless they kept one
    /// from a previous version.
    pub legacy: bool,
    /// Optional multimodal projector filename (e.g. "mmproj-F16.gguf").
    /// When present, it is downloaded alongside the main weights and passed
    /// to llama-server via --mmproj to enable vision support.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mmproj_filename: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mmproj_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub mmproj_size_bytes: Option<u64>,
    /// Where this model's multi-token-prediction head comes from, if it has
    /// one — see [`MtpSource`].
    ///
    /// Verified per file by reading the GGUF metadata for `blk.N.nextn.*`
    /// tensors — the HF config declaring `mtp_num_hidden_layers` is NOT
    /// sufficient. Qwen 3.5 9B and Qwen 3.6 27B both declare one upstream and
    /// neither Unsloth GGUF carries it; only the 3.8 27B does (65 blocks to
    /// the 3.6's 64).
    ///
    /// Serialized as the plain `mtp: boolean` it has always been: the
    /// frontend only needs to know whether the MTP toggle applies to the
    /// active model, not where the head lives.
    #[serde(serialize_with = "serialize_mtp_supported")]
    #[ts(type = "boolean")]
    pub mtp: MtpSource,
    /// Per-token KV-cache growth in bytes (q8_0) for this model's
    /// full-attention layers — see the derivation note above
    /// [`CONTEXT_LADDER`]. Declared per entry rather than matched from the
    /// id: a new model version that matches no arm used to silently return
    /// `None`, which disables the whole context-fit prediction.
    ///
    /// Rust-internal — skipped from both the wire shape and the generated TS
    /// type, so the frontend contract is unchanged.
    #[serde(skip)]
    #[ts(skip)]
    pub kv_bytes_per_token: u64,
}

#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export)]
pub struct DownloadProgress {
    #[ts(type = "number")]
    pub downloaded: u64,
    #[ts(type = "number")]
    pub total: u64,
    #[ts(type = "number")]
    pub speed_bps: u64,
    /// Human-readable label for the current download stage
    /// (e.g. "Downloading model", "Downloading vision projector").
    pub stage: String,
}

// mmproj sizes and hashes from the HuggingFace API (F16 variant) —
// the LFS oid of each file IS its sha256.
const QWEN_4B_MMPROJ_URL: &str =
    "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/mmproj-F16.gguf";
const QWEN_4B_MMPROJ_SIZE: u64 = 672_423_616;
const QWEN_4B_MMPROJ_SHA256: &str =
    "cd88edcf8d031894960bb0c9c5b9b7e1fea6ebee02b9f7ce925a00d12891f864";
const QWEN_9B_MMPROJ_URL: &str =
    "https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/mmproj-F16.gguf";
const QWEN_9B_MMPROJ_SIZE: u64 = 918_166_080;
const QWEN_9B_MMPROJ_SHA256: &str =
    "f70dc3509053962b0d0d3ee8a7eacebf5d60aa560cad78254ae8698516ae029f";
const QWEN_35B_A3B_MMPROJ_URL: &str =
    "https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF/resolve/main/mmproj-F16.gguf";
const QWEN_35B_A3B_MMPROJ_SIZE: u64 = 899_283_680;
const QWEN_35B_A3B_MMPROJ_SHA256: &str =
    "8971ee4f331ff0a4c609374f32984b3d4e6dc086c0aa35f1d637fad1829e887f";
const QWEN_27B_MMPROJ_URL: &str =
    "https://huggingface.co/unsloth/Qwen3.6-27B-GGUF/resolve/main/mmproj-F16.gguf";
const QWEN_27B_MMPROJ_SIZE: u64 = 927_607_360;
const QWEN_27B_MMPROJ_SHA256: &str =
    "eacf610d1ee4bd5ed0197a0777dd8f4fceb8eefa27009067c7d496cb68fbde45";
// The Qwen 3.8 27B projector is a DIFFERENT file from the 3.6 one despite
// landing within 128 bytes of the same size — reusing the constants above
// would fail the sha check on download.
const QWEN_38_27B_MMPROJ_URL: &str =
    "https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/resolve/main/mmproj-F16.gguf";
const QWEN_38_27B_MMPROJ_SIZE: u64 = 927_607_488;
const QWEN_38_27B_MMPROJ_SHA256: &str =
    "cbb841a9ee0636b2ec172f5bb8df2ea8dfeb01e90fe7c6126581d662a0b4e43e";

const GEMMA4_12B_MMPROJ_URL: &str =
    "https://huggingface.co/unsloth/gemma-4-12b-it-GGUF/resolve/main/mmproj-F16.gguf";
const GEMMA4_12B_MMPROJ_SIZE: u64 = 175_115_840;
const GEMMA4_12B_MMPROJ_SHA256: &str =
    "91f086971e56d7a7d8d39e271873fccdb49541bd259d6e02c401a4f1cb7a219e";

// The Gemma 4 12B MTP drafter, the one sibling head in the lineup. Unsloth
// publishes three precisions under `MTP/`; Q8_0 is both the smallest and the
// one mirrored at the repo root for `-hf` auto-discovery, which we can't use
// (we pass local `--model` paths), so the explicit `MTP/` path is what gets
// downloaded. A drafter is quality-tolerant — a bad draft token is rejected
// and costs throughput, not correctness — so on a tier this VRAM-tight the
// 465 MB Q8_0 is the right trade over the 862 MB F16/BF16.
const GEMMA4_12B_MTP_URL: &str = "https://huggingface.co/unsloth/gemma-4-12b-it-GGUF/resolve/main/MTP/mtp-gemma-4-12b-it-Q8_0.gguf";
const GEMMA4_12B_MTP_SIZE: u64 = 465_109_248;
const GEMMA4_12B_MTP_SHA256: &str =
    "145db9094bc0f85f1701e255a2ed216dcc9800fc8bc8631ad00905b456bd451b";

/// sha256 for the mmproj at `url`. Keyed by URL rather than stored per
/// registry entry because several models share one projector file.
fn mmproj_sha256_for_url(url: &str) -> Option<&'static str> {
    match url {
        QWEN_4B_MMPROJ_URL => Some(QWEN_4B_MMPROJ_SHA256),
        QWEN_9B_MMPROJ_URL => Some(QWEN_9B_MMPROJ_SHA256),
        QWEN_35B_A3B_MMPROJ_URL => Some(QWEN_35B_A3B_MMPROJ_SHA256),
        QWEN_27B_MMPROJ_URL => Some(QWEN_27B_MMPROJ_SHA256),
        QWEN_38_27B_MMPROJ_URL => Some(QWEN_38_27B_MMPROJ_SHA256),
        GEMMA4_12B_MMPROJ_URL => Some(GEMMA4_12B_MMPROJ_SHA256),
        _ => None,
    }
}

fn qwen_4b_mmproj_filename() -> String {
    "Qwen3.5-4B-mmproj-F16.gguf".to_string()
}

fn qwen_9b_mmproj_filename() -> String {
    "Qwen3.5-9B-mmproj-F16.gguf".to_string()
}

fn qwen_35b_a3b_mmproj_filename() -> String {
    "Qwen3.6-35B-A3B-mmproj-F16.gguf".to_string()
}

fn qwen_27b_mmproj_filename() -> String {
    "Qwen3.6-27B-mmproj-F16.gguf".to_string()
}

fn qwen_38_27b_mmproj_filename() -> String {
    "Qwen3.8-27B-mmproj-F16.gguf".to_string()
}

fn gemma4_12b_mmproj_filename() -> String {
    "Gemma4-12B-mmproj-F16.gguf".to_string()
}

/// Local name for the drafter. Normalised the same way as the projectors
/// above: the models dir is flat, and the upstream `MTP/` prefix is lost on
/// download, so the file is stored under a name that says which model it
/// belongs to.
fn gemma4_12b_mtp_filename() -> String {
    "Gemma4-12B-MTP-Q8_0.gguf".to_string()
}

// Per-token KV-cache growth (bytes, q8_0) by model shape. Full derivation in
// the note above `CONTEXT_LADDER`; every registry entry declares one of these.
/// 4B and 9B: 8 full-attention layers × 4 KV heads.
const KV_PER_TOKEN_SMALL: u64 = 17_408;
/// Dense 27B (3.6 and 3.8 alike): 16 full-attention layers × 4 KV heads.
const KV_PER_TOKEN_DENSE_27B: u64 = 34_816;
/// 35B-A3B sparse MoE: 10 full-attention layers × 2 KV heads.
const KV_PER_TOKEN_35B_A3B: u64 = 10_880;
/// Gemma 4 12B: 48 layers, of which only 8 are full attention (the other 40
/// are sliding-window 1024). Those 8 use a single KV head at head_dim 512:
/// 8 × 2 × 1 × 512 = 8192 elements × 34/32 = 8704 — half the 9B's per-token
/// cost, which is why this tier reaches the top of the context ladder.
///
/// NOT counted here: the sliding-window layers hold a fixed ~178 MB pool
/// (40 × 2 × 8 × 256 × 1.0625 × 1024 window) that doesn't grow with context.
/// It's absorbed by COMPUTE_OVERHEAD_BYTES rather than modelled per-token,
/// which would over-charge long contexts by an order of magnitude.
const KV_PER_TOKEN_GEMMA4_12B: u64 = 8_704;
/// Architecture unknown — a model the user imported themselves. Makes
/// `context_ceiling_for` report "can't predict" so the Settings cap fails open.
const KV_PER_TOKEN_UNKNOWN: u64 = 0;

/// The current recommended lineup — one model per VRAM tier, all Unsloth
/// dynamic quants. The 16 GB and 24 GB tiers each offer two: the first entry
/// is the tier's default (what `hardware::QUANT_BY_VRAM_MB` recommends) and
/// the second is an opt-in alternative with a different trade.
fn model_registry() -> Vec<ModelInfo> {
    vec![
        // < 8 GB VRAM — lightweight 4B for integrated graphics / low VRAM
        ModelInfo {
            id: "Qwen3.5-4B-IQ4_NL".to_string(),
            filename: "Qwen3.5-4B-IQ4_NL.gguf".to_string(),
            url:
                "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-IQ4_NL.gguf"
                    .to_string(),
            sha256: "ff5c3e9740a5aa53f04fdf3b0b8cc75da556bf8948cdb19d61c512d3a43465d9".to_string(),
            size_bytes: 2_579_944_608,
            description: "Qwen 3.5 4B — for integrated graphics or under 8 GB VRAM (~2.6 GB)"
                .to_string(),
            downloaded: false,
            legacy: false,
            mmproj_filename: Some(qwen_4b_mmproj_filename()),
            mmproj_url: Some(QWEN_4B_MMPROJ_URL.to_string()),
            mmproj_size_bytes: Some(QWEN_4B_MMPROJ_SIZE),
            mtp: MtpSource::None,
            kv_bytes_per_token: KV_PER_TOKEN_SMALL,
        },
        // 8 GB VRAM — the default recommendation
        ModelInfo {
            id: "Qwen3.5-9B-IQ4_NL".to_string(),
            filename: "Qwen3.5-9B-IQ4_NL.gguf".to_string(),
            url:
                "https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-IQ4_NL.gguf"
                    .to_string(),
            sha256: "12fd6b43e298ae4c8d374e64e8c2406c252d109ead47dffb46e75be3566ed0e5".to_string(),
            size_bytes: 5_371_028_704,
            description: "Qwen 3.5 9B — recommended for 8 GB VRAM (~5.4 GB)".to_string(),
            downloaded: false,
            legacy: false,
            mmproj_filename: Some(qwen_9b_mmproj_filename()),
            mmproj_url: Some(QWEN_9B_MMPROJ_URL.to_string()),
            mmproj_size_bytes: Some(QWEN_9B_MMPROJ_SIZE),
            mtp: MtpSource::None,
            kv_bytes_per_token: KV_PER_TOKEN_SMALL,
        },
        // 12 GB VRAM — the mid 9B, for cards that can't hold Q8
        ModelInfo {
            id: "Qwen3.5-9B-UD-Q6_K_XL".to_string(),
            filename: "Qwen3.5-9B-UD-Q6_K_XL.gguf".to_string(),
            url: "https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-UD-Q6_K_XL.gguf"
                .to_string(),
            sha256: "33b0050fb9c19abcf815647a78464dad959a06dadaecb0b96af798669f9074d4".to_string(),
            size_bytes: 8_756_929_760,
            description: "Qwen 3.5 9B Q6 — recommended for 12 GB VRAM (~8.8 GB)".to_string(),
            downloaded: false,
            legacy: false,
            mmproj_filename: Some(qwen_9b_mmproj_filename()),
            mmproj_url: Some(QWEN_9B_MMPROJ_URL.to_string()),
            mmproj_size_bytes: Some(QWEN_9B_MMPROJ_SIZE),
            mtp: MtpSource::None,
            kv_bytes_per_token: KV_PER_TOKEN_SMALL,
        },
        // 16 GB VRAM — Gemma 4 12B at Q6. Replaced a dense 27B at IQ3_XXS and
        // a 26B-A4B MoE, both of which spent the tier's whole VRAM budget on
        // parameters and left the context window starved: the 27B's KV costs
        // 34,816 bytes/token, so it topped out at 64k even with the projector
        // moved to system RAM. The 12B is a quarter of that per token and its
        // projector is 175 MB rather than 1.19 GB, so this reaches the top of
        // the context ladder with ~2.2 GB still free for the desktop.
        ModelInfo {
            id: "gemma-4-12b-it-UD-Q6_K_XL".to_string(),
            filename: "gemma-4-12b-it-UD-Q6_K_XL.gguf".to_string(),
            url: "https://huggingface.co/unsloth/gemma-4-12b-it-GGUF/resolve/main/gemma-4-12b-it-UD-Q6_K_XL.gguf"
                .to_string(),
            sha256: "70d04059c74be85c5e709921f05acac412b8b8f24f3ee7dd07e91ddc5f4d4de8".to_string(),
            size_bytes: 10_685_012_800,
            description: "Gemma 4 12B Q6 — recommended for 16 GB VRAM (~11 GB)".to_string(),
            downloaded: false,
            legacy: false,
            mmproj_filename: Some(gemma4_12b_mmproj_filename()),
            mmproj_url: Some(GEMMA4_12B_MMPROJ_URL.to_string()),
            mmproj_size_bytes: Some(GEMMA4_12B_MMPROJ_SIZE),
            // Verified per file: the main GGUF carries no `blk.N.nextn.*`
            // tensors, so the head comes from Unsloth's separate drafter —
            // the lineup's only sibling. Costs `MTP_OVERHEAD_BYTES` for the
            // draft context plus its own 465 MB of weights when the user has
            // MTP on, which this tier absorbs: 262144 either way, with the
            // ~2.2 GB spare above dropping to ~1.2 GB.
            mtp: MtpSource::Sibling {
                filename: gemma4_12b_mtp_filename(),
                url: GEMMA4_12B_MTP_URL.to_string(),
                size_bytes: GEMMA4_12B_MTP_SIZE,
                sha256: GEMMA4_12B_MTP_SHA256.to_string(),
            },
            kv_bytes_per_token: KV_PER_TOKEN_GEMMA4_12B,
        },
        // 24 GB VRAM — sparse MoE, the recommended large model
        ModelInfo {
            id: "Qwen3.6-35B-A3B-UD-IQ4_NL".to_string(),
            filename: "Qwen3.6-35B-A3B-UD-IQ4_NL.gguf".to_string(),
            url: "https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF/resolve/main/Qwen3.6-35B-A3B-UD-IQ4_NL.gguf"
                .to_string(),
            sha256: "0d17e255dc257a11f398ed4bc8d62412d8ce9ca24b3fce2947d962e4bfed5758".to_string(),
            size_bytes: 18_040_888_288,
            description: "Qwen 3.6 35B-A3B — fast sparse MoE, recommended for 24 GB VRAM (~18 GB)"
                .to_string(),
            downloaded: false,
            legacy: false,
            mmproj_filename: Some(qwen_35b_a3b_mmproj_filename()),
            mmproj_url: Some(QWEN_35B_A3B_MMPROJ_URL.to_string()),
            mmproj_size_bytes: Some(QWEN_35B_A3B_MMPROJ_SIZE),
            mtp: MtpSource::None,
            kv_bytes_per_token: KV_PER_TOKEN_35B_A3B,
        },
        // 24 GB VRAM — dense alternative for those who want it. Was
        // `Qwen3.8-27B-IQ4_NL` until Unsloth dropped that quant from the
        // repo, at which point the download started 404ing; UD-IQ4_XS is the
        // nearest surviving file and carries the same bundled MTP head.
        ModelInfo {
            id: "Qwen3.8-27B-UD-IQ4_XS".to_string(),
            filename: "Qwen3.8-27B-UD-IQ4_XS.gguf".to_string(),
            url: "https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/resolve/main/Qwen3.8-27B-UD-IQ4_XS.gguf"
                .to_string(),
            sha256: "40fac4050e940397dbf13087afd50f4734a11805bf9d65ef8ddd7483470e6199".to_string(),
            size_bytes: 14_252_845_984,
            description: "Qwen 3.8 27B — dense model for 24 GB VRAM, advanced (~14 GB)".to_string(),
            downloaded: false,
            legacy: false,
            mmproj_filename: Some(qwen_38_27b_mmproj_filename()),
            mmproj_url: Some(QWEN_38_27B_MMPROJ_URL.to_string()),
            mmproj_size_bytes: Some(QWEN_38_27B_MMPROJ_SIZE),
            mtp: MtpSource::Bundled,
            kv_bytes_per_token: KV_PER_TOKEN_DENSE_27B,
        },
        // 32 GB VRAM — the same sparse MoE the 24 GB tier defaults to, but at
        // Q5 instead of IQ4. A 32 GB card was previously handed the 24 GB pick
        // and left ~11 GB idle; spending it on quant fidelity of the larger
        // model beats re-quantising the smaller dense one.
        ModelInfo {
            id: "Qwen3.6-35B-A3B-UD-Q5_K_XL".to_string(),
            filename: "Qwen3.6-35B-A3B-UD-Q5_K_XL.gguf".to_string(),
            url: "https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF/resolve/main/Qwen3.6-35B-A3B-UD-Q5_K_XL.gguf"
                .to_string(),
            sha256: "25233af7642e3a91bd52cc4aeefdbd4a117479088e06cf1aea5b6bedb443c506".to_string(),
            size_bytes: 26_592_508_896,
            description: "Qwen 3.6 35B-A3B Q5 — sparse MoE, recommended for 32 GB VRAM (~27 GB)"
                .to_string(),
            downloaded: false,
            legacy: false,
            mmproj_filename: Some(qwen_35b_a3b_mmproj_filename()),
            mmproj_url: Some(QWEN_35B_A3B_MMPROJ_URL.to_string()),
            mmproj_size_bytes: Some(QWEN_35B_A3B_MMPROJ_SIZE),
            mtp: MtpSource::None,
            kv_bytes_per_token: KV_PER_TOKEN_35B_A3B,
        },
        // 32 GB VRAM — dense alternative. Q4_K_XL needs this tier to breathe:
        // on a 24 GB card it reaches the same 128k rung as UD-IQ4_XS with only
        // ~80 MB to spare, which the backoff ladder eats on the first machine
        // whose compute buffers run over the flat estimate.
        ModelInfo {
            id: "Qwen3.8-27B-UD-Q4_K_XL".to_string(),
            filename: "Qwen3.8-27B-UD-Q4_K_XL.gguf".to_string(),
            url: "https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/resolve/main/Qwen3.8-27B-UD-Q4_K_XL.gguf"
                .to_string(),
            sha256: "3f227079003add2511437e5b1e94812e363385225bf6a9b47b0054a72bc8b01e".to_string(),
            size_bytes: 17_559_178_144,
            description: "Qwen 3.8 27B Q4 — dense model for 32 GB VRAM, advanced (~18 GB)"
                .to_string(),
            downloaded: false,
            legacy: false,
            mmproj_filename: Some(qwen_38_27b_mmproj_filename()),
            mmproj_url: Some(QWEN_38_27B_MMPROJ_URL.to_string()),
            mmproj_size_bytes: Some(QWEN_38_27B_MMPROJ_SIZE),
            mtp: MtpSource::Bundled,
            kv_bytes_per_token: KV_PER_TOKEN_DENSE_27B,
        },
    ]
}

/// Models retired from the recommended lineup. Kept (with valid URLs/hashes)
/// so users who downloaded one before upgrading keep it working, can switch
/// back to it, and — if they delete it — can still re-download it. New
/// installs never download these; they only surface when already on disk.
///
/// One exception to the "valid URL" rule is called out inline below: the
/// Qwen 3.8 27B IQ4_NL entry's upstream file no longer exists, so it is kept
/// only to keep an already-downloaded copy usable.
fn legacy_registry() -> Vec<ModelInfo> {
    vec![
        ModelInfo {
            id: "Qwen3.5-4B-Q4_K_M".to_string(),
            filename: "Qwen3.5-4B-Q4_K_M.gguf".to_string(),
            url:
                "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf"
                    .to_string(),
            sha256: "00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4".to_string(),
            size_bytes: 2_740_937_888,
            description: "Qwen 3.5 4B Q4 — legacy (~2.7 GB)".to_string(),
            downloaded: false,
            legacy: true,
            mmproj_filename: Some(qwen_4b_mmproj_filename()),
            mmproj_url: Some(QWEN_4B_MMPROJ_URL.to_string()),
            mmproj_size_bytes: Some(QWEN_4B_MMPROJ_SIZE),
            mtp: MtpSource::None,
            kv_bytes_per_token: KV_PER_TOKEN_SMALL,
        },
        ModelInfo {
            id: "Qwen3.5-4B-Q6_K".to_string(),
            filename: "Qwen3.5-4B-Q6_K.gguf".to_string(),
            url: "https://huggingface.co/unsloth/Qwen3.5-4B-GGUF/resolve/main/Qwen3.5-4B-Q6_K.gguf"
                .to_string(),
            sha256: "fdedd781c9ce676ab66b018ca247ff78e8a33c98098a822c1e2d5075e7718f66".to_string(),
            size_bytes: 3_525_956_768,
            description: "Qwen 3.5 4B Q6 — legacy (~3.5 GB)".to_string(),
            downloaded: false,
            legacy: true,
            mmproj_filename: Some(qwen_4b_mmproj_filename()),
            mmproj_url: Some(QWEN_4B_MMPROJ_URL.to_string()),
            mmproj_size_bytes: Some(QWEN_4B_MMPROJ_SIZE),
            mtp: MtpSource::None,
            kv_bytes_per_token: KV_PER_TOKEN_SMALL,
        },
        ModelInfo {
            id: "Qwen3.5-9B-Q4_K_M".to_string(),
            filename: "Qwen3.5-9B-Q4_K_M.gguf".to_string(),
            url:
                "https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q4_K_M.gguf"
                    .to_string(),
            sha256: "03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8".to_string(),
            size_bytes: 5_680_522_464,
            description: "Qwen 3.5 9B Q4 — legacy (~5.7 GB)".to_string(),
            downloaded: false,
            legacy: true,
            mmproj_filename: Some(qwen_9b_mmproj_filename()),
            mmproj_url: Some(QWEN_9B_MMPROJ_URL.to_string()),
            mmproj_size_bytes: Some(QWEN_9B_MMPROJ_SIZE),
            mtp: MtpSource::None,
            kv_bytes_per_token: KV_PER_TOKEN_SMALL,
        },
        ModelInfo {
            id: "Qwen3.5-9B-Q5_K_M".to_string(),
            filename: "Qwen3.5-9B-Q5_K_M.gguf".to_string(),
            url:
                "https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q5_K_M.gguf"
                    .to_string(),
            sha256: "dc2a39aef291f91a9116ad214058da0d86eb648743a124bd8c333787c4b9c91c".to_string(),
            size_bytes: 6_577_841_376,
            description: "Qwen 3.5 9B Q5 — legacy (~6.6 GB)".to_string(),
            downloaded: false,
            legacy: true,
            mmproj_filename: Some(qwen_9b_mmproj_filename()),
            mmproj_url: Some(QWEN_9B_MMPROJ_URL.to_string()),
            mmproj_size_bytes: Some(QWEN_9B_MMPROJ_SIZE),
            mtp: MtpSource::None,
            kv_bytes_per_token: KV_PER_TOKEN_SMALL,
        },
        ModelInfo {
            id: "Qwen3.5-9B-Q6_K".to_string(),
            filename: "Qwen3.5-9B-Q6_K.gguf".to_string(),
            url: "https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q6_K.gguf"
                .to_string(),
            sha256: "91898433cf5ce0a8f45516a4cc3e9343b6e01d052d01f684309098c66a326c59".to_string(),
            size_bytes: 7_458_301_152,
            description: "Qwen 3.5 9B Q6 — legacy (~7.5 GB)".to_string(),
            downloaded: false,
            legacy: true,
            mmproj_filename: Some(qwen_9b_mmproj_filename()),
            mmproj_url: Some(QWEN_9B_MMPROJ_URL.to_string()),
            mmproj_size_bytes: Some(QWEN_9B_MMPROJ_SIZE),
            mtp: MtpSource::None,
            kv_bytes_per_token: KV_PER_TOKEN_SMALL,
        },
        ModelInfo {
            id: "Qwen3.5-9B-Q8_0".to_string(),
            filename: "Qwen3.5-9B-Q8_0.gguf".to_string(),
            url: "https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q8_0.gguf"
                .to_string(),
            sha256: "809626574d0cb43d4becfa56169980da2bb448f2299270f7be443cb89d0a6ae4".to_string(),
            size_bytes: 9_527_502_048,
            description: "Qwen 3.5 9B Q8 — legacy (~9.5 GB)".to_string(),
            downloaded: false,
            legacy: true,
            mmproj_filename: Some(qwen_9b_mmproj_filename()),
            mmproj_url: Some(QWEN_9B_MMPROJ_URL.to_string()),
            mmproj_size_bytes: Some(QWEN_9B_MMPROJ_SIZE),
            mtp: MtpSource::None,
            kv_bytes_per_token: KV_PER_TOKEN_SMALL,
        },
        // Superseded at the 16 GB tier by the dense Qwen 3.8 27B, which
        // fits three times the parameters in less VRAM. Kept so an existing
        // download stays usable and switchable.
        ModelInfo {
            id: "Qwen3.5-9B-UD-Q8_K_XL".to_string(),
            filename: "Qwen3.5-9B-UD-Q8_K_XL.gguf".to_string(),
            url: "https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-UD-Q8_K_XL.gguf"
                .to_string(),
            sha256: "2c4e08e0e72c68d8c1835a26f5be4075894df9ea5be9cc20a246517afd6a0cb6".to_string(),
            size_bytes: 12_974_040_288,
            description: "Qwen 3.5 9B Q8 — legacy (~13 GB)".to_string(),
            downloaded: false,
            legacy: true,
            mmproj_filename: Some(qwen_9b_mmproj_filename()),
            mmproj_url: Some(QWEN_9B_MMPROJ_URL.to_string()),
            mmproj_size_bytes: Some(QWEN_9B_MMPROJ_SIZE),
            mtp: MtpSource::None,
            kv_bytes_per_token: KV_PER_TOKEN_SMALL,
        },
        // DEAD URL — Unsloth removed this quant from the repo, so the
        // download 404s. Unlike every other legacy entry it cannot be
        // re-downloaded; it stays listed purely so a user who got it while
        // it existed (it shipped in the lineup from #199) keeps a working,
        // switchable model. Superseded by `Qwen3.8-27B-UD-IQ4_XS`.
        ModelInfo {
            id: "Qwen3.8-27B-IQ4_NL".to_string(),
            filename: "Qwen3.8-27B-IQ4_NL.gguf".to_string(),
            url: "https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/resolve/main/Qwen3.8-27B-IQ4_NL.gguf"
                .to_string(),
            sha256: "466c6714b0eca21c032690c801391a3c1e8f464ef01bbf420b70840027590c38".to_string(),
            size_bytes: 16_337_628_128,
            description: "Qwen 3.8 27B IQ4_NL — legacy (~16 GB)".to_string(),
            downloaded: false,
            legacy: true,
            mmproj_filename: Some(qwen_38_27b_mmproj_filename()),
            mmproj_url: Some(QWEN_38_27B_MMPROJ_URL.to_string()),
            mmproj_size_bytes: Some(QWEN_38_27B_MMPROJ_SIZE),
            mtp: MtpSource::Bundled,
            kv_bytes_per_token: KV_PER_TOKEN_DENSE_27B,
        },
        // Superseded by Qwen 3.8 27B, which is the same architecture at a
        // near-identical footprint. Kept so a 16 GB download isn't lost.
        ModelInfo {
            id: "Qwen3.6-27B-IQ4_NL".to_string(),
            filename: "Qwen3.6-27B-IQ4_NL.gguf".to_string(),
            url: "https://huggingface.co/unsloth/Qwen3.6-27B-GGUF/resolve/main/Qwen3.6-27B-IQ4_NL.gguf"
                .to_string(),
            sha256: "239658ade790aa63812407ad91f6365d845e689009f70d302a59d65e9eec584e".to_string(),
            size_bytes: 16_071_772_384,
            description: "Qwen 3.6 27B — legacy (~16 GB)".to_string(),
            downloaded: false,
            legacy: true,
            mmproj_filename: Some(qwen_27b_mmproj_filename()),
            mmproj_url: Some(QWEN_27B_MMPROJ_URL.to_string()),
            mmproj_size_bytes: Some(QWEN_27B_MMPROJ_SIZE),
            mtp: MtpSource::None,
            kv_bytes_per_token: KV_PER_TOKEN_DENSE_27B,
        },
    ]
}

/// The recommended lineup plus retired models, for lookups (download,
/// mmproj resolution) that must still resolve a legacy model by id/filename.
fn full_registry() -> Vec<ModelInfo> {
    let mut all = model_registry();
    all.extend(legacy_registry());
    all
}

/// Where the GGUF named `filename` gets its MTP head. Unknown filenames —
/// anything the user imported themselves — return [`MtpSource::None`]:
/// passing `--spec-type draft-mtp` to a model with no head fails the
/// server's start, and we know nothing about a stranger's file.
pub fn mtp_source_for(filename: &str) -> MtpSource {
    full_registry()
        .iter()
        .find(|m| m.filename == filename)
        .map(|m| m.mtp.clone())
        .unwrap_or(MtpSource::None)
}

/// Whether `filename` is a sibling MTP drafter belonging to some registry
/// entry. Matched against the registry rather than by a substring on the
/// name, so a user's own model that happens to contain "mtp" isn't hidden.
fn is_sibling_drafter(filename: &str) -> bool {
    full_registry()
        .iter()
        .any(|m| matches!(&m.mtp, MtpSource::Sibling { filename: f, .. } if f == filename))
}

// --- Context-size recommendation ----------------------------------------
//
// Qwen 3.5 / 3.6 are *hybrid* attention models: per their config.json only
// one layer in four (`full_attention_interval: 4`) is full attention with a
// KV cache that grows with context; the other three are linear-attention
// layers that keep a small fixed-size recurrent state. So the KV cache
// scales with context far more slowly than a pure transformer, and the rate
// differs per model. We pre-compute the per-token cost from each model's
// architecture rather than parsing GGUF headers at runtime, since the set of
// offered models is small and fixed.
//
// These are architecture-derived *estimates* (q8_0 KV cache — the server
// always passes --cache-type-k/v q8_0, see `ServerConfig::build_args` —
// batch 1). They should be calibrated against the VRAM llama-server
// actually reports for these models; the safety margins below exist to
// absorb that uncertainty plus the linear-attention state and
// compute/graph buffers.

/// Standard context sizes we'll recommend, ascending. 262144 is the
/// architectural ceiling of the Qwen 3.5 / 3.6 models we ship. Also the
/// rungs the server supervisor walks down when a start attempt fails on
/// context/KV allocation (see `server::mod` context backoff).
pub(crate) const CONTEXT_LADDER: &[u32] = &[8192, 16384, 32768, 65536, 131072, 262144];
/// Floor: never recommend below this even on tight VRAM.
pub const MIN_CONTEXT: u32 = 8192;
/// VRAM left free for the display/compositor, driver, and fragmentation.
const VRAM_RESERVE_BYTES: u64 = 1024 * 1024 * 1024;
/// Non-KV runtime cost: compute/graph buffers plus the linear-attention
/// recurrent state (a few hundred MB across the linear layers).
const COMPUTE_OVERHEAD_BYTES: u64 = 512 * 1024 * 1024;
/// Extra VRAM llama-server reserves for the MTP draft context when
/// `--spec-type draft-mtp` is on. It builds a second context against the
/// target model (`server-context.cpp`, "creating MTP draft context against
/// the target model") and reserves for it before fitting the target.
///
/// Covers the draft *context* only. A sibling drafter's weights are counted
/// separately via [`MtpSource::draft_weight_bytes`] — folding them into this
/// constant would over-charge every bundled-head model by half a gigabyte.
///
/// UNCALIBRATED — a conservative placeholder, in the same spirit as the KV
/// estimates above. Measure the reported buffer sizes with and without the
/// flag on a 24 GB card and correct this, recording the measurement here.
/// Erring high costs some context; erring low means recommending a size that
/// no longer fits, which shows up as a silent walk down the backoff ladder.
const MTP_OVERHEAD_BYTES: u64 = 512 * 1024 * 1024;

/// Optional runtime toggles that change how much VRAM is left over for the
/// KV cache. Grouped into a struct rather than passed as positional bools:
/// `context_ceiling_for(id, vram, true, false)` gives no hint which flag is
/// which, and the two have opposite senses (MTP *costs* VRAM, a CPU-resident
/// projector *frees* it).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FitOptions {
    /// `--spec-type draft-mtp` is on, so llama-server reserves a second
    /// draft context against the target model.
    pub mtp_enabled: bool,
    /// `--no-mmproj-offload` is on: the vision projector loads onto the CPU
    /// backend, so its weights never occupy VRAM.
    pub mmproj_on_cpu: bool,
}

impl FitOptions {
    /// Only the MTP preference, projector on the GPU.
    pub const fn with_mtp(mtp_enabled: bool) -> Self {
        Self {
            mtp_enabled,
            mmproj_on_cpu: false,
        }
    }
}

// Per-token KV-cache growth in bytes (q8_0) for a model's full-attention
// layers. Element count comes from config.json as
// `full_attn_layers × 2 (K+V) × n_kv_head × head_dim`; q8_0 packs 32
// elements into 34 bytes (32 one-byte quants + one f16 scale), i.e.
// 1.0625 bytes per element:
//   4B / 9B : 8 × 2 × 4 × 256 = 16384 elements × 34/32 = 17408
//   27B     : 16 × 2 × 4 × 256 = 32768 elements × 34/32 = 34816
//   35B-A3B : 10 × 2 × 2 × 256 = 10240 elements × 34/32 = 10880
// The dense 27B figures hold for Qwen 3.8 as well as 3.6 — same 64 layers,
// same `full_attention_interval: 4`, same 4 KV heads at head_dim 256.
//
// Each registry entry declares its own value (`ModelInfo::kv_bytes_per_token`,
// one of the `KV_PER_TOKEN_*` constants). This used to be a substring match on
// the model id, which returned `None` for any model whose version string
// wasn't in the list — silently disabling the context-fit prediction for the
// next model added.

/// Largest ladder rung that fits in `vram_bytes` for `model_id` *without
/// spilling KV/weights into system RAM*, or `None` when we can't model the fit
/// (the model isn't in the registry, or its architecture is unknown). Accounts
/// for the weights, vision projector, per-token KV growth, and fixed runtime
/// overhead.
///
/// The predictive context cap in Settings needs to tell "doesn't fit" apart
/// from "can't predict" so it can fail open on unknown models — hence the
/// `Option`, unlike [`recommended_context_for`], which floors both cases to
/// [`MIN_CONTEXT`].
/// Everything that occupies VRAM before the first KV token: weights, the
/// projector (unless it's pinned to the CPU), the fixed runtime reserve, and
/// — when MTP is active — the draft context *plus a sibling drafter's own
/// weights*. That last term is why this takes an [`MtpSource`] rather than a
/// bool: `MTP_OVERHEAD_BYTES` covers only the second context llama-server
/// builds, so for a separate drafter GGUF it under-counts by the whole file.
fn fixed_vram_bytes(model: &ModelInfo, opts: FitOptions) -> u64 {
    // Both have to agree, matching how `start_server` resolves the flag.
    let mtp_active = opts.mtp_enabled && model.mtp.is_supported();
    // A projector pinned to the CPU backend holds no VRAM at all, so its
    // whole footprint (0.9-1.2 GB for the models we ship) becomes KV budget.
    let mmproj_vram = if opts.mmproj_on_cpu {
        0
    } else {
        model.mmproj_size_bytes.unwrap_or(0)
    };
    let mtp_vram = if mtp_active {
        MTP_OVERHEAD_BYTES + model.mtp.draft_weight_bytes()
    } else {
        0
    };
    model.size_bytes + mmproj_vram + VRAM_RESERVE_BYTES + COMPUTE_OVERHEAD_BYTES + mtp_vram
}

pub fn context_ceiling_for(model_id: &str, vram_bytes: u64, opts: FitOptions) -> Option<u32> {
    let registry = full_registry();
    let model = registry.iter().find(|m| m.id == model_id)?;
    // 0 = architecture unknown (an imported model): can't predict, fail open.
    let kv_per_tok = match model.kv_bytes_per_token {
        KV_PER_TOKEN_UNKNOWN => return None,
        n => n,
    };
    let fixed = fixed_vram_bytes(model, opts);
    if vram_bytes <= fixed {
        return Some(MIN_CONTEXT);
    }
    let max_ctx_fit = ((vram_bytes - fixed) / kv_per_tok) as u32;
    Some(
        CONTEXT_LADDER
            .iter()
            .rev()
            .find(|&&rung| rung <= max_ctx_fit)
            .copied()
            .unwrap_or(MIN_CONTEXT),
    )
}

/// Largest standard context size for `model_id` that should fit in
/// `vram_bytes`. Returns [`MIN_CONTEXT`] when the model is unknown or VRAM is
/// too tight to model meaningfully.
pub fn recommended_context_for(model_id: &str, vram_bytes: u64, opts: FitOptions) -> u32 {
    context_ceiling_for(model_id, vram_bytes, opts).unwrap_or(MIN_CONTEXT)
}

pub struct ModelManager {
    models_dir: PathBuf,
    cancel_flag: Arc<Mutex<bool>>,
}

/// Total expected size for a (possibly resumed) download. When resuming, the
/// server's `Content-Length` covers only the *remaining* bytes, so add what's
/// already on disk; fall back to the registry's expected size when the server
/// omits `Content-Length`.
fn resume_total_size(existing_size: u64, content_length: Option<u64>, expected_size: u64) -> u64 {
    if existing_size > 0 {
        existing_size + content_length.unwrap_or(expected_size.saturating_sub(existing_size))
    } else {
        content_length.unwrap_or(expected_size)
    }
}

/// Bytes/sec for the current session — excludes the pre-existing resumed
/// bytes so a resumed download doesn't report an inflated initial speed.
fn download_speed_bps(downloaded: u64, existing_size: u64, elapsed_secs: f64) -> u64 {
    if elapsed_secs > 0.0 {
        (downloaded.saturating_sub(existing_size) as f64 / elapsed_secs) as u64
    } else {
        0
    }
}

impl ModelManager {
    pub fn new(app: &AppHandle) -> Self {
        let models_dir = app
            .path()
            .app_data_dir()
            .expect("Failed to resolve app data dir")
            .join("models");

        Self {
            models_dir,
            cancel_flag: Arc::new(Mutex::new(false)),
        }
    }

    pub fn models_dir(&self) -> &Path {
        &self.models_dir
    }

    pub async fn ensure_models_dir(&self) -> Result<(), String> {
        fs::create_dir_all(&self.models_dir)
            .await
            .map_err(|e| format!("Failed to create models directory: {}", e))
    }

    /// The current lineup plus any legacy models the user still has on disk.
    /// Legacy models that aren't downloaded are also included (so the UI can
    /// offer to re-download them behind a "show legacy" affordance); the
    /// `legacy` and `downloaded` flags let the frontend decide what to show.
    pub async fn list_models(&self) -> Vec<ModelInfo> {
        let mut registry = full_registry();
        for model in &mut registry {
            let path = self.models_dir.join(&model.filename);
            model.downloaded = path.exists();
        }
        registry
    }

    #[allow(dead_code)]
    pub async fn list_downloaded(&self) -> Vec<String> {
        let mut downloaded = Vec::new();
        if let Ok(mut entries) = fs::read_dir(&self.models_dir).await {
            while let Ok(Some(entry)) = entries.next_entry().await {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.ends_with(".gguf") {
                    downloaded.push(name);
                }
            }
        }
        downloaded
    }

    #[allow(dead_code)]
    pub fn get_model_path(&self, filename: &str) -> PathBuf {
        self.models_dir.join(filename)
    }

    pub fn find_any_model(&self) -> Option<PathBuf> {
        if let Ok(entries) = std::fs::read_dir(&self.models_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                // Skip partial downloads, mmproj files, and MTP drafters —
                // none are standalone models. `read_dir` order is arbitrary,
                // so without the drafter check this could hand back a 465 MB
                // draft head as "the model" and start the server on it.
                if name.ends_with(".gguf")
                    && !name.ends_with(".partial")
                    && !name.contains("mmproj")
                    && !is_sibling_drafter(&name)
                {
                    return Some(entry.path());
                }
            }
        }
        None
    }

    /// Given a path to a downloaded model weights file, return the path to
    /// its multimodal projector file if one exists on disk. Returns None if
    /// the model has no mmproj or the mmproj file is not present.
    pub fn find_mmproj_for_model(&self, model_path: &Path) -> Option<PathBuf> {
        let model_filename = model_path.file_name()?.to_string_lossy().to_string();
        let registry = full_registry();
        let entry = registry.iter().find(|m| m.filename == model_filename)?;
        let mmproj_filename = entry.mmproj_filename.as_ref()?;
        let mmproj_path = self.models_dir.join(mmproj_filename);
        if mmproj_path.exists() {
            Some(mmproj_path)
        } else {
            None
        }
    }

    /// Path to the sibling MTP drafter for `model_path`, when the model uses
    /// one and it's actually on disk. `None` for a bundled head (nothing to
    /// pass) and for a model whose drafter hasn't been downloaded — the
    /// caller must then leave `--spec-type draft-mtp` off, since llama.cpp
    /// only auto-discovers the sibling for `-hf` downloads, never for the
    /// local `--model` paths we pass.
    pub fn find_mtp_draft_for_model(&self, model_path: &Path) -> Option<PathBuf> {
        let model_filename = model_path.file_name()?.to_string_lossy().to_string();
        let MtpSource::Sibling { filename, .. } = mtp_source_for(&model_filename) else {
            return None;
        };
        let draft_path = self.models_dir.join(filename);
        draft_path.exists().then_some(draft_path)
    }

    /// Core resumable download: streams `url` into `partial_path` (resuming from
    /// any bytes already there when the server honors a `Range` request), emits
    /// throttled `download-progress` events tagged `stage_label`, optionally
    /// verifies a SHA-256 over the completed file, then atomically renames it to
    /// `final_path`.
    ///
    /// Callers own the "already downloaded" short-circuit, creating the
    /// destination directory, and resetting `cancel_flag` before the call.
    /// `sha_check`, when `Some((hex, ui_label))`, is verified *before* the
    /// rename so a corrupt partial is never promoted to the final path.
    #[allow(clippy::too_many_arguments)]
    async fn download_to_partial(
        &self,
        app: &AppHandle,
        url: &str,
        partial_path: &Path,
        final_path: &Path,
        expected_size: u64,
        stage_label: &str,
        sha_check: Option<(&str, &str)>,
    ) -> Result<(), String> {
        let existing_size = if partial_path.exists() {
            fs::metadata(partial_path)
                .await
                .map(|m| m.len())
                .unwrap_or(0)
        } else {
            0
        };

        info!("{}: resume from {} bytes", stage_label, existing_size);

        let client = reqwest::Client::new();
        let mut request = client.get(url);
        if existing_size > 0 {
            request = request.header("Range", format!("bytes={}-", existing_size));
        }

        let response = request
            .send()
            .await
            .map_err(|e| format!("Download failed: {}", e))?;

        if !response.status().is_success() && response.status().as_u16() != 206 {
            return Err(format!(
                "Download failed with status: {}",
                response.status()
            ));
        }

        // Only treat this as a resume when the server actually honored the
        // Range header (206). A 200 means it's sending the whole file —
        // appending that to the partial would silently corrupt it (and the
        // corrupt file would pass the 4-byte GGUF magic check).
        let resumed = existing_size > 0 && response.status().as_u16() == 206;
        if existing_size > 0 && !resumed {
            info!(
                "{}: server ignored Range (status {}), restarting from zero",
                stage_label,
                response.status()
            );
        }
        let base_offset = if resumed { existing_size } else { 0 };

        let total_size = resume_total_size(base_offset, response.content_length(), expected_size);

        let mut open_opts = tokio::fs::OpenOptions::new();
        open_opts.create(true);
        if resumed {
            open_opts.append(true);
        } else {
            open_opts.write(true).truncate(true);
        }
        let mut file = open_opts
            .open(partial_path)
            .await
            .map_err(|e| format!("Failed to open file: {}", e))?;

        let mut downloaded = base_offset;
        let start_time = std::time::Instant::now();
        let mut last_progress_time = start_time;

        use tokio::io::AsyncWriteExt;
        let mut stream = response.bytes_stream();

        while let Some(chunk_result) = StreamExt::next(&mut stream).await {
            {
                let cancel = self.cancel_flag.lock().await;
                if *cancel {
                    drop(file);
                    info!("{}: cancelled", stage_label);
                    return Err("Download cancelled".to_string());
                }
            }

            let chunk = chunk_result.map_err(|e| format!("Download error: {}", e))?;
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("Write error: {}", e))?;

            downloaded += chunk.len() as u64;

            let now = std::time::Instant::now();
            if now.duration_since(last_progress_time).as_millis() >= 100 {
                let elapsed = now.duration_since(start_time).as_secs_f64();
                let _ = app.emit(
                    "download-progress",
                    DownloadProgress {
                        downloaded,
                        total: total_size,
                        speed_bps: download_speed_bps(downloaded, base_offset, elapsed),
                        stage: stage_label.to_string(),
                    },
                );
                last_progress_time = now;
            }
        }

        file.flush()
            .await
            .map_err(|e| format!("Flush error: {}", e))?;
        drop(file);

        let elapsed = start_time.elapsed().as_secs_f64();
        let _ = app.emit(
            "download-progress",
            DownloadProgress {
                downloaded,
                total: total_size,
                speed_bps: download_speed_bps(downloaded, base_offset, elapsed),
                stage: stage_label.to_string(),
            },
        );

        if let Some((expected_sha, verify_label)) = sha_check {
            info!("{}: verifying SHA256...", stage_label);
            verify_sha256(partial_path, expected_sha, app, verify_label).await?;
        }

        fs::rename(partial_path, final_path)
            .await
            .map_err(|e| format!("Failed to finalize download: {}", e))?;

        Ok(())
    }

    /// Download a single model file with resume support and progress events.
    /// `stage_label` is included in the progress event so the UI can show
    /// "Downloading model" vs "Downloading vision projector".
    async fn download_file(
        &self,
        app: &AppHandle,
        url: &str,
        filename: &str,
        expected_size: u64,
        stage_label: &str,
    ) -> Result<PathBuf, String> {
        self.ensure_models_dir().await?;
        let final_path = self.models_dir.join(filename);
        let partial_path = self.models_dir.join(format!("{}.partial", filename));

        // Skip if already downloaded
        if final_path.exists() {
            info!("{} already downloaded: {}", stage_label, filename);
            return Ok(final_path);
        }

        self.download_to_partial(
            app,
            url,
            &partial_path,
            &final_path,
            expected_size,
            stage_label,
            None,
        )
        .await?;

        info!("{} download complete: {}", stage_label, filename);
        Ok(final_path)
    }

    pub async fn download_model(&self, app: &AppHandle, model_id: &str) -> Result<PathBuf, String> {
        // full_registry so a user can re-download a legacy model they deleted.
        let registry = full_registry();
        let model = registry
            .iter()
            .find(|m| m.id == model_id)
            .ok_or_else(|| format!("Unknown model: {}", model_id))?
            .clone();

        // Reset cancel flag
        {
            let mut cancel = self.cancel_flag.lock().await;
            *cancel = false;
        }

        // Download main weights
        let final_path = self
            .download_file(
                app,
                &model.url,
                &model.filename,
                model.size_bytes,
                "Downloading model",
            )
            .await?;

        // Verify SHA256 if we have a hash
        if !model.sha256.is_empty() {
            info!("Verifying SHA256...");
            verify_sha256(&final_path, &model.sha256, app, "Verifying model").await?;
        }

        // Download mmproj (vision projector) if the model has one
        if let (Some(mmproj_url), Some(mmproj_filename), Some(mmproj_size)) = (
            model.mmproj_url.as_ref(),
            model.mmproj_filename.as_ref(),
            model.mmproj_size_bytes,
        ) {
            let mmproj_path = self
                .download_file(
                    app,
                    mmproj_url,
                    mmproj_filename,
                    mmproj_size,
                    "Downloading vision projector",
                )
                .await?;
            if let Some(expected) = mmproj_sha256_for_url(mmproj_url) {
                info!("Verifying mmproj SHA256...");
                verify_sha256(&mmproj_path, expected, app, "Verifying vision projector").await?;
            }
        }

        // Download the MTP drafter when the head isn't bundled in the weights.
        // Same shape as the projector above: a sibling file the model is
        // useless-but-working without, so a failure here fails the download
        // rather than leaving a half-installed model.
        if let MtpSource::Sibling {
            filename,
            url,
            size_bytes,
            sha256,
        } = &model.mtp
        {
            let draft_path = self
                .download_file(app, url, filename, *size_bytes, "Downloading MTP drafter")
                .await?;
            if !sha256.is_empty() {
                info!("Verifying MTP drafter SHA256...");
                verify_sha256(&draft_path, sha256, app, "Verifying MTP drafter").await?;
            }
        }

        Ok(final_path)
    }

    pub async fn cancel_download(&self) {
        let mut cancel = self.cancel_flag.lock().await;
        *cancel = true;
    }

    pub async fn import_model(&self, source_path: &str) -> Result<ModelInfo, String> {
        let source = Path::new(source_path);

        if !source.exists() {
            return Err("File not found".to_string());
        }

        // Validate GGUF magic bytes
        validate_gguf(source).await?;

        let filename = source
            .file_name()
            .ok_or("Invalid filename")?
            .to_string_lossy()
            .to_string();

        self.ensure_models_dir().await?;
        let dest = self.models_dir.join(&filename);

        // Copy file to models dir
        fs::copy(source, &dest)
            .await
            .map_err(|e| format!("Failed to copy model: {}", e))?;

        info!("Imported model: {}", filename);

        Ok(ModelInfo {
            id: filename.trim_end_matches(".gguf").to_string(),
            filename,
            url: String::new(),
            sha256: String::new(),
            size_bytes: fs::metadata(&dest).await.map(|m| m.len()).unwrap_or(0),
            description: "Imported model".to_string(),
            downloaded: true,
            legacy: false,
            mmproj_filename: None,
            mmproj_url: None,
            mmproj_size_bytes: None,
            // Unknown architecture — nothing to predict a context fit from.
            mtp: MtpSource::None,
            kv_bytes_per_token: KV_PER_TOKEN_UNKNOWN,
        })
    }

    #[allow(dead_code)]
    pub async fn delete_model(&self, filename: &str) -> Result<(), String> {
        let path = self.models_dir.join(filename);
        if path.exists() {
            fs::remove_file(&path)
                .await
                .map_err(|e| format!("Failed to delete model: {}", e))?;
            info!("Deleted model: {}", filename);
        }
        Ok(())
    }
}

/// Streaming hash — model files run to ~38 GB, far too large for the
/// previous read-whole-file-into-memory approach.
///
/// When `app` is provided, emits throttled `download-progress` events tagged
/// with `stage_label` so the UI shows movement during the (multi-GB, tens of
/// seconds) verification pass instead of looking frozen after the download
/// bar hits 100%.
async fn compute_sha256(
    path: &Path,
    app: Option<&AppHandle>,
    stage_label: &str,
) -> Result<String, String> {
    use tokio::io::AsyncReadExt;
    let total = fs::metadata(path).await.map(|m| m.len()).unwrap_or(0);
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("Failed to read file for hashing: {}", e))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    let mut hashed: u64 = 0;
    let start = std::time::Instant::now();
    let mut last_emit = start;

    // Immediate 0% so the bar resets and the stage flips to "Verifying…"
    // the instant download finishes, rather than after the first MB is read.
    let emit = |downloaded: u64, speed_bps: u64| {
        if let Some(app) = app {
            let _ = app.emit(
                "download-progress",
                DownloadProgress {
                    downloaded,
                    total,
                    speed_bps,
                    stage: stage_label.to_string(),
                },
            );
        }
    };
    emit(0, 0);

    loop {
        let n = file
            .read(&mut buf)
            .await
            .map_err(|e| format!("Failed to read file for hashing: {}", e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        hashed += n as u64;

        let now = std::time::Instant::now();
        if now.duration_since(last_emit).as_millis() >= 100 {
            let elapsed = now.duration_since(start).as_secs_f64();
            let speed = if elapsed > 0.0 {
                (hashed as f64 / elapsed) as u64
            } else {
                0
            };
            emit(hashed, speed);
            last_emit = now;
        }
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Compare a downloaded file against its expected sha256, emitting verify
/// progress as `stage_label`; delete it on mismatch so a corrupt artifact
/// can't be picked up as a valid model.
async fn verify_sha256(
    path: &Path,
    expected: &str,
    app: &AppHandle,
    stage_label: &str,
) -> Result<(), String> {
    let hash = compute_sha256(path, Some(app), stage_label).await?;
    if !hash.eq_ignore_ascii_case(expected) {
        fs::remove_file(path).await.ok();
        return Err("Download verification failed: SHA256 mismatch".to_string());
    }
    Ok(())
}

async fn validate_gguf(path: &Path) -> Result<(), String> {
    use tokio::io::AsyncReadExt;
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| format!("Failed to read file: {}", e))?;
    let mut magic = [0u8; 4];
    if file.read_exact(&mut magic).await.is_err() {
        return Err("File too small to be a valid GGUF".to_string());
    }
    if magic != GGUF_MAGIC {
        return Err("Not a valid GGUF file (wrong magic bytes)".to_string());
    }
    Ok(())
}

// Tauri commands

#[tauri::command]
pub async fn list_models(state: tauri::State<'_, ModelManager>) -> Result<Vec<ModelInfo>, ()> {
    Ok(state.list_models().await)
}

/// Recommended context size for `model_id` given detected VRAM (MB). Lets
/// the setup UI re-derive the suggested context when the user picks a model
/// other than the hardware recommendation. `None` VRAM (integrated/unknown)
/// yields the conservative floor.
#[tauri::command]
pub async fn recommended_context_size(
    model_id: String,
    vram_mb: Option<u64>,
    mtp: Option<bool>,
    mmproj_on_cpu: Option<bool>,
) -> Result<u32, ()> {
    let opts = FitOptions {
        mtp_enabled: mtp.unwrap_or(true),
        mmproj_on_cpu: mmproj_on_cpu.unwrap_or(false),
    };
    Ok(match vram_mb {
        Some(mb) => recommended_context_for(&model_id, mb * 1024 * 1024, opts),
        None => MIN_CONTEXT,
    })
}

/// Predictive context cap for Settings: the largest size that fits in VRAM
/// *without* spilling to system RAM. `None` means "don't restrict" — either
/// VRAM is unknown or the model isn't one we can model — so the UI leaves
/// every size selectable rather than ghosting choices we can't reason about.
#[tauri::command]
pub async fn context_fit_ceiling(
    model_id: String,
    vram_mb: Option<u64>,
    mtp: Option<bool>,
    mmproj_on_cpu: Option<bool>,
) -> Result<Option<u32>, ()> {
    let opts = FitOptions {
        mtp_enabled: mtp.unwrap_or(true),
        mmproj_on_cpu: mmproj_on_cpu.unwrap_or(false),
    };
    Ok(match vram_mb {
        Some(mb) => context_ceiling_for(&model_id, mb * 1024 * 1024, opts),
        None => None,
    })
}

#[tauri::command]
pub async fn download_model(
    app: AppHandle,
    state: tauri::State<'_, ModelManager>,
    model_id: String,
) -> Result<String, String> {
    let path = state.download_model(&app, &model_id).await?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn cancel_download(state: tauri::State<'_, ModelManager>) -> Result<(), ()> {
    state.cancel_download().await;
    Ok(())
}

#[tauri::command]
pub async fn import_model(
    state: tauri::State<'_, ModelManager>,
    path: String,
) -> Result<ModelInfo, String> {
    state.import_model(&path).await
}

#[tauri::command]
pub async fn get_models_dir(state: tauri::State<'_, ModelManager>) -> Result<String, ()> {
    Ok(state.models_dir().to_string_lossy().to_string())
}

#[tauri::command]
pub async fn has_any_model(state: tauri::State<'_, ModelManager>) -> Result<bool, ()> {
    let _ = state.ensure_models_dir().await;
    Ok(state.find_any_model().is_some())
}

#[tauri::command]
pub async fn get_active_model_path(
    state: tauri::State<'_, ModelManager>,
    preferred_filename: Option<String>,
) -> Result<Option<String>, ()> {
    // Honor the caller's stored preference when the file is actually on
    // disk; otherwise fall back to "any model" so first-run users (who
    // have no preference recorded yet) and users who deleted their
    // chosen model still get a working sidecar.
    if let Some(name) = preferred_filename.as_deref().filter(|s| !s.is_empty()) {
        let path = state.models_dir().join(name);
        if path.exists() {
            return Ok(Some(path.to_string_lossy().to_string()));
        }
    }
    Ok(state
        .find_any_model()
        .map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
pub async fn delete_model(
    state: tauri::State<'_, ModelManager>,
    filename: String,
) -> Result<(), String> {
    state.delete_model(&filename).await
}

#[tauri::command]
pub async fn get_whisper_model_path(
    state: tauri::State<'_, ModelManager>,
) -> Result<Option<String>, ()> {
    let path = state.models_dir().join("whisper").join("ggml-base.en.bin");
    if path.exists() {
        Ok(Some(path.to_string_lossy().to_string()))
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub async fn download_whisper_model(
    app: AppHandle,
    state: tauri::State<'_, ModelManager>,
) -> Result<String, String> {
    let whisper_dir = state.models_dir().join("whisper");
    fs::create_dir_all(&whisper_dir)
        .await
        .map_err(|e| format!("Failed to create whisper dir: {}", e))?;

    let final_path = whisper_dir.join("ggml-base.en.bin");
    if final_path.exists() {
        return Ok(final_path.to_string_lossy().to_string());
    }

    let partial_path = whisper_dir.join("ggml-base.en.bin.partial");
    let url = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";
    let expected_size: u64 = 147_964_211;
    // LFS oid from the HuggingFace API for ggml-base.en.bin
    const WHISPER_SHA256: &str = "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002";

    // Reset cancel flag
    {
        let mut cancel = state.cancel_flag.lock().await;
        *cancel = false;
    }

    state
        .download_to_partial(
            &app,
            url,
            &partial_path,
            &final_path,
            expected_size,
            "Downloading speech model",
            Some((WHISPER_SHA256, "Verifying speech model")),
        )
        .await?;

    info!("Whisper model downloaded successfully");
    Ok(final_path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resume_total_size_fresh_download_uses_content_length() {
        assert_eq!(resume_total_size(0, Some(1000), 5000), 1000);
        assert_eq!(resume_total_size(0, None, 5000), 5000);
    }

    #[test]
    fn resume_total_size_resumed_adds_existing_to_remaining() {
        // Server reports only the remaining 600 bytes; 400 already on disk.
        assert_eq!(resume_total_size(400, Some(600), 1000), 1000);
        // No Content-Length → expected(1000) - existing(400) = 600 remaining.
        assert_eq!(resume_total_size(400, None, 1000), 1000);
    }

    #[test]
    fn resume_total_size_existing_beyond_expected_saturates() {
        assert_eq!(resume_total_size(1200, None, 1000), 1200);
    }

    #[test]
    fn download_speed_bps_basics() {
        assert_eq!(download_speed_bps(1000, 0, 0.0), 0); // no elapsed time
                                                         // 500 new bytes (downloaded 900, resumed-from 400) over 0.5s = 1000 B/s.
        assert_eq!(download_speed_bps(900, 400, 0.5), 1000);
    }

    /// No tier default may land on the context floor. A model whose weights
    /// crowd out the KV cache still "fits" as far as the picker is concerned,
    /// it just silently runs at 8k — which is the failure mode that makes a
    /// bigger model at a lower quant a bad trade.
    #[test]
    fn every_tier_default_clears_the_context_floor() {
        // (VRAM the tier targets, its default model) — cards report a little
        // under nominal, so use the same short values as the tier table.
        let tiers = [
            (8188u64, "Qwen3.5-9B-IQ4_NL"),
            (12038, "Qwen3.5-9B-UD-Q6_K_XL"),
            (16303, "gemma-4-12b-it-UD-Q6_K_XL"),
            (24110, "Qwen3.6-35B-A3B-UD-IQ4_NL"),
            (32510, "Qwen3.6-35B-A3B-UD-Q5_K_XL"),
        ];
        for (vram_mb, id) in tiers {
            let ctx = recommended_context_for(
                id,
                vram_mb * 1024 * 1024,
                FitOptions::with_mtp(true), // the shipped default
            );
            assert!(
                ctx >= 32768,
                "{id} at {vram_mb} MB recommends only {ctx} — too tight for the tier"
            );
        }

        // The opt-in alternatives have to clear it too, or picking one
        // quietly halves the window. Each is paired with the tier it belongs
        // to, since that's the only VRAM it's offered at.
        let alternatives = [
            ("Qwen3.8-27B-UD-IQ4_XS", 24110u64),
            ("Qwen3.8-27B-UD-Q4_K_XL", 32510),
        ];
        for (id, vram_mb) in alternatives {
            let ctx =
                recommended_context_for(id, vram_mb * 1024 * 1024, FitOptions::with_mtp(true));
            assert!(ctx >= 32768, "{id} at {vram_mb} MB recommends only {ctx}");
        }
    }

    /// Every lineup URL still resolves upstream, at exactly the byte count
    /// the registry declares. Network-dependent, so `#[ignore]`d — run with
    /// `cargo test -- --ignored registry_urls`.
    ///
    /// This is the check that would have caught Unsloth dropping the
    /// `Qwen3.8-27B-IQ4_NL` quant from its repo: the dense 24 GB pick 404'd
    /// for months and `model_registry_urls_are_valid` never noticed, because
    /// it only asserts the URL starts with huggingface.co.
    #[tokio::test]
    #[ignore]
    async fn registry_urls_resolve_at_the_declared_size() {
        // Knowingly dead: kept only so an existing download stays usable.
        const DEAD: &[&str] = &["Qwen3.8-27B-IQ4_NL"];

        let client = reqwest::Client::new();
        let mut checked = std::collections::HashSet::new();
        let mut failures = Vec::new();

        for model in full_registry() {
            if DEAD.contains(&model.id.as_str()) {
                continue;
            }
            let mut targets = vec![(model.url.clone(), model.size_bytes)];
            if let (Some(url), Some(size)) = (model.mmproj_url, model.mmproj_size_bytes) {
                targets.push((url, size));
            }
            // A drafter that 404s or changed size fails the download the same
            // way the weights would, so it needs the same guard.
            if let MtpSource::Sibling {
                url, size_bytes, ..
            } = &model.mtp
            {
                targets.push((url.clone(), *size_bytes));
            }
            for (url, expected) in targets {
                if !checked.insert(url.clone()) {
                    continue; // several models share one projector
                }
                let resp = match client.head(&url).send().await {
                    Ok(r) => r,
                    Err(e) => {
                        failures.push(format!("{}: request failed: {e}", url));
                        continue;
                    }
                };
                if !resp.status().is_success() {
                    failures.push(format!("{}: HTTP {}", url, resp.status()));
                    continue;
                }
                // `content_length()` is None for a HEAD response, so read the
                // header. HF also exposes `x-linked-size` for LFS objects.
                let header = |name: &str| {
                    resp.headers()
                        .get(name)
                        .and_then(|v| v.to_str().ok())
                        .and_then(|v| v.parse::<u64>().ok())
                };
                let actual = header("x-linked-size")
                    .or_else(|| header("content-length"))
                    .unwrap_or(0);
                if actual != expected {
                    failures.push(format!("{}: declared {expected}, upstream {actual}", url));
                }
            }
        }

        assert!(
            failures.is_empty(),
            "registry drift:\n  {}",
            failures.join("\n  ")
        );
    }

    #[test]
    fn model_registry_has_expected_entries() {
        let models = model_registry();
        assert_eq!(models.len(), 8);

        let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
        assert!(ids.contains(&"Qwen3.5-4B-IQ4_NL"));
        assert!(ids.contains(&"Qwen3.5-9B-IQ4_NL"));
        assert!(ids.contains(&"Qwen3.5-9B-UD-Q6_K_XL"));
        assert!(ids.contains(&"gemma-4-12b-it-UD-Q6_K_XL"));
        // 24 GB: sparse default plus the dense opt-in.
        assert!(ids.contains(&"Qwen3.6-35B-A3B-UD-IQ4_NL"));
        assert!(ids.contains(&"Qwen3.8-27B-UD-IQ4_XS"));
        // 32 GB: same again, one quant up each.
        assert!(ids.contains(&"Qwen3.6-35B-A3B-UD-Q5_K_XL"));
        assert!(ids.contains(&"Qwen3.8-27B-UD-Q4_K_XL"));

        // None of the current lineup is flagged legacy.
        assert!(models.iter().all(|m| !m.legacy));
    }

    /// The Qwen 3.6 27B was retired when 3.8 landed, but a user who already
    /// downloaded 16 GB of it keeps it: still listed, still switchable, still
    /// re-downloadable.
    #[test]
    fn retired_dense_27b_is_still_resolvable() {
        let all = full_registry();
        let retired = all
            .iter()
            .find(|m| m.id == "Qwen3.6-27B-IQ4_NL")
            .expect("Qwen 3.6 27B must remain in the full registry");
        assert!(retired.legacy);
        assert!(!retired.url.is_empty() && !retired.sha256.is_empty());
        assert!(!model_registry()
            .iter()
            .any(|m| m.id == "Qwen3.6-27B-IQ4_NL"));
    }

    /// The guard that earns the declared `kv_bytes_per_token` field: an entry
    /// added without one used to fall through the old substring match to
    /// `None`, which silently disabled context-fit prediction for that model.
    #[test]
    fn every_registry_entry_declares_kv_cost() {
        for model in full_registry() {
            assert_ne!(
                model.kv_bytes_per_token, KV_PER_TOKEN_UNKNOWN,
                "{} declares no per-token KV cost",
                model.id
            );
        }
    }

    /// Where each lineup model's MTP head comes from. Verified by reading the
    /// GGUF metadata of every lineup file for `blk.N.nextn.*` tensors: only
    /// the dense Qwen 3.8 27B quants carry one inline. The 9B quants, the 3.6
    /// 27B and the 35B-A3B carry none even though several of their HF configs
    /// declare `mtp_num_hidden_layers` / `nextn_predict_layers`, so a blanket
    /// `--spec-type draft-mtp` would fail the server's start on them.
    ///
    /// Gemma 4 12B carries none inline either, but Unsloth publishes a
    /// drafter as a separate file that fits inside the 16 GB tier's headroom
    /// — the lineup's one `Sibling`.
    #[test]
    fn mtp_head_source_is_declared_per_file() {
        const BUNDLED: &[&str] = &[
            "Qwen3.8-27B-UD-IQ4_XS",
            "Qwen3.8-27B-UD-Q4_K_XL",
            "Qwen3.8-27B-IQ4_NL", // legacy, but the head is still in the file
        ];
        const SIBLING: &[&str] = &["gemma-4-12b-it-UD-Q6_K_XL"];
        for model in full_registry() {
            let id = model.id.as_str();
            if BUNDLED.contains(&id) {
                assert_eq!(model.mtp, MtpSource::Bundled, "{id} should be bundled");
            } else if SIBLING.contains(&id) {
                assert!(
                    matches!(model.mtp, MtpSource::Sibling { .. }),
                    "{id} should carry a sibling drafter"
                );
            } else {
                assert_eq!(model.mtp, MtpSource::None, "unexpected mtp source on {id}");
            }
        }
        assert!(mtp_source_for("Qwen3.8-27B-UD-IQ4_XS.gguf").is_supported());
        assert!(mtp_source_for("gemma-4-12b-it-UD-Q6_K_XL.gguf").is_supported());
        assert!(!mtp_source_for("Qwen3.6-27B-IQ4_NL.gguf").is_supported());
        assert!(!mtp_source_for("Qwen3.5-9B-IQ4_NL.gguf").is_supported());
        // A GGUF the user dropped in themselves: we know nothing about it.
        assert!(!mtp_source_for("Some-Imported-Model.gguf").is_supported());
    }

    /// The drafter is a whole extra file in the 16 GB tier's headroom, so the
    /// thing to guard is that turning MTP on doesn't quietly cost a rung of
    /// context — the trade that made this tier pick a 12B in the first place.
    #[test]
    fn the_gemma_drafter_fits_without_costing_context() {
        let id = "gemma-4-12b-it-UD-Q6_K_XL";
        let vram = 16303 * 1024 * 1024u64; // a "16 GB" card, reported short
        let on = context_ceiling_for(id, vram, FitOptions::with_mtp(true)).unwrap();
        let off = context_ceiling_for(id, vram, FitOptions::default()).unwrap();
        assert_eq!(off, 262144, "the 12B should reach the top of the ladder");
        assert_eq!(on, off, "the drafter must not cost a rung of context");

        // And it is genuinely being charged for — an equality that held
        // because the weights were never counted would be worthless.
        let MtpSource::Sibling { size_bytes, .. } =
            mtp_source_for("gemma-4-12b-it-UD-Q6_K_XL.gguf")
        else {
            panic!("the 12B should carry a sibling drafter");
        };
        assert_eq!(size_bytes, GEMMA4_12B_MTP_SIZE);
        let registry = full_registry();
        let model = registry.iter().find(|m| m.id == id).unwrap();
        assert_eq!(
            fixed_vram_bytes(model, FitOptions::with_mtp(true))
                - fixed_vram_bytes(model, FitOptions::default()),
            MTP_OVERHEAD_BYTES + GEMMA4_12B_MTP_SIZE
        );
    }

    /// A drafter sitting in the models dir is not a model. `read_dir` order is
    /// arbitrary, so first-run autodetect could otherwise start the server on
    /// a 465 MB draft head.
    #[test]
    fn drafter_files_are_not_mistaken_for_models() {
        assert!(is_sibling_drafter(&gemma4_12b_mtp_filename()));
        assert!(!is_sibling_drafter("gemma-4-12b-it-UD-Q6_K_XL.gguf"));
        assert!(!is_sibling_drafter("My-Own-mtp-Finetune.gguf"));
    }

    /// llama-server reserves a second context for the MTP draft before fitting
    /// the target, so the same VRAM buys less context with the flag on. Not
    /// modelling that would recommend a size that no longer fits, which shows
    /// up as a silent walk down the context-backoff ladder on every start.
    #[test]
    fn mtp_costs_context_only_for_the_model_that_uses_it() {
        let vram = 24 * 1024 * 1024 * 1024;
        let with =
            context_ceiling_for("Qwen3.8-27B-IQ4_NL", vram, FitOptions::with_mtp(true)).unwrap();
        let without =
            context_ceiling_for("Qwen3.8-27B-IQ4_NL", vram, FitOptions::default()).unwrap();
        assert!(
            with <= without,
            "MTP must not increase the predicted ceiling ({with} > {without})"
        );

        // A model with no head is unaffected by the preference either way.
        for id in ["Qwen3.6-35B-A3B-UD-IQ4_NL", "Qwen3.5-9B-UD-Q6_K_XL"] {
            assert_eq!(
                context_ceiling_for(id, vram, FitOptions::with_mtp(true)),
                context_ceiling_for(id, vram, FitOptions::default()),
                "{} has no MTP head and must not pay for one",
                id
            );
        }
    }

    /// Both dense 27Bs share an architecture, so both must predict a real
    /// context — the 3.8 id matched none of the old substring arms.
    #[test]
    fn dense_27b_context_ceiling_is_predictable() {
        let vram = 24 * 1024 * 1024 * 1024;
        for id in ["Qwen3.8-27B-IQ4_NL", "Qwen3.6-27B-IQ4_NL"] {
            let ceiling = context_ceiling_for(id, vram, FitOptions::default());
            assert!(ceiling.is_some(), "{} should predict a context ceiling", id);
            assert!(ceiling.unwrap() > MIN_CONTEXT, "{} floored at MIN", id);
        }
    }

    #[test]
    fn legacy_registry_is_marked_and_disjoint() {
        let current = model_registry();
        let legacy = legacy_registry();
        assert!(legacy.iter().all(|m| m.legacy));
        // No id appears in both lists.
        for l in &legacy {
            assert!(
                !current.iter().any(|c| c.id == l.id),
                "legacy id {} also in current registry",
                l.id
            );
        }
        // full_registry is the union with no duplicate ids.
        let all = full_registry();
        assert_eq!(all.len(), current.len() + legacy.len());
    }

    #[test]
    fn recommended_context_grows_with_vram_and_clamps() {
        let gb = 1024 * 1024 * 1024u64;
        let id = "Qwen3.5-9B-IQ4_NL";

        // Too little to hold weights + overhead → floor.
        assert_eq!(
            recommended_context_for(id, 4 * gb, FitOptions::default()),
            MIN_CONTEXT
        );

        // More VRAM never recommends a smaller context.
        let c8 = recommended_context_for(id, 8 * gb, FitOptions::default());
        let c16 = recommended_context_for(id, 16 * gb, FitOptions::default());
        let c24 = recommended_context_for(id, 24 * gb, FitOptions::default());
        assert!(c8 <= c16 && c16 <= c24, "{c8} {c16} {c24}");

        // Results are real ladder rungs, never above the cap.
        for c in [c8, c16, c24] {
            assert!(CONTEXT_LADDER.contains(&c) || c == MIN_CONTEXT);
            assert!(c <= 262144);
        }

        // Unknown model → floor, not a panic.
        assert_eq!(
            recommended_context_for("nope", 24 * gb, FitOptions::default()),
            MIN_CONTEXT
        );
    }

    #[test]
    fn context_ceiling_distinguishes_cant_predict_from_doesnt_fit() {
        let gb = 1024 * 1024 * 1024u64;
        let id = "Qwen3.5-9B-UD-Q8_K_XL";

        // Unknown model → None ("can't predict" → UI leaves every size on).
        assert_eq!(
            context_ceiling_for("nope", 24 * gb, FitOptions::default()),
            None
        );

        // Known model, tight VRAM → Some(floor), NOT None. This is the case
        // that must ghost the big rungs rather than fail open.
        assert_eq!(
            context_ceiling_for(id, 4 * gb, FitOptions::default()),
            Some(MIN_CONTEXT)
        );

        // Known model, roomy VRAM → Some(rung) that's a real ladder entry and
        // at least as large as the tight-VRAM ceiling.
        let tight = context_ceiling_for(id, 12 * gb, FitOptions::default()).unwrap();
        let roomy = context_ceiling_for(id, 32 * gb, FitOptions::default()).unwrap();
        assert!(roomy >= tight, "{roomy} >= {tight}");
        assert!(CONTEXT_LADDER.contains(&roomy) || roomy == MIN_CONTEXT);

        // Ceiling and the recommendation stay in lockstep (one wraps the other).
        assert_eq!(
            recommended_context_for(id, 16 * gb, FitOptions::default()),
            context_ceiling_for(id, 16 * gb, FitOptions::default()).unwrap()
        );
    }

    /// Moving the vision projector to the CPU hands its whole footprint back
    /// to the KV cache, so the ceiling can only go up — never down.
    #[test]
    fn mmproj_on_cpu_never_lowers_the_ceiling() {
        let gb = 1024 * 1024 * 1024u64;
        let on_cpu = FitOptions {
            mtp_enabled: false,
            mmproj_on_cpu: true,
        };
        for model in full_registry() {
            for vram in [8 * gb, 12 * gb, 16 * gb, 24 * gb] {
                let (Some(gpu), Some(cpu)) = (
                    context_ceiling_for(&model.id, vram, FitOptions::default()),
                    context_ceiling_for(&model.id, vram, on_cpu),
                ) else {
                    continue;
                };
                assert!(
                    cpu >= gpu,
                    "{} at {} GB: projector on CPU gave {cpu}, on GPU gave {gpu}",
                    model.id,
                    vram / gb
                );
            }
        }
    }

    /// A ModelInfo with the shape of a real lineup entry, for exercising the
    /// VRAM arithmetic against cases the registry doesn't hold yet.
    fn synthetic_model(mtp: MtpSource) -> ModelInfo {
        ModelInfo {
            id: "Synthetic-26B".to_string(),
            filename: "Synthetic-26B.gguf".to_string(),
            url: String::new(),
            sha256: String::new(),
            size_bytes: 13_597_177_568,
            description: String::new(),
            downloaded: false,
            legacy: false,
            mmproj_filename: None,
            mmproj_url: None,
            mmproj_size_bytes: Some(1_193_058_784),
            mtp,
            kv_bytes_per_token: KV_PER_TOKEN_35B_A3B,
        }
    }

    /// The bug this enum exists to fix: `MTP_OVERHEAD_BYTES` covers the draft
    /// *context*, so a drafter that ships as its own GGUF used to cost
    /// nothing in the fit — under-counting by the size of the whole file.
    #[test]
    fn sibling_drafter_weights_count_against_the_fit() {
        let draft_bytes = 461_766_816;
        let on = FitOptions::with_mtp(true);

        let bundled = fixed_vram_bytes(&synthetic_model(MtpSource::Bundled), on);
        let sibling = fixed_vram_bytes(
            &synthetic_model(MtpSource::Sibling {
                filename: "mtp.gguf".to_string(),
                url: String::new(),
                size_bytes: draft_bytes,
                sha256: String::new(),
            }),
            on,
        );

        assert_eq!(
            sibling - bundled,
            draft_bytes,
            "a sibling drafter costs its own weights on top of the draft context"
        );

        // And a bundled head still costs only the draft context, so counting
        // the sibling didn't over-charge everything else.
        let off = fixed_vram_bytes(&synthetic_model(MtpSource::Bundled), FitOptions::default());
        assert_eq!(bundled - off, MTP_OVERHEAD_BYTES);
    }

    /// With MTP off nothing is loaded, so where the head lives is irrelevant.
    #[test]
    fn mtp_source_is_free_when_the_preference_is_off() {
        let off = FitOptions::default();
        let sibling = MtpSource::Sibling {
            filename: "mtp.gguf".to_string(),
            url: String::new(),
            size_bytes: 461_766_816,
            sha256: String::new(),
        };
        assert_eq!(
            fixed_vram_bytes(&synthetic_model(sibling), off),
            fixed_vram_bytes(&synthetic_model(MtpSource::None), off)
        );
    }

    /// An imported model is a stranger's file: never claim it has a head.
    #[test]
    fn unknown_filenames_report_no_mtp_head() {
        assert_eq!(
            mtp_source_for("something-the-user-imported.gguf"),
            MtpSource::None
        );
        assert_eq!(
            mtp_source_for("Qwen3.8-27B-IQ4_NL.gguf"),
            MtpSource::Bundled
        );
    }

    /// The 8 GB tier is the one that gains most: the 9B's 0.9 GB projector is
    /// worth a full rung of context there. Guards the wiring end to end —
    /// a flag that silently didn't reach `fixed` would leave these equal.
    #[test]
    fn mmproj_on_cpu_buys_context_on_the_default_tier() {
        let vram = 8188 * 1024 * 1024u64; // a "8 GB" card, reported short
        let id = "Qwen3.5-9B-IQ4_NL";
        let gpu = context_ceiling_for(id, vram, FitOptions::default()).unwrap();
        let cpu = context_ceiling_for(
            id,
            vram,
            FitOptions {
                mtp_enabled: false,
                mmproj_on_cpu: true,
            },
        )
        .unwrap();
        assert!(cpu > gpu, "expected a bigger ceiling, got {cpu} vs {gpu}");
    }

    #[test]
    fn model_registry_urls_are_valid() {
        for model in full_registry() {
            assert!(
                model.url.starts_with("https://huggingface.co/"),
                "Invalid URL for {}: {}",
                model.id,
                model.url
            );
            assert!(
                model.url.ends_with(".gguf"),
                "URL should end with .gguf for {}",
                model.id
            );
        }
    }

    #[test]
    fn model_registry_sizes_reasonable() {
        for model in model_registry() {
            assert!(
                model.size_bytes > 1_000_000_000,
                "Model {} size too small: {}",
                model.id,
                model.size_bytes
            );
            assert!(
                model.size_bytes < 40_000_000_000,
                "Model {} size too large: {}",
                model.id,
                model.size_bytes
            );
        }
    }

    #[tokio::test]
    async fn validate_gguf_rejects_invalid_file() {
        let dir = std::env::temp_dir().join("haruspex_test_gguf");
        fs::create_dir_all(&dir).await.unwrap();

        let bad_file = dir.join("bad.gguf");
        fs::write(&bad_file, b"not a gguf file").await.unwrap();

        let result = validate_gguf(&bad_file).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("wrong magic bytes"));

        fs::remove_dir_all(&dir).await.ok();
    }

    #[tokio::test]
    async fn validate_gguf_accepts_valid_magic() {
        let dir = std::env::temp_dir().join("haruspex_test_gguf_valid");
        fs::create_dir_all(&dir).await.unwrap();

        let good_file = dir.join("good.gguf");
        let mut data = GGUF_MAGIC.to_vec();
        data.extend_from_slice(&[0u8; 100]); // pad with zeros
        fs::write(&good_file, &data).await.unwrap();

        let result = validate_gguf(&good_file).await;
        assert!(result.is_ok());

        fs::remove_dir_all(&dir).await.ok();
    }

    #[tokio::test]
    async fn validate_gguf_rejects_too_small() {
        let dir = std::env::temp_dir().join("haruspex_test_gguf_small");
        fs::create_dir_all(&dir).await.unwrap();

        let small_file = dir.join("tiny.gguf");
        fs::write(&small_file, b"GG").await.unwrap();

        let result = validate_gguf(&small_file).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("too small"));

        fs::remove_dir_all(&dir).await.ok();
    }

    #[tokio::test]
    async fn compute_sha256_works() {
        let dir = std::env::temp_dir().join("haruspex_test_sha256");
        fs::create_dir_all(&dir).await.unwrap();

        let file = dir.join("test.bin");
        fs::write(&file, b"hello world").await.unwrap();

        let hash = compute_sha256(&file, None, "").await.unwrap();
        assert_eq!(
            hash,
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );

        fs::remove_dir_all(&dir).await.ok();
    }
}
