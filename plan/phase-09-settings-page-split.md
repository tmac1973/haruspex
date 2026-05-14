# Phase 09 — `settings/+page.svelte` split

**Severity addressed:** 8 · **Effort:** ~4 hours · **Risk:** Low

Resolves complexity-audit C-5 (1 628-line page; 435 script + 612 style).

## Goal

Split `src/routes/settings/+page.svelte` into a thin orchestrator route + one component per settings family. Each section becomes independently editable and ~80–150 LOC.

## Files touched

- **EDIT** `src/routes/settings/+page.svelte` (becomes ~120 LOC orchestrator)
- **NEW** `src/lib/components/settings/InferenceSection.svelte`
- **NEW** `src/lib/components/settings/EmailSection.svelte`
- **NEW** `src/lib/components/settings/TtsSection.svelte`
- **NEW** `src/lib/components/settings/SearchSection.svelte`
- **NEW** `src/lib/components/settings/ProxySection.svelte`
- **NEW** `src/lib/components/settings/ResponseFormatSection.svelte`
- **NEW** `src/lib/components/settings/AdvancedSection.svelte` — for context size, debug log clearing, response format, keepRecentToolResults, etc.

## Implementation

### Step 1 — extract one section at a time

For each section component:

1. Create the file with a `<script lang="ts">` block, the section's `<h2>` and form fields, and only the styles that section uses.
2. The script reads from `getSettings()` and writes via `updateSettings(...)` — same API the page uses today.
3. Replace the section's markup in `+page.svelte` with `<InferenceSection />` (or appropriate component name).

**Order:** start with the simplest section (`ResponseFormatSection` or `TtsSection`). This proves the pattern before tackling `EmailSection` which has a list with CRUD.

### Step 2 — sketch for one section

```svelte
<!-- src/lib/components/settings/TtsSection.svelte -->
<script lang="ts">
	import { getSettings, updateSettings } from '$lib/stores/settings';

	let ttsVoice = $state(getSettings().ttsVoice);
	let readTablesByColumn = $state(getSettings().readTablesByColumn);

	function setTtsVoice(voice: string) {
		ttsVoice = voice;
		updateSettings({ ttsVoice: voice });
	}

	function toggleTableReading() {
		readTablesByColumn = !readTablesByColumn;
		updateSettings({ readTablesByColumn });
	}
</script>

<section>
	<h2>Text-to-Speech</h2>
	<label>
		Voice
		<select value={ttsVoice} onchange={(e) => setTtsVoice((e.target as HTMLSelectElement).value)}>
			<option value="af_bella">Bella (US, female)</option>
			<option value="am_michael">Michael (US, male)</option>
			<!-- existing options -->
		</select>
	</label>
	<label>
		<input type="checkbox" checked={readTablesByColumn} onchange={toggleTableReading} />
		Read tables column-by-column
	</label>
</section>

<style>
	section { margin-bottom: 32px; }
	h2 { font-size: 1rem; margin-bottom: 12px; color: var(--text-primary); }
	label { display: block; margin: 8px 0; font-size: 0.9rem; }
	select { margin-left: 8px; }
</style>
```

### Step 3 — `+page.svelte` becomes:

```svelte
<script lang="ts">
	import InferenceSection from '$lib/components/settings/InferenceSection.svelte';
	import EmailSection from '$lib/components/settings/EmailSection.svelte';
	import TtsSection from '$lib/components/settings/TtsSection.svelte';
	import SearchSection from '$lib/components/settings/SearchSection.svelte';
	import ProxySection from '$lib/components/settings/ProxySection.svelte';
	import ResponseFormatSection from '$lib/components/settings/ResponseFormatSection.svelte';
	import AdvancedSection from '$lib/components/settings/AdvancedSection.svelte';
	import { goto } from '$app/navigation';
</script>

<div class="settings-page">
	<header>
		<button onclick={() => goto('/')}>← Back</button>
		<h1>Settings</h1>
	</header>

	<InferenceSection />
	<SearchSection />
	<ResponseFormatSection />
	<TtsSection />
	<EmailSection />
	<ProxySection />
	<AdvancedSection />
</div>

<style>
	.settings-page { max-width: 720px; margin: 0 auto; padding: 24px; }
	header { display: flex; align-items: center; gap: 16px; margin-bottom: 24px; }
	h1 { margin: 0; font-size: 1.5rem; }
</style>
```

### Step 4 — special-case `EmailSection`

This one owns CRUD over a list of accounts plus the preset loader. Pull `newBlankAccount`, `loadEmailPresets`, `addEmailAccount`, `updateEmailAccount`, `deleteEmailAccount` (currently `settings/+page.svelte:167-214`) into the component.

### Step 5 — special-case `InferenceSection`

Owns the mode switcher, the `InferenceBackendForm` integration, and the `setInferenceMode` async logic (currently `settings/+page.svelte:102-160`).

## Build gate

```bash
npm run check
npm run lint
npm run build
```

## Test plan

### Smoke

1. App launches. Navigate to Settings. The page renders all sections.

### Targeted — settings round-trip

For each setting, follow this loop: **change → reload app → verify persisted**.

2. **Response format:** switch between options. Reload. The selected option is restored.
3. **Theme:** toggle light/dark. UI updates immediately. Reload — preference held.
4. **TTS voice:** pick a different voice. Hit a speaker button on an assistant reply; the new voice plays.
5. **Read tables by column:** toggle off. Speak an assistant message containing a table; the reading order matches the toggle.
6. **Search provider:** change to each provider in turn; in chat, run a search query; verify the correct backend is used (see Phase 06 test plan for the per-provider verification).
7. **Search recency:** change the value; the next web_search request includes the recency in its argument.
8. **Brave API key:** enter, save. Reload. The masked value is restored.
9. **SearXNG URL:** enter, save. Reload. Restored.
10. **Context size:** change. The Rust side restarts the server (or reports it will). Status badge flips to starting → ready.
11. **Proxy mode/url/bypass:** change to "manual", set a URL and bypass list. The next outbound `proxy_fetch` honors them. (Test with a URL whose host is in the bypass list — should skip the proxy.)
12. **Email accounts:**
    - Click **Add account**. Choose a preset. Save. Reload — account persists.
    - Edit the account. Save. Reload — edit persists.
    - Delete the account. Reload — gone.
13. **Inference mode:** switch from local to remote (use any remote URL — `http://localhost:8765/v1` works for testing). Save. The status badge transitions; the next chat call goes to the remote endpoint.

If 2–13 all behave as before this phase, commit:

```
refactor: split settings/+page.svelte into per-section components (#TBD)

1628-line page split into 7 section components under
src/lib/components/settings/. The route is now a thin
orchestrator. No behavioural change; every settings field
round-trips through localStorage as before.

Resolves audits/code-complexity-2026-05-14.md C-5.
```
