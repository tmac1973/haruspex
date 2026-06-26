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
    pub gpu_vram_mb: Option<u64>,
    pub gpu_integrated: bool,
    pub total_ram_mb: u64,
    pub available_ram_mb: u64,
    pub recommended_quant: String,
    pub recommended_context_size: u32,
}

struct GpuInfo {
    available: bool,
    name: Option<String>,
    api: Option<String>,
    vram_mb: Option<u64>,
    integrated: bool,
}

/// Recommended quant by effective VRAM (MB) for a discrete GPU with known
/// memory. Ascending thresholds; the first entry whose threshold the VRAM
/// is *below* wins. The final `u64::MAX` row is the catch-all.
const QUANT_BY_VRAM_MB: &[(u64, &str)] = &[
    (8192, "Qwen3.5-4B-IQ4_NL"),             // < 8 GB
    (16384, "Qwen3.5-9B-IQ4_NL"),            // 8–16 GB (default tier)
    (24576, "Qwen3.5-9B-UD-Q8_K_XL"),        // 16–24 GB
    (u64::MAX, "Qwen3.6-35B-A3B-UD-IQ4_NL"), // 24 GB+ → sparse MoE (dense 27B is opt-in only)
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

pub fn detect_hardware() -> HardwareInfo {
    use sysinfo::System;

    let mut sys = System::new_all();
    sys.refresh_memory();

    let total_ram_mb = sys.total_memory() / 1_048_576;
    let available_ram_mb = sys.available_memory() / 1_048_576;

    // GPU detection
    let gpu = detect_gpu();

    // Recommendation logic:
    // - Integrated GPU → always 4B (slow inference, shared memory)
    // - Unknown GPU name AND no VRAM detected → conservative 4B (safer default)
    // - Known discrete GPU with VRAM → scale by VRAM
    // - Known discrete GPU with unknown VRAM → scale by system RAM as proxy
    let recommended_quant = if gpu.integrated {
        // Integrated graphics share system memory and run inference slowly —
        // always the lightweight 4B regardless of reported VRAM.
        "Qwen3.5-4B-IQ4_NL"
    } else if gpu.name.is_none() && gpu.vram_mb.is_none() {
        // Detection failed entirely — default to the smaller model to avoid
        // recommending a large model on a system that can't actually run it.
        "Qwen3.5-4B-IQ4_NL"
    } else {
        tier_lookup(QUANT_BY_VRAM_MB, gpu.vram_mb.unwrap_or(available_ram_mb))
    };

    // Context size: computed per-model from the recommended quant's weights,
    // vision projector, and per-token KV growth against detected VRAM (see
    // `models::recommended_context_for`). Integrated GPUs and hardware where
    // VRAM is unknown can't be modelled reliably, so they get the floor.
    let recommended_context_size = match gpu.vram_mb {
        Some(vram_mb) if !gpu.integrated => {
            crate::models::recommended_context_for(recommended_quant, vram_mb * 1024 * 1024)
        }
        _ => crate::models::MIN_CONTEXT,
    };

    HardwareInfo {
        gpu_available: gpu.available,
        gpu_name: gpu.name,
        gpu_api: gpu.api,
        gpu_vram_mb: gpu.vram_mb,
        gpu_integrated: gpu.integrated,
        total_ram_mb,
        available_ram_mb,
        recommended_quant: recommended_quant.to_string(),
        recommended_context_size,
    }
}

/// Check if a GPU name looks like an integrated graphics adapter.
/// Only the Linux and Windows `detect_gpu` paths inspect the GPU name;
/// macOS reports Apple Silicon directly, so gate this out there to avoid a
/// dead-code warning.
#[cfg(any(target_os = "linux", target_os = "windows"))]
fn is_integrated_gpu(name: &str) -> bool {
    let lower = name.to_lowercase();
    // Intel integrated (HD, UHD, Iris, Arc iGPU)
    if lower.contains("intel") {
        return !lower.contains("arc a") && !lower.contains("arc b");
    }
    // AMD APU integrated (Vega, Radeon Graphics without a discrete model number)
    if (lower.contains("amd") || lower.contains("radeon"))
        && (lower.contains("vega") || lower.contains("radeon graphics"))
    {
        return true;
    }
    false
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

    let gpu_name = get_linux_gpu_name();
    let vram_mb = get_linux_vram_mb();
    let integrated = gpu_name.as_deref().map(is_integrated_gpu).unwrap_or(false);

    GpuInfo {
        available: true,
        name: gpu_name,
        api: Some("Vulkan".to_string()),
        vram_mb,
        integrated,
    }
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
        vram_mb: None,
        integrated: false, // Apple Silicon is fast enough, don't penalize
    }
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
    let integrated = gpu_name.as_deref().map(is_integrated_gpu).unwrap_or(false);

    GpuInfo {
        available: true,
        name: gpu_name,
        api: Some("Vulkan".to_string()),
        vram_mb,
        integrated,
    }
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

/// Run a PowerShell script without flashing a console window.
/// CREATE_NO_WINDOW (0x08000000) suppresses the brief powershell.exe popup
/// that would otherwise appear during GPU detection.
#[cfg(target_os = "windows")]
fn run_powershell(script: &str) -> Option<std::process::Output> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()
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
pub fn cmd_detect_hardware() -> HardwareInfo {
    detect_hardware()
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
            "Qwen3.5-9B-UD-Q8_K_XL",
            "Qwen3.6-35B-A3B-UD-IQ4_NL",
        ];
        assert!(
            valid_quants.contains(&info.recommended_quant.as_str()),
            "Unexpected quant: {}",
            info.recommended_quant
        );
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
