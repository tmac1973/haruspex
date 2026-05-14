# Phase 12 — Polish + ESLint guardrails

**Severity addressed:** 1–3 · **Effort:** ~3 hours · **Risk:** Low

Resolves duplication-audit R-8 (`.map_err(|e| e.to_string())` ubiquity), T-10 (settings `getSettings()` repetition), T-12 (`displayLabel` boilerplate); complexity-audit C-13 (setup wizard step components) and "Unable to verify" follow-ups (ESLint complexity rules); design-pattern P-7 (AppLogger naming nit), P-8 (db.ts silent error swallow).

## Goal

Sweep up the polish items left after the heavy phases. Each is small, contained, and independent. Reorder freely if you skip any.

## Sub-phases (cherry-pick freely)

### 12a — ESLint complexity guardrails

```js
// eslint.config.js (add to the rules block of the existing TS config)
rules: {
    // existing rules…
    'complexity':              ['warn', 15],
    'max-depth':               ['warn', 4],
    'max-lines-per-function':  ['warn', { max: 80, skipBlankLines: true, skipComments: true }],
    'max-lines':               ['warn', { max: 400, skipBlankLines: true, skipComments: true }],
}
```

Run `npm run lint` and audit the warnings. Adjust thresholds upward if the noise floor is too high — the goal is to **prevent regression**, not to flag every existing site. Acceptable starting state: ≤ 20 warnings after Phases 01–11 complete.

### 12b — `db.ts` error surfacing (Pattern P-8)

```ts
// src/lib/stores/db.ts — wherever the silent-swallow catches live
import { logDebug } from '$lib/debug-log';

export async function dbSaveMessage(conversationId: string, msg: ChatMessage): Promise<void> {
	try {
		await invoke('db_save_message', { conversationId, message: serializeMessage(msg) });
	} catch (e) {
		logDebug('db', 'dbSaveMessage failed', { conversationId, error: String(e) });
	}
}
```

Apply the same pattern (a single `logDebug('db', '<fn> failed', { error: String(e) })`) to every `try { invoke('db_*', …) } catch { }` site in `db.ts`. Keep the catches non-throwing — the UI behaviour shouldn't change.

### 12c — `getSettings()` destructure in route pages (Dup T-10)

```ts
// src/routes/settings/+page.svelte — replace the 11-line getSettings() block
const s = getSettings();
let responseFormat = $state<ResponseFormat>(s.responseFormat);
let theme = $state<ThemeMode>(s.theme);
let ttsVoice = $state(s.ttsVoice);
let searchProvider = $state<SearchProvider>(s.searchProvider);
let searchRecency = $state(s.searchRecency);
let braveApiKey = $state(s.braveApiKey);
let searxngUrl = $state(s.searxngUrl);
let contextSize = $state(s.contextSize);
let proxyMode = $state<ProxyMode>(s.proxy.mode);
let proxyUrl = $state(s.proxy.url);
let proxyBypass = $state(s.proxy.bypass);
```

**Note:** if Phase 09 already split this page, the destructure should happen inside each section component instead. Skip this sub-phase in that case.

### 12d — `labelArg` adoption (Dup T-12)

Phase 04 introduced `labelArg` in `_helpers.ts`. Sweep every remaining `displayLabel: (args) => (args.X as string) || ''` site:

```bash
grep -rnE "displayLabel: \(args\) => \(args\.\w+ as string\) \|\| ''" src/lib/agent/tools
```

Replace each with `displayLabel: labelArg('path')` (or whichever key applies). Should be ≤ 15 minutes total.

### 12e — AppLogger naming (Pattern P-7)

`src-tauri/src/app_log.rs` is fine behaviorally; the nit is the inline comment header. Update the module-level doc comment to describe the type as a tee/multi-sink rather than a decorator:

```rust
//! In-memory app log capture.
//!
//! Implements `log::Log` as a *tee sink*: every record is written both to
//! stderr (for terminal users) and to an in-memory ring buffer that the
//! UI exposes via the App Log tab. The two destinations are independent
//! — see `is_sidecar_passthrough` for the filter that keeps sidecar
//! stdout/stderr out of the in-memory buffer.
```

Trivial; do it in passing.

### 12f — Setup wizard split (Complexity C-13)

`src/routes/setup/+page.svelte` (765 LOC) is a linear five-step wizard (welcome → hardware → download → test → chat). Each step is already well-delineated by `if (currentStep === 'foo')` blocks.

Extract one component per step:

- `src/lib/components/setup/WelcomeStep.svelte`
- `src/lib/components/setup/HardwareStep.svelte`
- `src/lib/components/setup/DownloadStep.svelte`
- `src/lib/components/setup/RemoteStep.svelte`
- `src/lib/components/setup/TestStep.svelte`

`setup/+page.svelte` becomes ~80 LOC of navigation logic + step dispatch.

This is the largest sub-phase; consider promoting it to its own phase if you don't have spare time at the end of Phase 11.

### 12g — `chat.svelte.ts` split (Complexity C-14)

**Verify fan-in first:**

```bash
grep -rnE "from '\\\$lib/stores/chat'" src | wc -l
```

If fan-in ≥ 5, split:

```
src/lib/stores/chat/
├── index.ts          # re-exports for backwards compatibility
├── state.svelte.ts   # reactive state + getters
├── actions.ts        # sendMessage, cancelGeneration, deleteConversation…
└── persistence.ts    # restoreSandboxSession, compactIfNeeded, dbSave* glue
```

If fan-in is low, skip — the file is fine.

### 12h — Image thumbnail attachment helper (Dup R-19/T-19 equivalents)

Both `fs_read.ts:280-292` and `fs_write.ts:492-502` check `IMAGE_EXT_RE.test(path)` and then call `invoke('fs_read_image', …)`. Extract:

```ts
// src/lib/agent/tools/_helpers.ts (add)
export async function attachThumbnailIfImage(
	workdir: string,
	relPath: string
): Promise<string> {
	if (!IMAGE_EXT_RE.test(relPath)) return '';
	try {
		const dataUrl = await invoke<string>('fs_read_image', { workdir, relPath });
		return `\n\n![${relPath}](${dataUrl})`;
	} catch {
		return '';
	}
}
```

Use at both call sites.

## Build gate

```bash
npm run check
npm run lint    # Should pass; the new ESLint rules from 12a should warn (not error)
npm run test
cargo check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

## Test plan

This phase is pure cleanup. The test surface is:

### Smoke

1. App launches; sidecar status `ready`.
2. **Send a message, get a reply.** That alone exercises the chat store (12b/12g), the tool helpers (12d/12h), and the settings page (12c).

### Targeted

3. **Run `npm run lint`** — should report between 0 and 20 warnings; no errors.
4. **Settings round-trip** — repeat the test plan from Phase 09 step 2 (change one setting, reload, verify). Confirms 12c didn't regress.
5. **Setup wizard** — if you ran 12f: factory-reset the app's settings (delete `~/.config/haruspex` or equivalent), launch. Walk through Welcome → Hardware → Download → Test → Chat. Each step renders correctly.
6. **Image thumbnail** — if you ran 12h: in chat with a workdir set, run *"Read pic.png and describe it"* and then *"Write pic2.png copied from pic.png"*. Both should attach a thumbnail in the tool result.

Per-sub-phase commits (or one squashed commit) using:

```
refactor: polish pass — eslint rules, error surfacing, helpers (#TBD)

- Add complexity / max-depth / max-lines-per-function ESLint rules.
- Surface db.ts invoke errors via debugLog instead of silent swallow.
- Adopt labelArg() helper for tool displayLabel boilerplate.
- Re-document AppLogger as a tee sink, not a decorator.
- Add attachThumbnailIfImage helper, used in fs-read and fs-write.
[optional] - Split setup/+page.svelte into per-step components.
[optional] - Split chat.svelte.ts into state/actions/persistence.

Resolves audits/code-duplication-2026-05-14.md R-8, T-10, T-12,
and audits/code-complexity-2026-05-14.md C-13 (setup),
audits/design-patterns-2026-05-14.md P-7, P-8.
```

## End-of-plan checklist

After Phase 12 lands, the codebase should:

- [ ] Have zero functions over 100 LOC outside `loop.ts`/`chat.svelte.ts` (those are now ≤ 50 LOC for top-level orchestrators)
- [ ] Have no source file over 1 000 LOC except scripts/static assets
- [ ] Have `cargo clippy -- -D warnings` clean
- [ ] Have `npm run lint` clean (or with documented warnings under the new complexity rules)
- [ ] Pass every test prompt from Phases 01–11 verbatim
- [ ] Have the three audits' findings folder retained for historical reference

Tag the merge commit `v0.X.Y-refactor-complete` or similar so future bisects can locate the boundary.
