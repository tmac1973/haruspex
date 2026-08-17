# Phase 01 — Lineup Refresh and the End of Substring Matching

Fills the 9 GB hole in the 9B tier, swaps the dense 27B to Qwen 3.8, and
replaces the three independent substring matchers with two declared tables —
one per side of the IPC boundary, each owning the facts its side needs.

Ships as one PR. Phase 03 depends on the registry changes here; phase 02 does
not.

## Steps

### 1. Add `Qwen3.5-9B-UD-Q6_K_XL` to the lineup

New entry in `model_registry()` (`models.rs:114`), between the existing
IQ4_NL and UD-Q8_K_XL entries so the vec stays in ascending VRAM order:

```rust
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
}
```

It shares the existing 9B projector, so no new mmproj constants.

Sanity check against `context_ceiling_for`: on a 12 GiB card the fixed cost is
8.76 (weights) + 0.92 (mmproj) + 1.0 (VRAM reserve) + 0.5 (compute overhead)
≈ 11.2 GB, leaving ~1.6 GB of KV at 17,408 bytes/token ≈ 92k tokens → the
65536 rung. Comfortable.

### 2. Swap the dense 27B to Qwen 3.8

New projector constants alongside the existing ones (`models.rs:77-81`).
**Do not reuse the 3.6 constants** — the file differs (927_607_488 vs
927_607_360 bytes) and the sha check would fail on download:

```rust
const QWEN_38_27B_MMPROJ_URL: &str =
    "https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/resolve/main/mmproj-F16.gguf";
const QWEN_38_27B_MMPROJ_SIZE: u64 = 927_607_488;
const QWEN_38_27B_MMPROJ_SHA256: &str =
    "cbb841a9ee0636b2ec172f5bb8df2ea8dfeb01e90fe7c6126581d662a0b4e43e";
```

plus an arm in `mmproj_sha256_for_url` (`models.rs:85`) and a
`qwen_38_27b_mmproj_filename()` returning `"Qwen3.8-27B-mmproj-F16.gguf"`.
The 3.6 constants and filename helper **stay** — the legacy entry still
references them.

The registry entry replaces the 3.6 one at `models.rs:182`:

```rust
// 24 GB VRAM — dense alternative for those who want it
ModelInfo {
    id: "Qwen3.8-27B-IQ4_NL".to_string(),
    filename: "Qwen3.8-27B-IQ4_NL.gguf".to_string(),
    url: "https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/resolve/main/Qwen3.8-27B-IQ4_NL.gguf"
        .to_string(),
    sha256: "466c6714b0eca21c032690c801391a3c1e8f464ef01bbf420b70840027590c38".to_string(),
    size_bytes: 16_337_628_128,
    description: "Qwen 3.8 27B — dense model for 24 GB VRAM, advanced (~16 GB)".to_string(),
    downloaded: false,
    legacy: false,
    mmproj_filename: Some(qwen_38_27b_mmproj_filename()),
    mmproj_url: Some(QWEN_38_27B_MMPROJ_URL.to_string()),
    mmproj_size_bytes: Some(QWEN_38_27B_MMPROJ_SIZE),
}
```

The old entry moves verbatim to `legacy_registry()` (`models.rs:202`) with
`legacy: true` and its description reworded to the legacy convention
(`"Qwen 3.6 27B — legacy (~16 GB)"`). Its URL and hash stay valid, so an
existing 16 GB download keeps working, stays switchable, and can be
re-downloaded after deletion — the contract documented at `models.rs:198-201`.

### 3. Make per-token KV cost a declared field, not a substring match

`kv_bytes_per_token` (`models.rs:343`) is the first of the three matchers, and
the most damaging when it misses: an unmatched id makes `context_ceiling_for`
return `None`, which the Settings context cap treats as "can't predict" and
fails open, while `recommended_context_for` floors to 8192.

Add the value to `ModelInfo` as a declared field:

```rust
/// Per-token KV-cache growth (bytes, q8_0) for this model's full-attention
/// layers — see the derivation note above `CONTEXT_LADDER`. Declared per
/// entry rather than matched from the id, because a new model version that
/// matches no arm silently disables the whole context-fit prediction.
#[serde(skip)]
#[ts(skip)]
pub kv_bytes_per_token: u64,
```

`#[serde(skip)]` + `#[ts(skip)]` keep the field Rust-internal: the wire shape
and the generated TS type are unchanged, so **no IPC binding regeneration is
needed** and `scripts/check-ipc.mjs` stays green.

Values: `17_408` for every 4B and 9B entry (8 full-attention layers × 2 ×
4 KV heads × 256 head_dim × 34/32), `34_816` for both dense 27B entries
(16 layers), `10_880` for the 35B-A3B (10 layers × 2 KV heads). Verified for
Qwen 3.8 27B against its `config.json`: 64 layers with
`full_attention_interval: 4` gives 16 full-attention layers,
`num_key_value_heads: 4`, `head_dim: 256` — identical to the 3.6 dense 27B.

`kv_bytes_per_token(id)` then becomes a registry lookup, and
`context_ceiling_for` (`models.rs:366`) reads `model.kv_bytes_per_token`
directly since it has already resolved the entry. Keep the derivation comment
block above `CONTEXT_LADDER` — it explains *why* the numbers are what they
are and must stay next to them.

### 4. Add the 12 GB VRAM tier

`QUANT_BY_VRAM_MB` (`hardware.rs:33`) gains a row:

```rust
const QUANT_BY_VRAM_MB: &[(u64, &str)] = &[
    (7168,  "Qwen3.5-4B-IQ4_NL"),
    (11264, "Qwen3.5-9B-IQ4_NL"),
    (15360, "Qwen3.5-9B-UD-Q6_K_XL"),
    (23552, "Qwen3.5-9B-UD-Q8_K_XL"),
    (u64::MAX, "Qwen3.6-35B-A3B-UD-IQ4_NL"),
];
```

Note the thresholds are **not** the nominal capacities. The lookup is
`vram_mb < threshold` (`hardware.rs:44`), and cards do not report their
nominal size: a "12 GB" card reports the device-local heap, typically some
tens of MB short of 12288. With a 12288 threshold such a card falls into the
*lower* row and gets the 5.4 GB quant — precisely the bug being fixed. Setting
each threshold ~1 GB below nominal gives the reported figure room to be short.

This same off-by-a-little already applies to the existing 8192 / 16384 / 24576
rows, where an 8 GB card reporting 8050 MB gets the 4B model; the rewrite above
fixes that at the same time. Worth confirming on real hardware what your card
actually reports before settling the numbers — `detect_hardware()` logs it.

Update the tier test at `hardware.rs:430` and add cases at the new
boundaries, including a "reports slightly under nominal" case for each rung,
since that is the failure mode.

### 5. Replace the frontend's id sniffing with one traits table

`modelFamilyFromId` (`descriptor.ts:95`) is documented as the only model-name
sniffing in the codebase. Keep that property, but make what it returns
declarative and extensible — phase 02 adds an `effort` field to the same
table rather than introducing a second matcher.

```ts
interface ModelTraits {
	family: QwenSamplingFamily;
	// phase 02 adds: effort: EffortCaps | null;
}

/** Ids arrive in many shapes — `Qwen3.8-27B`, `qwen-3.8-27b`,
 *  `unsloth-Qwen3.8-27B.IQ4_NL`, a full GGUF filename. Normalizing away
 *  case and separators means one pattern per model instead of one per
 *  spelling. */
function normalizeId(id: string): string {
	return id.toLowerCase().replace(/[.\-_ ]/g, '');
}

/** Ordered — the dense-27B patterns must precede the generic family ones. */
const MODEL_TRAITS: readonly [string, ModelTraits][] = [
	['qwen3827b', { family: 'qwen-dense-27b' }],
	['qwen3627b', { family: 'qwen-dense-27b' }],
	['qwen38',    { family: 'qwen3.5' }],
	['qwen36',    { family: 'qwen3.5' }],
	['qwen35',    { family: 'qwen3.5' }]
];
```

`modelFamilyFromId` keeps its signature and becomes a lookup over that table;
add a sibling `modelTraitsFromId` for phase 02 to consume. Both stay private
to `descriptor.ts`.

Rename the sampling family `qwen3.6-27b` → `qwen-dense-27b`
(`settings.ts:899`, the `QwenSamplingFamily` union, and the comment at
`settings.ts:879-881`). The published Qwen 3.8 27B profile is identical to
Qwen 3.6's — thinking `presence_penalty=0.0`, everything else shared — so this
is a rename covering both, not a new profile. The user-visible string in
`describeSamplingProfile` (`modelAdvanced.ts`) changes with it; that text is
interpolated into the job editor, so read it once after renaming to check it
still scans.

### 6. Tests

- `models.rs:1096-1097` — assert the lineup contains `Qwen3.8-27B-IQ4_NL` and
  `Qwen3.5-9B-UD-Q6_K_XL`, and that `Qwen3.6-27B-IQ4_NL` is present in
  `full_registry()` but flagged `legacy`.
- A registry invariant test: **every** entry in `full_registry()` has a
  non-zero `kv_bytes_per_token`. This is the guard that makes step 3 worth
  doing — it fails at build time the next time someone adds a model without
  declaring one.
- `context_ceiling_for("Qwen3.8-27B-IQ4_NL", 24 GiB)` returns a real rung
  rather than `None` — the regression that step 3 exists to prevent.
- `settings.test.ts:196` — rename to "Qwen dense 27B…" and assert both
  `Qwen3.6-27B-IQ4_NL.gguf` and `Qwen3.8-27B-IQ4_NL.gguf` resolve to
  `presence_penalty: 0.0` for thinking/general.
- `descriptor.test.ts:52` — add a 3.8 case asserting `qwenTuning: true` and
  `samplingFamily: 'qwen-dense-27b'`. Add a **remote** 3.8 case too: that is
  the path that produced `reasoningMode: none` in #195, and a local-only test
  would not have caught it.
- `setup.svelte.ts:38,344` hard-code `Qwen3.5-9B-IQ4_NL` as the first-run
  default. Leave it — it remains the 8–12 GB pick and the correct
  conservative default when detection fails.

## Verification

- `cargo test`, `npm run test`, `npm run check`, `cargo clippy` (CI treats
  clippy warnings as errors — see `feedback_ci_equivalent_checks`).
- Download the new 9B Q6 and the 3.8 27B in a real build: the sha256 checks
  are the only thing standing between a typo'd constant and a corrupt model
  that fails at load time with a confusing error.
- Confirm the vision projector downloads and vision still works on the 3.8
  27B — this is the step where reusing the 3.6 mmproj constant would show up.
- With the 3.6 27B still on disk, confirm it appears as legacy, is
  switchable, and starts.
- Check the recommended quant on the dev machine matches its VRAM tier, and
  note the reported `gpu_vram_mb` for the threshold question in step 4.
