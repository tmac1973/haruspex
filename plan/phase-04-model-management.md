# Phase 4: Model Management & First-Run Wizard

## Goal

Implement model downloading, verification, and storage, plus the first-run setup wizard that guides new users from install to first conversation. After this phase, a fresh install of Haruspex is usable end-to-end without any manual file management.

## Prerequisites

- Phase 3 complete (chat UI works with a manually-placed model)

## Deliverables

- **User-testable**: Install the app fresh (or delete the model directory) → first-run wizard walks through hardware detection, model download with progress, test message, then drops into the main chat. Also: "Use existing file" picker works.

NOTE: Model storage paths use `haruspex` as the app data directory name (resolved by Tauri from the app identifier).

---

## Tasks

### 4.1 Model management Rust module (`src-tauri/src/models.rs`)

**Structs:**

```rust
pub struct ModelInfo {
    pub id: String,               // e.g., "granite-4.0-micro-Q4_K_M"
    pub filename: String,         // e.g., "granite-4.0-micro-Q4_K_M.gguf"
    pub url: String,              // HuggingFace download URL
    pub sha256: String,           // expected hash for verification
    pub size_bytes: u64,          // for progress calculation
    pub description: String,     // human-readable label
}

pub struct ModelManager {
    models_dir: PathBuf,         // appDataDir/models/
    available_models: Vec<ModelInfo>,
}
```

**Registry:** Hard-code the model registry with the quantizations from the architecture doc:

| ID | Filename | Size |
|---|---|---|
| `granite-4.0-micro-IQ4_XS` | `granite-4.0-micro-IQ4_XS.gguf` | 1.89 GB |
| `granite-4.0-micro-Q4_K_M` | `granite-4.0-micro-Q4_K_M.gguf` | 2.1 GB |
| `granite-4.0-micro-Q5_K_M` | `granite-4.0-micro-Q5_K_M.gguf` | 2.44 GB |
| `granite-4.0-micro-Q8_0` | `granite-4.0-micro-Q8_0.gguf` | 3.62 GB |

**Methods:**

- `get_models_dir() -> PathBuf` — resolve via Tauri's `app_data_dir()`, create if absent
- `list_downloaded() -> Vec<ModelInfo>` — scan models dir for `.gguf` files, match against registry
- `is_model_present(id: &str) -> bool`
- `get_active_model() -> Option<PathBuf>` — read from persisted settings, fallback to first available
- `delete_model(id: &str) -> Result<()>`

### 4.2 Model download with progress (`src-tauri/src/models.rs`)

Use Tauri's `tauri-plugin-upload` or a streaming HTTP client (`reqwest`) to download:

- Stream the download to a `.partial` temp file in the models directory.
- Emit `download-progress` Tauri events with `{ downloaded: u64, total: u64, speed_bps: u64 }`.
- On completion, compute SHA256 hash of the file and compare to expected.
- If hash matches, rename `.partial` to final filename.
- If hash mismatch, delete the partial file, return error.
- Support cancellation via an `AbortHandle`.
- Support resume: if a `.partial` file exists, send `Range` header to resume.

**Tauri commands:**

```rust
#[tauri::command]
async fn download_model(app: AppHandle, model_id: String) -> Result<(), String>;

#[tauri::command]
async fn cancel_download(state: State<'_, ModelManager>) -> Result<(), String>;

#[tauri::command]
fn list_models(state: State<'_, ModelManager>) -> Vec<ModelInfo>;

#[tauri::command]
fn get_models_dir(state: State<'_, ModelManager>) -> String;

#[tauri::command]
async fn import_model(state: State<'_, ModelManager>, path: String) -> Result<ModelInfo, String>;
```

### 4.3 Hardware detection

Add a Tauri command to detect GPU capability:

```rust
#[tauri::command]
fn detect_hardware() -> HardwareInfo;

pub struct HardwareInfo {
    pub gpu_available: bool,
    pub gpu_name: Option<String>,
    pub gpu_api: Option<String>,    // "Vulkan", "Metal", or None
    pub total_ram_mb: u64,
    pub available_ram_mb: u64,
    pub recommended_quant: String,  // suggest based on available memory
}
```

Detection strategy:
- **Linux/Windows**: Check for Vulkan by looking for `libvulkan.so` / `vulkan-1.dll`, optionally run `vulkaninfo` if available.
- **macOS**: Metal is always available on supported hardware; check via system profiler.
- **RAM**: Use `sysinfo` crate to get total/available memory. Recommend `IQ4_XS` for <4GB available, `Q4_K_M` for 4-6GB, `Q5_K_M` or `Q8_0` for >6GB.

### 4.4 First-run detection

On app startup (`main.rs` or layout load):

1. Check if any model exists in the models directory.
2. If no model found → redirect to `/setup` route.
3. If model found → proceed to main chat, auto-start server.

### 4.5 Setup wizard frontend (`src/routes/setup/+page.svelte`)

Multi-step wizard with the following states:

**Step 1 — Welcome**
- "Haruspex runs entirely on your computer. Nothing you ask leaves your device."
- Privacy-focused messaging.
- "Get Started" button.

**Step 2 — Hardware Check**
- Call `detect_hardware` command.
- Display: GPU name and API (or "No GPU detected — running on CPU").
- Display: Available RAM and recommended model.
- Allow user to select a different quantization from a dropdown.
- "Use existing GGUF file" link → opens file picker dialog (`tauri::dialog::FileDialogBuilder`).

**Step 3 — Download**
- Progress bar with: percentage, downloaded/total MB, estimated time remaining, download speed.
- Cancel button.
- On error: show error message with "Retry" button.
- On hash mismatch: "Download corrupted, please retry."

**Step 4 — Test Query**
- Auto-start llama-server with the downloaded model.
- Wait for health check.
- Send test message: "Hello! Can you introduce yourself in one sentence?"
- Show the streamed response.
- If test fails: "Something went wrong" with troubleshooting tips and "Retry" / "Skip" buttons.

**Step 5 — Done**
- "You're ready to use Haruspex!"
- Brief feature overview (2-3 bullet points).
- "Start chatting" button → navigate to main chat.

### 4.6 Wizard state management

Create a `setupStore` to track wizard progress:

```typescript
interface SetupState {
  step: 'welcome' | 'hardware' | 'download' | 'test' | 'done';
  hardware: HardwareInfo | null;
  selectedModel: string;
  downloadProgress: { downloaded: number; total: number; speedBps: number } | null;
  testResult: 'pending' | 'success' | 'error';
}
```

### 4.7 "Import existing model" flow

- File picker filtered to `.gguf` extension.
- Copy (or symlink) the file to the models directory.
- Validate it's a valid GGUF by checking the magic bytes (`0x46475547`).
- Skip download step, proceed to test query.

---

## Test Coverage

| Area | What to test | Tool |
|---|---|---|
| Model registry | All entries have valid URLs, sizes, SHA256 hashes | cargo test |
| Download | Progress events emitted at correct intervals | cargo test (mock HTTP) |
| Download | SHA256 verification passes for correct data, fails for corrupted | cargo test |
| Download | Cancellation stops the download and cleans up partial file | cargo test |
| Download resume | Sends correct Range header when partial file exists | cargo test |
| Hardware detection | Returns valid struct on current platform | cargo test |
| Model directory | Created if absent, correct platform path | cargo test |
| Import model | GGUF magic byte validation accepts valid, rejects invalid | cargo test |
| First-run detection | Redirects to setup when no model present | Vitest |
| Wizard steps | Each step renders correctly and transitions | Vitest + testing-library |
| Wizard | Download progress bar reflects events | Vitest + testing-library |
| Wizard | "Use existing file" flow skips download | Vitest + testing-library |

---

## Definition of Done

- [ ] Fresh launch (no model dir) → wizard starts automatically
- [ ] Hardware detection shows GPU/CPU status and recommends a model
- [ ] Model downloads with visible progress, correct speed, and ETA
- [ ] Download can be cancelled cleanly
- [ ] SHA256 verification catches a corrupted download (test with truncated file)
- [ ] "Use existing file" imports a GGUF and skips download
- [ ] Test query succeeds and shows a streamed response in the wizard
- [ ] After wizard completion, user lands in main chat with model loaded
- [ ] Subsequent launches skip the wizard and go straight to chat
- [ ] All unit tests pass
