<script lang="ts">
	import { getSettings, updateSettings, isReasoningSupported } from '$lib/stores/settings';

	let thinkingEnabled = $state(getSettings().thinkingEnabled);
	// The active backend may report that its model has no reasoning mode (an
	// llama-toolchest non-reasoning model); hide the toggle in that case since
	// it would have no effect. Local + other remote backends are assumed
	// capable. Snapshot at mount, matching the rest of this section.
	let reasoningSupported = $state(isReasoningSupported());
	let keepRecentToolResults = $state(getSettings().keepRecentToolResults);
	let customSystemPrompt = $state(getSettings().customSystemPrompt);
	let sandboxEnabled = $state(getSettings().sandboxEnabled);
	let sandboxApproval = $state(getSettings().sandboxApproval);
	let sandboxTimeoutSeconds = $state(getSettings().sandboxTimeoutSeconds);

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
		const clamped = Math.max(5, Math.min(300, Math.round(seconds)));
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
		font-size: 0.8rem;
		color: var(--text-secondary);
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

	.toggle-row {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 8px 0;
		cursor: pointer;
	}

	.toggle-row input[type='checkbox'] {
		margin-top: 3px;
		accent-color: var(--accent);
	}

	.toggle-row strong {
		display: block;
		font-size: 0.9rem;
	}

	.toggle-row span {
		display: block;
		font-size: 0.8rem;
		color: var(--text-secondary);
		margin-top: 2px;
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
</style>
