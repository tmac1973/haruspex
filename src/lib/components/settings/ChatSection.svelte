<script lang="ts">
	/**
	 * Settings → Chat: what only the Chat tab uses. Was Settings → Agent, whose
	 * shared model defaults now live in Settings → Inference → Model defaults.
	 */
	import {
		getSettings,
		updateSettings,
		MIN_CHAT_MAX_ITERATIONS,
		MAX_CHAT_MAX_ITERATIONS,
		type SandboxNetAccess
	} from '#lib/stores/settings.ts';
	import { open as openFolderDialog } from '@tauri-apps/plugin-dialog';
	import { clampInt } from '#lib/utils/clampInt.ts';
	import { setDefaultWorkingDir } from '#lib/stores/chat.svelte.ts';

	let includeImages = $state(getSettings().includeImages);
	let keepRecentToolResults = $state(getSettings().keepRecentToolResults);
	let customSystemPrompt = $state(getSettings().customSystemPrompt);
	let sandboxEnabled = $state(getSettings().sandboxEnabled);
	let sandboxApproval = $state(getSettings().sandboxApproval);
	let sandboxTimeoutSeconds = $state(getSettings().sandboxTimeoutSeconds);
	let sandboxNetAccess = $state(getSettings().sandboxNetAccess);
	let chatMaxIterations = $state(getSettings().chatMaxIterations);
	let defaultWorkingDir = $state(getSettings().chatDefaultWorkingDir);

	async function pickDefaultWorkingDir() {
		try {
			const chosen = await openFolderDialog({
				directory: true,
				multiple: false,
				title: 'Default working directory'
			});
			if (typeof chosen !== 'string') return;
			defaultWorkingDir = chosen;
			setDefaultWorkingDir(chosen);
		} catch (e) {
			console.error('Failed to pick directory:', e);
		}
	}

	function clearDefaultWorkingDir() {
		defaultWorkingDir = '';
		setDefaultWorkingDir(null);
	}

	function persistChatMaxIterations() {
		chatMaxIterations = clampInt(
			chatMaxIterations,
			MIN_CHAT_MAX_ITERATIONS,
			MAX_CHAT_MAX_ITERATIONS
		);
		updateSettings({ chatMaxIterations });
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

	function setSandboxNetAccess(access: SandboxNetAccess) {
		sandboxNetAccess = access;
		updateSettings({ sandboxNetAccess: access });
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

	function toggleIncludeImages() {
		updateSettings({ includeImages });
	}
</script>

<section class="settings-section">
	<h2>Max steps per turn</h2>
	<label
		class="tokens-row"
		title="Each tool call or model reply is a step. Raise it if answers stop before the research is done. Deep research gets at least 25. Settings → Code and Settings → Shell have their own limits. {MIN_CHAT_MAX_ITERATIONS}–{MAX_CHAT_MAX_ITERATIONS}."
	>
		<span class="tokens-label">
			Chat steps
			<span class="tokens-sub">How many steps a chat turn takes before it has to answer.</span>
		</span>
		<input
			type="number"
			min={MIN_CHAT_MAX_ITERATIONS}
			max={MAX_CHAT_MAX_ITERATIONS}
			step="5"
			bind:value={chatMaxIterations}
			onblur={persistChatMaxIterations}
			onkeydown={(e) => e.key === 'Enter' && persistChatMaxIterations()}
		/>
	</label>
	<label
		class="toggle-row"
		title="Lets a follow-up question use the raw page contents and search results from the most recent turn. Older tool results are still dropped, and the conversation may be summarized sooner."
	>
		<input type="checkbox" checked={keepRecentToolResults} onchange={toggleKeepRecentToolResults} />
		<div>
			<strong>Keep tool results from the previous turn in context</strong>
			<span>Follow-ups can use what the last turn found, at the cost of more context.</span>
		</div>
	</label>
</section>

<section class="settings-section">
	<h2>Default working directory</h2>
	<p
		class="hint"
		title="Picking a folder in a chat changes only that chat. With none set here, a new chat has no file access until you pick one."
	>
		The folder each new chat starts in.
	</p>
	<div class="folder-row">
		{#if defaultWorkingDir}
			<code>{defaultWorkingDir}</code>
			<button class="btn btn-small" onclick={pickDefaultWorkingDir}>Change…</button>
			<button class="btn btn-small" onclick={clearDefaultWorkingDir}>Clear</button>
		{:else}
			<span class="none">None</span>
			<button class="btn btn-small" onclick={pickDefaultWorkingDir}>Choose folder…</button>
		{/if}
	</div>
</section>

<section class="settings-section">
	<h2>Additional system prompt</h2>
	<div
		class="search-field"
		title="Appended to the built-in system prompt for every new chat turn. Use it to steer tone, persona, languages or domain rules. Clear the box to go back to the defaults. Settings → Code has its own."
	>
		<textarea
			id="custom-system-prompt"
			aria-label="Additional system prompt"
			rows="6"
			bind:value={customSystemPrompt}
			onblur={saveCustomSystemPrompt}
			placeholder={customSystemPromptPlaceholder}></textarea>
		<p class="hint">Your own instructions for every chat.</p>
	</div>
</section>

<section class="settings-section">
	<h2>Python Sandbox</h2>
	<label
		class="toggle-row"
		title={'The model runs Python in a Pyodide WebAssembly sandbox ' +
			'(run_python / install_package / reset_python). numpy, pandas, matplotlib, ' +
			'scipy, scikit-learn, sympy, pillow and plotly are bundled; other packages ' +
			'install on first import. Charts show in the chat, and files written from ' +
			'Python land in your working directory.'}
	>
		<input type="checkbox" checked={sandboxEnabled} onchange={toggleSandboxEnabled} />
		<div>
			<strong>Enable Python sandbox</strong>
			<span>Lets the model run Python in an in-app sandbox.</span>
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
			<label for="sandbox-net">Network access:</label>
			<select
				id="sandbox-net"
				value={sandboxNetAccess}
				onchange={(e) =>
					setSandboxNetAccess((e.target as HTMLSelectElement).value as SandboxNetAccess)}
			>
				<option value="internet">Internet only</option>
				<option value="lan">Internet and local network</option>
				<option value="all">Everything, including this computer</option>
			</select>
		</div>
		<p
			class="hint"
			title="This computer includes Haruspex's own model, speech and remote-access servers."
		>
			What Python code may connect to. Uses the network proxy in Settings → Network.
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
		<p
			class="hint"
			title="Raise it for long installs or simulations. 5–300 seconds; 60 by default."
		>
			How long one run_python or install_package call may take before it is stopped.
		</p>
	{/if}
</section>

<section class="settings-section">
	<h2>Pictures in answers</h2>
	<label class="toggle-row">
		<input type="checkbox" bind:checked={includeImages} onchange={toggleIncludeImages} />
		<span>Include images in answers</span>
	</label>
	<!-- Said next to the switch because it is the obvious worry for anyone
	     who chose this app: turning pictures on must not start leaking your
	     browsing to whichever sites host them. -->
	<p class="hint">
		When on, answers may include a few relevant pictures from freely-licensed sources. Haruspex
		downloads them itself — the page never sees your computer — and keeps them on this device. Works
		best with a larger model.
	</p>
</section>

<style>
	.hint {
		margin: 0 0 16px 0;
	}

	.folder-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.folder-row code,
	.folder-row .none {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.folder-row .none {
		color: var(--text-secondary);
		font-size: 0.85rem;
	}

	/* Global .toggle-row supplies the base style; sections add row padding. */
	.toggle-row {
		padding: 8px 0;
	}

	.search-provider {
		margin-bottom: 12px;
	}

	.search-provider label {
		display: block;
		font-size: 0.85rem;
		font-weight: 500;
		margin-bottom: 6px;
	}

	.search-provider select,
	.search-provider input,
	.search-field textarea {
		box-sizing: border-box;
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
