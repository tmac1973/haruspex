//! Cross-platform hardware probing: detect the GPU (Vulkan/Metal), read its
//! VRAM, and recommend a model quant + context size to fit it. Kept separate
//! from `models` (download/registry) because GPU detection is a distinct
//! concern that only happens to feed the same first-run setup flow.

use serde::Serialize;
#[cfg(any(target_os = "linux", target_os = "windows"))]
use std::path::Path;

#[derive(Clone, Debug, Serialize)]
pub struct HardwareInfo {
    pub gpu_available: bool,
    pub gpu_name: Option<String>,
    pub gpu_api: Option<String>,
    /// What the GPU can hold. For one that shares system memory, what Vulkan
    /// says it may use of it (often more than the BIOS carve-out); on a Mac,
    /// what Metal lets it keep resident ([`metal_working_set_mb`]).
    pub gpu_vram_mb: Option<u64>,
    /// The memory the recommendation was sized for: the VRAM, or on a Mac
    /// the smaller of Metal's share and the RAM free now, since the OS and
    /// every other app draw on the same memory. `None` when unknown.
    pub model_memory_mb: Option<u64>,
    /// The GPU shares system memory (integrated graphics, an APU): its
    /// "VRAM" is RAM, so the wizard doesn't call it VRAM.
    pub gpu_integrated: bool,
    /// Integrated graphics too slow for a large model, so a small one is
    /// recommended. False for the fast APUs (Strix Halo) that run big models.
    pub gpu_integrated_slow: bool,
    pub total_ram_mb: u64,
    pub available_ram_mb: u64,
    pub recommended_quant: String,
    pub recommended_context_size: u32,
    /// A bigger MoE model the wizard can offer beside the recommendation,
    /// running with its experts in system RAM. See [`offload_alternative`].
    pub offload_alternative: Option<OffloadAlternative>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct OffloadAlternative {
    pub model_id: String,
    pub context_size: u32,
    /// Its experts go to system RAM ("Let models use system RAM" on). False
    /// on integrated graphics, where the whole model already sits in shared
    /// memory and is offered for being about as fast as the small one.
    pub spill: bool,
}

/// The MoE the wizard offers with its experts in system RAM.
const OFFLOAD_CANDIDATE: &str = "Qwen3.6-35B-A3B-UD-IQ4_NL";
/// Smallest card worth offering it on: an "8 GB" card, reported short.
const OFFLOAD_MIN_VRAM_MB: u64 = 7168;
/// From this much VRAM the tier table already recommends the MoE itself.
const OFFLOAD_MAX_VRAM_MB: u64 = 23552;
/// "32 GB" of RAM, reported short. Below it the experts would leave too
/// little for the OS, the browser and everything else the user runs.
const OFFLOAD_MIN_RAM_MB: u64 = 31744;

/// The larger model the hardware step offers as a second choice: the MoE
/// with its experts in RAM, when the card is discrete with 8–24 GB, the
/// machine has 32 GB of RAM or more, and the non-expert part plus a usable
/// context fits in VRAM. Not for integrated GPUs (their "VRAM" is the same
/// RAM) or unknown VRAM (macOS reports none; its unified memory already
/// serves the tier table).
fn offload_alternative(
    vram_mb: Option<u64>,
    integrated: bool,
    total_ram_mb: u64,
    recommended: &str,
) -> Option<OffloadAlternative> {
    let vram_mb = vram_mb.filter(|_| !integrated)?;
    if !(OFFLOAD_MIN_VRAM_MB..OFFLOAD_MAX_VRAM_MB).contains(&vram_mb)
        || total_ram_mb < OFFLOAD_MIN_RAM_MB
        || recommended == OFFLOAD_CANDIDATE
    {
        return None;
    }
    let mb = 1024 * 1024;
    let context_size = crate::models::expert_offload_context(
        OFFLOAD_CANDIDATE,
        vram_mb * mb,
        crate::models::ram_offload_budget(total_ram_mb * mb),
        crate::models::FitOptions::with_mtp(true),
    )?;
    Some(OffloadAlternative {
        model_id: OFFLOAD_CANDIDATE.to_string(),
        context_size,
        spill: true,
    })
}

/// The second choice on slow integrated graphics: the same MoE, whole, in
/// the memory the GPU shares. Generating on an iGPU is bound by memory
/// bandwidth, so speed follows the parameters each token reads: the MoE
/// reads about 3B, as fast as the 4B recommended, while knowing far more. A
/// dense model past ~9B reads all of itself and crawls, so none is offered.
/// Only with 32 GB of RAM or more, and where the model fits what Vulkan
/// lets the GPU use.
fn integrated_alternative(heap_mb: Option<u64>, total_ram_mb: u64) -> Option<OffloadAlternative> {
    let heap_mb = heap_mb?;
    if total_ram_mb < OFFLOAD_MIN_RAM_MB {
        return None;
    }
    let context_size = crate::models::context_if_fits(
        OFFLOAD_CANDIDATE,
        heap_mb * 1024 * 1024,
        crate::models::FitOptions::with_mtp(true),
    )?;
    Some(OffloadAlternative {
        model_id: OFFLOAD_CANDIDATE.to_string(),
        context_size,
        spill: false,
    })
}

#[derive(Clone, Debug, PartialEq)]
struct GpuInfo {
    available: bool,
    name: Option<String>,
    api: Option<String>,
    vram_mb: Option<u64>,
    /// Shares system memory.
    integrated: bool,
}

/// Recommended quant by effective VRAM (MB) for a discrete GPU with known
/// memory. Ascending thresholds; the first entry whose threshold the VRAM
/// is *below* wins. The final `u64::MAX` row is the catch-all.
///
/// The thresholds sit ~1 GB *below* each nominal capacity on purpose. Cards do
/// not report their nominal size — the figure is the device-local heap, which
/// comes in some tens of MB short (a 12 GB card reports ~12,0xx MB). With a
/// threshold of exactly 12288 such a card falls into the row below and gets a
/// model sized for 8 GB, which is the bug this table has always had at the
/// 8 GB and 16 GB boundaries.
const QUANT_BY_VRAM_MB: &[(u64, &str)] = &[
    (7168, "Qwen3.5-4B-IQ4_NL"),              // < ~8 GB
    (11264, "Qwen3.5-9B-IQ4_NL"),             // ~8–12 GB (default tier)
    (15360, "Qwen3.5-9B-UD-Q6_K_XL"),         // ~12–16 GB
    (23552, "gemma-4-12b-it-UD-Q6_K_XL"),     // ~16–24 GB
    (31744, "Qwen3.6-35B-A3B-UD-IQ4_NL"),     // ~24–32 GB → sparse MoE (dense 27B is opt-in)
    (u64::MAX, "Qwen3.6-35B-A3B-UD-Q5_K_XL"), // 32 GB+ → the same MoE at Q5
];

/// Pick the value for the first tier whose threshold `vram_mb` falls below.
/// Equivalent to an ascending `if vram < a { .. } else if vram < b { .. }`
/// ladder; the table must end with a `u64::MAX` sentinel row.
fn tier_lookup<T: Copy>(table: &[(u64, T)], vram_mb: u64) -> T {
    table
        .iter()
        .find(|(threshold, _)| vram_mb < *threshold)
        .map(|(_, value)| *value)
        .expect("tier table must end with a u64::MAX sentinel")
}

/// Installed system RAM in bytes. Cheap: reads memory counters only, unlike
/// [`detect_hardware`], which also probes the GPU.
pub fn total_ram_bytes() -> u64 {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    sys.total_memory()
}

/// What the hardware step recommends for one GPU.
#[derive(Debug, PartialEq)]
struct Recommendation {
    quant: &'static str,
    context_size: u32,
    memory_mb: Option<u64>,
    integrated_slow: bool,
    alternative: Option<OffloadAlternative>,
}

/// The model, context and second choice for `gpu`. Pure, so every case can
/// be tested without the hardware.
///
/// - Slow integrated graphics → the 4B, whatever memory it reports: an iGPU
///   with a 16 GB carve-out looks like a 16 GB card and runs like none. The
///   MoE is offered beside it (see [`integrated_alternative`]).
/// - A fast APU (Strix Halo) → by the memory it may use, like a card.
/// - Unknown GPU and no VRAM → the 4B, the safe guess.
/// - A discrete GPU → by VRAM; unknown VRAM → by available RAM.
/// - A Mac → by Metal's share of unified memory, capped at the RAM free now.
fn recommend(gpu: &GpuInfo, total_ram_mb: u64, available_ram_mb: u64) -> Recommendation {
    let fast_apu = gpu.integrated && gpu.name.as_deref().is_some_and(is_fast_apu);
    let integrated_slow = gpu.integrated && !fast_apu;
    let unified = is_metal(gpu);
    // Unified memory is the OS's and every other app's as well, so a Mac is
    // sized to what is free now too, not only to what Metal would allow.
    let memory_mb = match gpu.vram_mb {
        Some(mb) if unified => Some(mb.min(available_ram_mb)),
        other => other,
    };
    let quant = if integrated_slow || (gpu.name.is_none() && gpu.vram_mb.is_none()) {
        "Qwen3.5-4B-IQ4_NL"
    } else {
        tier_lookup(QUANT_BY_VRAM_MB, memory_mb.unwrap_or(available_ram_mb))
    };
    // Context: computed per-model from the quant's weights, projector and
    // per-token KV growth against the memory found (see
    // `models::recommended_context_for`). Slow integrated graphics are sized
    // like a card too — they are slow at generating, not short of memory —
    // but against no more than the RAM free now, since what Vulkan lets them
    // use is system RAM the OS and other apps draw on. Unknown memory gets
    // the floor.
    let context_mb = match memory_mb {
        Some(mb) if integrated_slow => Some(mb.min(available_ram_mb)),
        other => other,
    };
    let context_size = match context_mb {
        // First run has no saved preference, so assume the default (on).
        // Models without an MTP head are unaffected either way.
        Some(mb) => crate::models::recommended_context_for(
            quant,
            mb * 1024 * 1024,
            crate::models::FitOptions::with_mtp(true),
        ),
        None => crate::models::MIN_CONTEXT,
    };
    let alternative = if integrated_slow {
        integrated_alternative(gpu.vram_mb, total_ram_mb)
    } else {
        // Spilling experts to "system RAM" gains nothing when the GPU's
        // memory is system RAM already.
        offload_alternative(memory_mb, gpu.integrated || unified, total_ram_mb, quant)
    };
    Recommendation {
        quant,
        context_size,
        memory_mb,
        integrated_slow,
        alternative,
    }
}

/// Probe without llama.cpp's view (tests, and where it can't run).
pub fn detect_hardware() -> HardwareInfo {
    detect_hardware_with(None)
}

/// `devices`: what llama.cpp's Vulkan backend reports ([`probe_vulkan`]),
/// which settles whether the GPU is integrated better than its name does.
fn detect_hardware_with(devices: Option<&[VulkanDevice]>) -> HardwareInfo {
    use sysinfo::System;

    let mut sys = System::new_all();
    sys.refresh_memory();

    let total_ram_mb = sys.total_memory() / 1_048_576;
    let available_ram_mb = sys.available_memory() / 1_048_576;

    let gpu = match devices {
        Some(d) => with_vulkan_devices(detect_gpu(), d),
        None => detect_gpu(),
    };
    let rec = recommend(&gpu, total_ram_mb, available_ram_mb);

    HardwareInfo {
        gpu_available: gpu.available,
        gpu_name: gpu.name,
        gpu_api: gpu.api,
        gpu_vram_mb: gpu.vram_mb,
        model_memory_mb: rec.memory_mb,
        gpu_integrated: gpu.integrated,
        gpu_integrated_slow: rec.integrated_slow,
        total_ram_mb,
        available_ram_mb,
        recommended_quant: rec.quant.to_string(),
        recommended_context_size: rec.context_size,
        offload_alternative: rec.alternative,
    }
}

/// One GPU as llama.cpp's Vulkan backend sees it (`llama-server --verbose
/// --list-devices`).
#[derive(Clone, Debug, PartialEq)]
struct VulkanDevice {
    name: String,
    /// Unified memory: the device shares system memory. The driver's own
    /// device type, so it holds for any name.
    uma: bool,
    /// What Vulkan says the device may use, in MiB.
    total_mb: Option<u64>,
}

/// Parse `llama-server --verbose --list-devices`. Two kinds of line matter,
/// matched by device index:
///
/// ```text
/// 0.00.059.931 D ggml_vulkan: 0 = AMD Radeon(TM) Graphics (AMD proprietary driver) | uma: 1 | fp16: 1 | …
///   Vulkan0: AMD Radeon(TM) Graphics (24445 MiB, 23223 MiB free)
/// ```
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn parse_vulkan_devices(output: &str) -> Vec<VulkanDevice> {
    let mut devices: Vec<(usize, VulkanDevice)> = Vec::new();
    for line in output.lines() {
        if let Some((_, rest)) = line.split_once("ggml_vulkan: ") {
            let Some((index, rest)) = rest.split_once(" = ") else {
                continue;
            };
            let Ok(index) = index.trim().parse::<usize>() else {
                continue;
            };
            let mut fields = rest.split(" | ");
            let head = fields.next().unwrap_or_default().trim();
            // The driver comes last, in parentheses: "Name (driver)".
            let name = match head.rfind(" (") {
                Some(i) if head.ends_with(')') => &head[..i],
                _ => head,
            };
            let uma = fields.any(|f| f.trim() == "uma: 1");
            devices.push((
                index,
                VulkanDevice {
                    name: name.to_string(),
                    uma,
                    total_mb: None,
                },
            ));
        } else if let Some(rest) = line.trim_start().strip_prefix("Vulkan") {
            let Some((index, rest)) = rest.split_once(": ") else {
                continue;
            };
            let Ok(index) = index.parse::<usize>() else {
                continue;
            };
            // "Name (24445 MiB, 23223 MiB free)"
            let total = rest
                .rfind(" (")
                .and_then(|i| rest[i + 2..].split(' ').next())
                .and_then(|n| n.parse::<u64>().ok());
            if let Some((_, d)) = devices.iter_mut().find(|(i, _)| *i == index) {
                d.total_mb = total;
            }
        }
    }
    devices.into_iter().map(|(_, d)| d).collect()
}

/// `gpu` corrected by what llama.cpp's Vulkan backend found. llama.cpp uses
/// the discrete GPUs when there are any and an integrated one only when
/// there is nothing else, so that is the GPU that matters: a discrete one
/// means not integrated, whatever the name check thought; only integrated
/// ones mean integrated, with the memory Vulkan lets it use.
fn with_vulkan_devices(mut gpu: GpuInfo, devices: &[VulkanDevice]) -> GpuInfo {
    if devices.is_empty() {
        return gpu;
    }
    if let Some(discrete) = devices.iter().find(|d| !d.uma) {
        gpu.integrated = false;
        if gpu.name.is_none() {
            gpu.name = Some(discrete.name.clone());
        }
    } else {
        let igpu = &devices[0];
        gpu.integrated = true;
        if gpu.name.is_none() {
            gpu.name = Some(igpu.name.clone());
        }
        gpu.vram_mb = igpu.total_mb.or(gpu.vram_mb);
    }
    gpu
}

/// Ask the bundled llama-server which Vulkan devices it sees, once per run
/// of the app (Settings → Inference asks every time it opens). None when it
/// can't be run or says nothing useful; the name check then decides.
#[cfg(any(target_os = "linux", target_os = "windows"))]
async fn probe_vulkan(app: &tauri::AppHandle) -> Option<Vec<VulkanDevice>> {
    static PROBED: tokio::sync::OnceCell<Option<Vec<VulkanDevice>>> =
        tokio::sync::OnceCell::const_new();
    PROBED.get_or_init(|| run_vulkan_probe(app)).await.clone()
}

/// How long `--list-devices` gets; it answers in well under a second.
#[cfg(any(target_os = "linux", target_os = "windows"))]
const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

#[cfg(any(target_os = "linux", target_os = "windows"))]
async fn run_vulkan_probe(app: &tauri::AppHandle) -> Option<Vec<VulkanDevice>> {
    use tauri_plugin_shell::process::CommandEvent;
    use tauri_plugin_shell::ShellExt;
    let cmd = app
        .shell()
        .sidecar("haruspex-llama-server")
        .ok()?
        .args(["--verbose", "--list-devices"]);
    let (mut rx, child) = crate::sidecar_util::with_library_paths(cmd, app)
        .spawn()
        .ok()?;
    let read = async {
        let mut text = String::new();
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                    text.push_str(&String::from_utf8_lossy(&line));
                    text.push('\n');
                }
                CommandEvent::Terminated(_) => break,
                _ => {}
            }
        }
        text
    };
    let text = match tokio::time::timeout(PROBE_TIMEOUT, read).await {
        Ok(text) => text,
        Err(_) => {
            // A binary that doesn't know `--list-devices` may just run.
            log::warn!("hardware: llama-server --list-devices didn't finish; stopped it");
            let _ = child.kill();
            return None;
        }
    };
    let devices = parse_vulkan_devices(&text);
    if devices.is_empty() {
        log::info!("hardware: llama-server listed no Vulkan devices");
        return None;
    }
    log::info!("hardware: llama-server's Vulkan devices: {devices:?}");
    Some(devices)
}

/// macOS runs Metal; there is nothing integrated to tell apart.
#[cfg(not(any(target_os = "linux", target_os = "windows")))]
async fn probe_vulkan(_app: &tauri::AppHandle) -> Option<Vec<VulkanDevice>> {
    None
}

/// A name in lower case without trademark marks or brackets, single-spaced:
/// `AMD Radeon(TM) Graphics` → `amd radeon graphics`.
fn normalized_gpu_name(name: &str) -> String {
    name.to_lowercase()
        .replace("(tm)", " ")
        .replace("(r)", " ")
        .replace(['[', ']', ',', '(', ')'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// The APUs with memory bandwidth enough for a big model: AMD's Strix Halo
/// (Radeon 8060S / 8050S / 8040S, up to 128 GB unified). Integrated, but
/// recommended for like a card of the memory they may use.
fn is_fast_apu(name: &str) -> bool {
    let n = normalized_gpu_name(name);
    n.split(' ')
        .any(|w| matches!(w, "8060s" | "8050s" | "8040s"))
}

/// Whether a GPU's name reads as integrated graphics. The fallback for when
/// llama.cpp's device list can't be had (see [`with_vulkan_devices`]); names
/// are marketing, so this only knows the common ones:
///
/// - Intel: integrated unless an Arc card with a model number (A380, A770,
///   B580, Pro A60). `Intel(R) Arc(TM) Graphics` and Arc 140V are integrated.
/// - AMD: `Radeon Graphics`, `Radeon 680M` and the like (three digits and
///   M), `Radeon 8060S` (Strix Halo: four digits and S), and Vega without
///   "RX". Windows writes `AMD Radeon(TM) Graphics`; the marks are ignored.
// Only the Linux and Windows probes read names; macOS reports Apple Silicon.
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn is_integrated_gpu(name: &str) -> bool {
    let n = normalized_gpu_name(name);
    let words: Vec<&str> = n.split(' ').collect();
    if n.contains("intel") {
        let discrete_arc = n.contains("arc")
            && words
                .windows(2)
                .any(|w| matches!(w[0], "arc" | "pro") && is_arc_card_model(w[1]));
        return !discrete_arc;
    }
    if n.contains("amd") || n.contains("radeon") || n.contains("ati") {
        if n.contains("radeon graphics") {
            return true;
        }
        let apu_model = words.iter().any(|w| {
            let digits = w.chars().take_while(|c| c.is_ascii_digit()).count();
            let suffix = &w[digits..];
            (digits == 3 && suffix == "m") || (digits == 4 && suffix == "s")
        });
        if apu_model {
            return true;
        }
        if n.contains("vega") && !words.contains(&"rx") {
            return true;
        }
    }
    false
}

/// An Arc discrete card's model: A or B and two or three digits (A380,
/// A770, B580). Not "graphics", and not the integrated 140V.
// Only the Linux and Windows probes read names; macOS reports Apple Silicon.
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn is_arc_card_model(w: &str) -> bool {
    let mut chars = w.chars();
    matches!(chars.next(), Some('a' | 'b')) && {
        let digits: Vec<char> = chars.collect();
        (2..=3).contains(&digits.len()) && digits.iter().all(|c| c.is_ascii_digit())
    }
}

/// Success tail shared by the Linux and Windows Vulkan probes: wrap a
/// detected adapter into a `GpuInfo`, classifying integrated-vs-discrete
/// from the adapter name.
#[cfg(any(target_os = "linux", target_os = "windows"))]
fn vulkan_gpu_info(name: Option<String>, vram_mb: Option<u64>) -> GpuInfo {
    let integrated = name.as_deref().map(is_integrated_gpu).unwrap_or(false);
    GpuInfo {
        available: true,
        name,
        api: Some("Vulkan".to_string()),
        vram_mb,
        integrated,
    }
}

#[cfg(target_os = "linux")]
fn detect_gpu() -> GpuInfo {
    let vulkan_available = Path::new("/usr/lib/libvulkan.so").exists()
        || Path::new("/usr/lib/x86_64-linux-gnu/libvulkan.so").exists()
        || Path::new("/usr/lib64/libvulkan.so").exists()
        || Path::new("/usr/lib/libvulkan.so.1").exists()
        || Path::new("/usr/lib/x86_64-linux-gnu/libvulkan.so.1").exists()
        || Path::new("/usr/lib64/libvulkan.so.1").exists();

    if !vulkan_available {
        return GpuInfo {
            available: false,
            name: None,
            api: None,
            vram_mb: None,
            integrated: false,
        };
    }

    // Prefer nvidia-smi when a discrete NVIDIA GPU is present. NVIDIA's driver
    // doesn't expose `mem_info_vram_total` in DRM sysfs, so the fallback below
    // would skip the NVIDIA card entirely and instead read an AMD/Intel iGPU's
    // small UMA carveout (e.g. a 2 GB Radeon iGPU shadowing a 16 GB RTX). Going
    // through nvidia-smi keeps the reported name and VRAM tied to the same GPU.
    if let Some((name, vram_mb)) = get_linux_nvidia_gpu() {
        return GpuInfo {
            available: true,
            name: Some(name),
            api: Some("Vulkan".to_string()),
            vram_mb: Some(vram_mb),
            integrated: false,
        };
    }

    vulkan_gpu_info(get_linux_gpu_name(), get_linux_vram_mb())
}

#[cfg(target_os = "linux")]
fn get_linux_gpu_name() -> Option<String> {
    // Try reading from DRM subsystem
    for i in 0..4 {
        let path = format!("/sys/class/drm/card{}/device/label", i);
        if let Ok(name) = std::fs::read_to_string(&path) {
            let name = name.trim().to_string();
            if !name.is_empty() {
                return Some(name);
            }
        }
    }

    // Fallback: try lspci — prefer discrete GPU lines
    if let Ok(output) = std::process::Command::new("lspci").output() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut first_vga = None;
        for line in stdout.lines() {
            if line.contains("VGA") || line.contains("3D") || line.contains("Display") {
                if let Some(name) = line.split(": ").nth(1) {
                    // Prefer 3D controller or non-Intel VGA (discrete GPU)
                    if line.contains("3D") || !name.to_lowercase().contains("intel") {
                        return Some(name.to_string());
                    }
                    if first_vga.is_none() {
                        first_vga = Some(name.to_string());
                    }
                }
            }
        }
        return first_vga;
    }

    None
}

/// Query a discrete NVIDIA GPU's name and total VRAM via `nvidia-smi`.
/// Returns `None` when nvidia-smi is absent or reports no GPU (i.e. there is
/// no usable NVIDIA card), so callers fall back to the DRM/sysfs path.
#[cfg(target_os = "linux")]
fn get_linux_nvidia_gpu() -> Option<(String, u64)> {
    let output = std::process::Command::new("nvidia-smi")
        .args([
            "--query-gpu=name,memory.total",
            "--format=csv,noheader,nounits",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_nvidia_smi(&String::from_utf8_lossy(&output.stdout))
}

/// Parse the first line of `nvidia-smi --query-gpu=name,memory.total
/// --format=csv,noheader,nounits`, e.g. `NVIDIA GeForce RTX 5080, 16303`.
/// `memory.total` is reported in MiB with `nounits`. Split from the right so a
/// comma in the device name can't corrupt the memory field.
#[cfg(target_os = "linux")]
fn parse_nvidia_smi(stdout: &str) -> Option<(String, u64)> {
    let line = stdout.lines().next()?.trim();
    let (name, mem) = line.rsplit_once(',')?;
    let vram_mb = mem.trim().parse::<u64>().ok()?;
    if vram_mb == 0 {
        return None;
    }
    Some((name.trim().to_string(), vram_mb))
}

#[cfg(target_os = "linux")]
fn get_linux_vram_mb() -> Option<u64> {
    // Read VRAM from DRM memory info (amdgpu/i915/xe expose this; NVIDIA does
    // not — that case is handled by nvidia-smi in detect_gpu). Take the largest
    // value across cards so a discrete GPU isn't shadowed by an integrated
    // GPU's small UMA carveout when both are present.
    let mut best_bytes = 0u64;
    for i in 0..8 {
        let path = format!("/sys/class/drm/card{}/device/mem_info_vram_total", i);
        if let Ok(contents) = std::fs::read_to_string(&path) {
            if let Ok(bytes) = contents.trim().parse::<u64>() {
                best_bytes = best_bytes.max(bytes);
            }
        }
    }
    (best_bytes > 0).then_some(best_bytes / 1_048_576)
}

#[cfg(target_os = "macos")]
fn detect_gpu() -> GpuInfo {
    // Metal is always available on supported macOS hardware.
    // Apple Silicon shares unified memory, not traditional VRAM.
    GpuInfo {
        available: true,
        name: Some("Apple GPU".to_string()),
        api: Some("Metal".to_string()),
        vram_mb: Some(metal_working_set_mb(total_ram_bytes() / 1_048_576)),
        integrated: false, // Apple Silicon is fast enough, don't penalize
    }
}

/// The share of unified memory macOS lets Metal keep resident: two thirds
/// of RAM up to 36 GB, three quarters above. The default behind
/// `MTLDevice.recommendedMaxWorkingSetSize`, which llama.cpp budgets
/// against. Without it a Mac had no VRAM figure, and every one was given
/// the 8K context floor whatever its memory.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn metal_working_set_mb(total_ram_mb: u64) -> u64 {
    if total_ram_mb <= 36 * 1024 {
        total_ram_mb * 2 / 3
    } else {
        total_ram_mb * 3 / 4
    }
}

/// Apple Silicon: the GPU's memory is the system's.
fn is_metal(gpu: &GpuInfo) -> bool {
    gpu.api.as_deref() == Some("Metal")
}

#[cfg(target_os = "windows")]
fn detect_gpu() -> GpuInfo {
    let vulkan_available = Path::new("C:\\Windows\\System32\\vulkan-1.dll").exists();
    if !vulkan_available {
        return GpuInfo {
            available: false,
            name: None,
            api: None,
            vram_mb: None,
            integrated: false,
        };
    }

    let (gpu_name, vram_mb) = get_windows_gpu_info();
    vulkan_gpu_info(gpu_name, vram_mb)
}

#[cfg(target_os = "windows")]
fn get_windows_gpu_info() -> (Option<String>, Option<u64>) {
    // Two-step approach:
    //
    // 1. Get GPU name via PowerShell/WMI (Get-CimInstance Win32_VideoController).
    //    WMI's AdapterRAM is a 32-bit uint that caps at 4 GB — useless for modern
    //    GPUs. An RX 6700 XT (12 GB) reports 4 GB via WMI.
    //
    // 2. Get VRAM from the Windows registry. Every GPU driver writes a 64-bit
    //    qwMemorySize value at:
    //    HKLM\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\000N\HardwareInformation.qwMemorySize
    //    This is the reliable source — it's what dxdiag uses.

    // Step 1: GPU name via PowerShell
    let gpu_name = get_windows_gpu_name();

    // Step 2: VRAM from registry
    let vram_mb = get_windows_vram_from_registry();

    (gpu_name, vram_mb)
}

/// Run a PowerShell script without flashing a console window, which would
/// otherwise pop up briefly during GPU detection.
#[cfg(target_os = "windows")]
fn run_powershell(script: &str) -> Option<std::process::Output> {
    let mut cmd = std::process::Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", script]);
    crate::shell::platform::apply_no_window(&mut cmd);
    cmd.output().ok()
}

#[cfg(target_os = "windows")]
fn get_windows_gpu_name() -> Option<String> {
    let ps_script = "Get-CimInstance Win32_VideoController | \
        Select-Object Name | \
        ConvertTo-Json -Compress";

    let output = run_powershell(ps_script)?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let json: serde_json::Value = serde_json::from_str(stdout.trim()).ok()?;

    let controllers: Vec<&serde_json::Value> = if json.is_array() {
        json.as_array()
            .map(|a| a.iter().collect())
            .unwrap_or_default()
    } else {
        vec![&json]
    };

    for controller in &controllers {
        let name = controller
            .get("Name")
            .and_then(|n| n.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if !name.is_empty() && !name.to_lowercase().contains("basic display") {
            return Some(name);
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn get_windows_vram_from_registry() -> Option<u64> {
    // The GPU driver class GUID is always {4d36e968-e325-11ce-bfc1-08002be10318}.
    // Subkeys 0000, 0001, etc. correspond to each GPU. We scan them all and pick
    // the highest VRAM value (to prefer discrete over integrated when both exist).
    //
    // PowerShell reads the registry QWord value as a proper 64-bit integer.
    let ps_script = r#"
$classPath = 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}'
$maxVram = 0
Get-ChildItem $classPath -ErrorAction SilentlyContinue | ForEach-Object {
    $val = Get-ItemProperty -Path $_.PSPath -Name 'HardwareInformation.qwMemorySize' -ErrorAction SilentlyContinue
    if ($val) {
        $bytes = $val.'HardwareInformation.qwMemorySize'
        if ($bytes -gt $maxVram) { $maxVram = $bytes }
    }
}
Write-Output $maxVram
"#;

    let output = run_powershell(ps_script)?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let bytes: u64 = stdout.trim().parse().ok()?;
    if bytes > 0 {
        Some(bytes / 1_048_576)
    } else {
        None
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn detect_gpu() -> GpuInfo {
    GpuInfo {
        available: false,
        name: None,
        api: None,
        vram_mb: None,
        integrated: false,
    }
}

#[tauri::command]
pub async fn hardware_detect(app: tauri::AppHandle) -> HardwareInfo {
    let devices = probe_vulkan(&app).await;
    tokio::task::spawn_blocking(move || detect_hardware_with(devices.as_deref()))
        .await
        .unwrap_or_else(|_| detect_hardware())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hardware_detection_returns_valid_info() {
        let info = detect_hardware();
        assert!(info.total_ram_mb > 0);
        assert!(info.available_ram_mb > 0);
        assert!(info.available_ram_mb <= info.total_ram_mb);
        assert!(!info.recommended_quant.is_empty());
    }

    #[test]
    fn recommended_quant_based_on_ram() {
        let info = detect_hardware();
        let valid_quants = [
            "Qwen3.5-4B-IQ4_NL",
            "Qwen3.5-9B-IQ4_NL",
            "Qwen3.5-9B-UD-Q6_K_XL",
            "gemma-4-12b-it-UD-Q6_K_XL",
            "Qwen3.6-35B-A3B-UD-IQ4_NL",
            "Qwen3.6-35B-A3B-UD-Q5_K_XL",
        ];
        assert!(
            valid_quants.contains(&info.recommended_quant.as_str()),
            "Unexpected quant: {}",
            info.recommended_quant
        );
    }

    /// Cards report the device-local heap, not their nominal capacity, so
    /// every rung is checked with a figure a few hundred MB short of nominal —
    /// that undershoot is exactly what used to drop a card into the tier
    /// below and hand it a model sized for half its VRAM.
    #[test]
    fn quant_tiers_tolerate_under_nominal_vram_reports() {
        let cases = [
            (6144, "Qwen3.5-4B-IQ4_NL"),           // 6 GB
            (8188, "Qwen3.5-9B-IQ4_NL"),           // "8 GB", reported short
            (10240, "Qwen3.5-9B-IQ4_NL"),          // 10 GB
            (12038, "Qwen3.5-9B-UD-Q6_K_XL"),      // "12 GB", reported short
            (16303, "gemma-4-12b-it-UD-Q6_K_XL"),  // "16 GB", reported short
            (24110, "Qwen3.6-35B-A3B-UD-IQ4_NL"),  // "24 GB", reported short
            (32510, "Qwen3.6-35B-A3B-UD-Q5_K_XL"), // "32 GB", reported short
            (49152, "Qwen3.6-35B-A3B-UD-Q5_K_XL"), // 48 GB
        ];
        for (vram_mb, expected) in cases {
            assert_eq!(
                tier_lookup(QUANT_BY_VRAM_MB, vram_mb),
                expected,
                "{} MB should recommend {}",
                vram_mb,
                expected
            );
        }
    }

    #[test]
    fn offload_alternative_on_mid_range_discrete_cards_with_32gb() {
        let alt = offload_alternative(Some(12_000), false, 32_000, "Qwen3.5-9B-UD-Q6_K_XL")
            .expect("12 GB card + 32 GB RAM gets the MoE");
        assert_eq!(alt.model_id, OFFLOAD_CANDIDATE);
        assert!(alt.context_size >= crate::models::MIN_CONTEXT);
        assert!(offload_alternative(Some(8_100), false, 64_000, "Qwen3.5-9B-IQ4_NL").is_some());
    }

    const LIST_DEVICES_IGPU: &str = "0.00.058.364 D ggml_vulkan: Found 1 Vulkan devices:\n\
0.00.059.931 D ggml_vulkan: 0 = AMD Radeon(TM) Graphics (AMD proprietary driver) | uma: 1 | fp16: 1 | bf16: 0 | fp4: 0 | warp size: 32 | shared memory: 32768 | int dot: 1 | matrix cores: none\n\
Available devices:\n  Vulkan0: AMD Radeon(TM) Graphics (24445 MiB, 23223 MiB free)\n";

    #[test]
    fn reads_llama_servers_vulkan_devices() {
        assert_eq!(
            parse_vulkan_devices(LIST_DEVICES_IGPU),
            vec![VulkanDevice {
                name: "AMD Radeon(TM) Graphics".into(),
                uma: true,
                total_mb: Some(24445),
            }]
        );
        let two = "ggml_vulkan: 0 = NVIDIA GeForce RTX 4070 (NVIDIA) | uma: 0 | fp16: 1\n\
ggml_vulkan: 1 = Intel(R) UHD Graphics 770 (Intel Corporation) | uma: 1 | fp16: 1\n\
  Vulkan0: NVIDIA GeForce RTX 4070 (12282 MiB, 11000 MiB free)\n\
  Vulkan1: Intel(R) UHD Graphics 770 (16000 MiB, 15000 MiB free)\n";
        let d = parse_vulkan_devices(two);
        assert_eq!(d.len(), 2);
        assert_eq!((d[0].uma, d[0].total_mb), (false, Some(12282)));
        assert_eq!(
            (d[1].uma, d[1].name.as_str()),
            (true, "Intel(R) UHD Graphics 770")
        );
        assert!(parse_vulkan_devices("Available devices:\n").is_empty());
    }

    fn gpu(name: &str, vram_mb: u64, integrated: bool) -> GpuInfo {
        GpuInfo {
            available: true,
            name: Some(name.into()),
            api: Some("Vulkan".into()),
            vram_mb: Some(vram_mb),
            integrated,
        }
    }

    #[test]
    fn llama_cpps_devices_overrule_the_name() {
        // The machine this was found on: an iGPU the name check missed, with
        // a 16 GB BIOS carve-out in the registry.
        let missed = gpu("AMD Radeon(TM) Graphics", 16384, false);
        let fixed = with_vulkan_devices(missed, &parse_vulkan_devices(LIST_DEVICES_IGPU));
        assert!(fixed.integrated);
        assert_eq!(fixed.vram_mb, Some(24445));
        // A discrete card beside an iGPU is what llama.cpp runs on.
        let named_igpu = gpu("Intel(R) UHD Graphics 770", 12282, true);
        let devices = [
            VulkanDevice {
                name: "NVIDIA GeForce RTX 4070".into(),
                uma: false,
                total_mb: Some(12282),
            },
            VulkanDevice {
                name: "Intel(R) UHD Graphics 770".into(),
                uma: true,
                total_mb: Some(16000),
            },
        ];
        let fixed = with_vulkan_devices(named_igpu, &devices);
        assert!(!fixed.integrated);
        assert_eq!(fixed.vram_mb, Some(12282));
        // No devices: unchanged.
        let g = gpu("Some GPU", 8000, false);
        assert_eq!(with_vulkan_devices(g.clone(), &[]), g);
    }

    #[test]
    fn integrated_gpu_names() {
        for name in [
            "AMD Radeon(TM) Graphics",
            "AMD Radeon Graphics",
            "Rembrandt [Radeon 680M]",
            "AMD Radeon 780M Graphics",
            "AMD Radeon(TM) 890M",
            "AMD Radeon 8060S Graphics",
            "AMD Radeon(TM) Vega 8 Graphics",
            "Intel(R) UHD Graphics 770",
            "Intel(R) Iris(R) Xe Graphics",
            "Intel(R) Arc(TM) Graphics",
            "Intel(R) Arc(TM) 140V GPU (16GB)",
        ] {
            assert!(is_integrated_gpu(name), "{name} is integrated");
        }
        for name in [
            "Intel(R) Arc(TM) A770 Graphics",
            "Intel(R) Arc(TM) B580 Graphics",
            "Intel(R) Arc(TM) Pro A60",
            "AMD Radeon RX 7900 XTX",
            "AMD Radeon RX 6700 XT",
            "Radeon RX Vega 56",
            "NVIDIA GeForce RTX 4070",
        ] {
            assert!(!is_integrated_gpu(name), "{name} is discrete");
        }
    }

    #[test]
    fn slow_integrated_graphics_get_the_small_model_and_the_moe_beside_it() {
        // 24 GB that Vulkan lets the iGPU use, 32 GB of RAM.
        let rec = recommend(&gpu("AMD Radeon(TM) Graphics", 24445, true), 32_000, 20_000);
        assert_eq!(rec.quant, "Qwen3.5-4B-IQ4_NL");
        assert!(rec.integrated_slow);
        // Sized to its memory like a card, not floored: the 4B's KV cache is
        // small, so 20 GB free holds far more than the minimum.
        assert!(rec.context_size > crate::models::MIN_CONTEXT);
        let alt = rec.alternative.expect("the MoE fits in 24 GB");
        assert_eq!(alt.model_id, OFFLOAD_CANDIDATE);
        assert!(!alt.spill);
        // Too little RAM, or too little the GPU may use: no MoE.
        let small_ram = recommend(&gpu("AMD Radeon(TM) Graphics", 24445, true), 16_000, 8_000);
        assert!(small_ram.alternative.is_none());
        let small_heap = recommend(&gpu("AMD Radeon(TM) Graphics", 4096, true), 32_000, 20_000);
        assert!(small_heap.alternative.is_none());
    }

    #[test]
    fn slow_integrated_graphics_size_context_to_the_ram_free_now() {
        // ~8 GB the iGPU may use (a laptop with 16 GB of RAM): enough for the
        // 4B with well over the minimum context.
        let laptop = recommend(&gpu("AMD Radeon(TM) Graphics", 8192, true), 15_000, 9_000);
        assert_eq!(laptop.quant, "Qwen3.5-4B-IQ4_NL");
        assert!(laptop.context_size > crate::models::MIN_CONTEXT);
        // A big heap but little RAM free: sized to what is free.
        let busy = recommend(&gpu("AMD Radeon(TM) Graphics", 24445, true), 32_000, 6_000);
        let idle = recommend(&gpu("AMD Radeon(TM) Graphics", 24445, true), 32_000, 20_000);
        assert!(busy.context_size < idle.context_size);
    }

    #[test]
    fn a_fast_apu_is_recommended_for_like_a_card() {
        let rec = recommend(
            &gpu("AMD Radeon 8060S Graphics", 98_304, true),
            131_072,
            100_000,
        );
        assert!(!rec.integrated_slow);
        assert_eq!(rec.quant, "Qwen3.6-35B-A3B-UD-Q5_K_XL");
        // Its memory is RAM already: nothing to spill to.
        assert!(rec.alternative.is_none());
    }

    #[test]
    fn a_discrete_card_is_recommended_by_its_vram() {
        let rec = recommend(
            &gpu("NVIDIA GeForce RTX 4070", 12_038, false),
            32_000,
            20_000,
        );
        assert!(!rec.integrated_slow);
        assert_eq!(rec.quant, "Qwen3.5-9B-UD-Q6_K_XL");
        assert!(rec.alternative.as_ref().is_some_and(|a| a.spill));
    }

    fn mac(total_ram_mb: u64) -> GpuInfo {
        GpuInfo {
            available: true,
            name: Some("Apple GPU".into()),
            api: Some("Metal".into()),
            vram_mb: Some(metal_working_set_mb(total_ram_mb)),
            integrated: false,
        }
    }

    #[test]
    fn metal_gets_two_thirds_of_ram_then_three_quarters() {
        assert_eq!(metal_working_set_mb(24_576), 16_384);
        assert_eq!(metal_working_set_mb(65_536), 49_152);
    }

    #[test]
    fn a_mac_gets_a_context_sized_to_its_memory_not_the_floor() {
        // 24 GB Mac with 11 GB free: the free RAM caps Metal's 16 GB.
        let rec = recommend(&mac(24_576), 24_576, 11_000);
        assert_eq!(rec.memory_mb, Some(11_000));
        assert_eq!(rec.quant, "Qwen3.5-9B-IQ4_NL");
        assert!(rec.context_size > crate::models::MIN_CONTEXT);
        // Unified memory has no "system RAM" to spill experts to.
        assert!(recommend(&mac(32_768), 32_768, 30_000)
            .alternative
            .is_none());
    }

    #[test]
    fn no_offload_alternative_where_it_would_not_help() {
        // Integrated graphics, unknown VRAM, too little VRAM or RAM.
        assert!(offload_alternative(Some(12_000), true, 64_000, "Qwen3.5-4B-IQ4_NL").is_none());
        assert!(offload_alternative(None, false, 64_000, "Qwen3.5-9B-IQ4_NL").is_none());
        assert!(offload_alternative(Some(6_000), false, 64_000, "Qwen3.5-4B-IQ4_NL").is_none());
        assert!(offload_alternative(Some(12_000), false, 16_000, "Qwen3.5-9B-IQ4_NL").is_none());
        // 24 GB cards are already recommended the MoE outright.
        assert!(offload_alternative(Some(24_000), false, 64_000, OFFLOAD_CANDIDATE).is_none());
    }

    /// Every id the tier table can return has to resolve in the registry, or
    /// first-run setup offers a download that goes nowhere and the context
    /// recommendation silently falls back to the floor.
    #[test]
    fn quant_tier_ids_resolve_in_registry() {
        for (_, id) in QUANT_BY_VRAM_MB {
            assert!(
                crate::models::context_ceiling_for(
                    id,
                    24 * 1024 * 1024 * 1024,
                    crate::models::FitOptions::with_mtp(true),
                )
                .is_some(),
                "tier table references a model id the registry can't size: {}",
                id
            );
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn parse_nvidia_smi_reads_name_and_vram() {
        // memory.total is MiB under `nounits`.
        assert_eq!(
            parse_nvidia_smi("NVIDIA GeForce RTX 5080, 16303\n"),
            Some(("NVIDIA GeForce RTX 5080".to_string(), 16303))
        );
        // Extra GPUs on later lines are ignored (first card wins).
        assert_eq!(
            parse_nvidia_smi("NVIDIA GeForce RTX 5080, 16303\nNVIDIA T1000, 4096\n"),
            Some(("NVIDIA GeForce RTX 5080".to_string(), 16303))
        );
        // Empty / malformed output yields None so callers fall back to sysfs.
        assert_eq!(parse_nvidia_smi(""), None);
        assert_eq!(parse_nvidia_smi("no devices were found"), None);
        assert_eq!(parse_nvidia_smi("Some GPU, 0"), None);
    }
}
