<script lang="ts">
	import {
		getSettings,
		updateSettings,
		clampResponseTokens,
		DEFAULT_MAX_RESPONSE_TOKENS,
		DEFAULT_MAX_RESPONSE_TOKENS_FILE_WRITE,
		MIN_MAX_RESPONSE_TOKENS,
		MAX_MAX_RESPONSE_TOKENS
	} from '$lib/stores/settings';
	import { resolveBackendDescriptor } from '$lib/inference/descriptor';
	import { clampInt } from '$lib/utils/clampInt';

	let thinkingEnabled = $state(getSettings().thinkingEnabled);
	// The active backend may report that its model has no reasoning mode (an
	// llama-toolchest non-reasoning model); hide the toggle in that case since
	// it would have no effect. Local + other remote backends are assumed
	// capable. Snapshot at mount, matching the rest of this section.
	let reasoningSupported = $state(resolveBackendDescriptor().reasoningSupported);
	let keepRecentToolResults = $state(getSettings().keepRecentToolResults);
	let customSystemPrompt = $state(getSettings().customSystemPrompt);
	let sandboxEnabled = $state(getSettings().sandboxEnabled);
	let sandboxApproval = $state(getSettings().sandboxApproval);
	let sandboxTimeoutSeconds = $state(getSettings().sandboxTimeoutSeconds);
	let maxResponseTokens = $state(getSettings().maxResponseTokens);
	let maxResponseTokensFileWrite = $state(getSettings().maxResponseTokensFileWrite);

	/**
	 * Persist a response-token cap, clamped to the supported range. Clamping
	 * rather than rejecting: an out-of-range entry snaps to the nearest bound
	 * and the snapped value is what shows and persists, so the field can never
	 * be left holding a number the agent loop won't actually use.
	 */
	function onTokensChange(
		key: 'maxResponseTokens' | 'maxResponseTokensFileWrite',
		raw: string
	): void {
		const parsed = Number.parseInt(raw, 10);
		const fallback =
			key === 'maxResponseTokens'
				? DEFAULT_MAX_RESPONSE_TOKENS
				: DEFAULT_MAX_RESPONSE_TOKENS_FILE_WRITE;
		const clamped = clampResponseTokens(Number.isNaN(parsed) ? fallback : parsed);
		if (key === 'maxResponseTokens') maxResponseTokens = clamped;
		else maxResponseTokensFileWrite = clamped;
		updateSettings({ [key]: clamped });
	}

	function toggleThinkingEnabled() {
		thinkingEnabled = !thinkingEnabled;
		updateSettings({ thinkingEnabled });
	}

	function toggleKeepRecentToolResults() {
		keepRecentToolResults = !keepRecentToolResults;
		updateSettings({ keepRecentToolResults });
	}

	function saveCustomSystemPrompt() {
		updateSettings({ customSystemPrompt });
	}

	function toggleSandboxEnabled() {
		sandboxEnabled = !sandboxEnabled;
		updateSettings({ sandboxEnabled });
	}

	function setSandboxApproval(mode: 'off' | 'once-per-chat' | 'every-run') {
		sandboxApproval = mode;
		updateSettings({ sandboxApproval: mode });
	}

	function setSandboxTimeout(seconds: number) {
		const clamped = clampInt(seconds, 5, 300, Math.round);
		sandboxTimeoutSeconds = clamped;
		updateSettings({ sandboxTimeoutSeconds: clamped });
	}

	const customSystemPromptPlaceholder =
		'e.g. "Always answer in British English. Prefer Rust examples when explaining systems code."';
</script>

<section class="settings-section">
	<h2>Behavior</h2>
	{#if reasoningSupported}
		<label class="toggle-row">
			<input type="checkbox" checked={thinkingEnabled} onchange={toggleThinkingEnabled} />
			<div>
				<strong>Reasoning mode</strong>
				<span>
					Let the model emit a <code>&lt;think&gt;</code> reasoning block before its answer. Improves
					quality on code-heavy and multi-step tasks (Python sandbox, tool planning, debugging) at the
					cost of more tokens per turn. Turn off for lighter chat to save context.
				</span>
			</div>
		</label>
	{/if}
	<label class="toggle-row">
		<input type="checkbox" checked={keepRecentToolResults} onchange={toggleKeepRecentToolResults} />
		<div>
			<strong>Keep tool results from the previous turn in context</strong>
			<span>
				Lets followup questions reference raw research details (page contents, search results) from
				the most recent turn. Increases context usage — older tool results are still discarded, and
				conversation summarization may kick in sooner.
			</span>
		</div>
	</label>
	<div class="search-field" style="margin-top: 12px">
		<label for="custom-system-prompt">Additional system prompt:</label>
		<textarea
			id="custom-system-prompt"
			rows="6"
			bind:value={customSystemPrompt}
			onblur={saveCustomSystemPrompt}
			placeholder={customSystemPromptPlaceholder}
		></textarea>
		<p class="hint">
			Free-form instructions appended to the built-in system prompt. Use this to steer tone,
			persona, preferred languages, or domain-specific rules. Applies to every new turn — clear the
			box to revert to defaults.
		</p>
	</div>
</section>

<section class="settings-section">
	<h2>Response Length</h2>
	<p class="hint">
		How many tokens the model may generate in a single response, across every tab and every
		inference backend. Separate from Context Size, which bounds the whole conversation. A response
		cut off by these limits is refused rather than written, so a file is never left half-written.
	</p>
	<label class="tokens-row">
		<span class="tokens-label">
			Max response tokens
			<span class="tokens-sub">Normal chat, shell, and agent turns.</span>
		</span>
		<input
			type="number"
			min={MIN_MAX_RESPONSE_TOKENS}
			max={MAX_MAX_RESPONSE_TOKENS}
			step="512"
			value={maxResponseTokens}
			onchange={(e) => onTokensChange('maxResponseTokens', e.currentTarget.value)}
		/>
	</label>
	<label class="tokens-row">
		<span class="tokens-label">
			Max response tokens (file writes)
			<span class="tokens-sub">
				Turns whose job is to write a file. Needs more headroom: the whole document must fit in one
				response, and a reasoning model spends part of the budget thinking first.
			</span>
		</span>
		<input
			type="number"
			min={MIN_MAX_RESPONSE_TOKENS}
			max={MAX_MAX_RESPONSE_TOKENS}
			step="512"
			value={maxResponseTokensFileWrite}
			onchange={(e) => onTokensChange('maxResponseTokensFileWrite', e.currentTarget.value)}
		/>
	</label>
</section>

<section class="settings-section">
	<h2>
		Python Sandbox <span class="experimental-badge">experimental</span>
	</h2>
	<label
		class="toggle-row"
		title={'When on, the model can run Python code locally in a Pyodide WebAssembly ' +
			'sandbox (run_python / install_package / reset_python). Pre-installed packages ' +
			'include numpy, pandas, matplotlib, scipy, scikit-learn, sympy, pillow, fpdf2, ' +
			'and python-pptx — so the model can analyze data, plot charts, and build PDFs / ' +
			'PowerPoint decks programmatically. Files written from Python land in your ' +
			'working directory. With the sandbox ON, the legacy fs_write_pdf / fs_write_pptx ' +
			'tools are hidden in favor of the richer Python path. Experimental: behavior, ' +
			'defaults, and UI are still in flux.'}
	>
		<input type="checkbox" checked={sandboxEnabled} onchange={toggleSandboxEnabled} />
		<div>
			<strong>Enable Python sandbox</strong>
			<span>
				When on, the model can call run_python / install_package / reset_python to execute Python
				code in an in-app Pyodide sandbox, and uses fpdf2 / python-pptx for PDFs and PowerPoints
				(replacing fs_write_pdf / fs_write_pptx). Off hides those tools entirely and falls back to
				the legacy markdown→PDF / hand-rolled-PPTX writers.
			</span>
		</div>
	</label>

	{#if sandboxEnabled}
		<div class="search-provider">
			<label for="sandbox-approval">Approval prompt:</label>
			<select
				id="sandbox-approval"
				value={sandboxApproval}
				onchange={(e) =>
					setSandboxApproval(
						(e.target as HTMLSelectElement).value as 'off' | 'once-per-chat' | 'every-run'
					)}
			>
				<option value="off">Off — run code without asking</option>
				<option value="once-per-chat">Once per chat (recommended)</option>
				<option value="every-run">Every run — review each script</option>
			</select>
		</div>
		<p class="hint">
			Code runs locally in your browser's WebView, isolated from the host filesystem except where it
			explicitly writes (those writes flush to your working directory after the script finishes).
			The prompt is your gate; "off" only makes sense if you fully trust the model on this machine.
		</p>

		<div class="search-provider">
			<label for="sandbox-timeout">Execution timeout (seconds):</label>
			<input
				id="sandbox-timeout"
				type="number"
				min="5"
				max="300"
				step="5"
				value={sandboxTimeoutSeconds}
				onchange={(e) => setSandboxTimeout(Number((e.target as HTMLInputElement).value))}
			/>
		</div>
		<p class="hint">
			How long a single run_python or install_package call may take before it's terminated. 5–300
			seconds. The default 30s is generous for most code; raise it for long installs or simulations.
		</p>
	{/if}
</section>

<style>
	.hint {
		margin: 0 0 16px 0;
	}

	.experimental-badge {
		font-size: 0.65rem;
		font-weight: 500;
		padding: 1px 6px;
		border-radius: 4px;
		background: var(--bg-secondary);
		color: var(--text-secondary);
		border: 1px solid var(--border);
		text-transform: uppercase;
		vertical-align: middle;
		margin-left: 6px;
	}

	/* Global .toggle-row supplies the base style; sections add row padding. */
	.toggle-row {
		padding: 8px 0;
	}

	.search-provider {
		margin-bottom: 12px;
	}

	.search-provider label,
	.search-field label {
		display: block;
		font-size: 0.85rem;
		font-weight: 500;
		margin-bottom: 6px;
	}

	.search-provider select,
	.search-provider input,
	.search-field textarea {
		width: 100%;
		padding: 8px 12px;
		border: 1px solid var(--border);
		border-radius: 6px;
		font-size: 0.9rem;
		background-color: var(--bg-primary);
		color: var(--text-primary);
		color-scheme: light dark;
	}

	.search-field textarea {
		font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
		resize: vertical;
		min-height: 80px;
	}

	.search-field {
		margin-bottom: 12px;
	}
	.tokens-row {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
		margin-top: 12px;
	}

	.tokens-label {
		font-size: 0.85rem;
		color: var(--text-primary);
	}

	.tokens-sub {
		display: block;
		font-size: 0.7rem;
		color: var(--text-secondary);
		margin-top: 2px;
		max-width: 46ch;
	}

	.tokens-row input {
		flex-shrink: 0;
		width: 9ch;
		padding: 6px 8px;
		font-size: 0.85rem;
		font-variant-numeric: tabular-nums;
		text-align: right;
		color: var(--text-primary);
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 6px;
	}

	.tokens-row input:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}
</style>
