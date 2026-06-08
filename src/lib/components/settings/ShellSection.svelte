<script lang="ts">
	import { getSettings, updateSettings } from '$lib/stores/settings';

	let shellBinary = $state(getSettings().shellBinary);
	let shellHistoryTurnsForPrompt = $state(getSettings().shellHistoryTurnsForPrompt);
	let shellMaxBytesPerCapture = $state(getSettings().shellMaxBytesPerCapture);
	let shellAllowWrite = $state(getSettings().shellAllowWrite);
	let shellRunAutoSubmit = $state(getSettings().shellRunAutoSubmit);

	function persistBinary() {
		updateSettings({ shellBinary: shellBinary.trim() });
	}

	function persistHistoryTurns() {
		const clamped = Math.max(0, Math.min(20, Math.floor(shellHistoryTurnsForPrompt)));
		shellHistoryTurnsForPrompt = clamped;
		updateSettings({ shellHistoryTurnsForPrompt: clamped });
	}

	function persistMaxBytes() {
		const clamped = Math.max(0, Math.min(1_048_576, Math.floor(shellMaxBytesPerCapture)));
		shellMaxBytesPerCapture = clamped;
		updateSettings({ shellMaxBytesPerCapture: clamped });
	}

	function persistAllowWrite() {
		updateSettings({ shellAllowWrite });
	}

	function persistRunAutoSubmit() {
		updateSettings({ shellRunAutoSubmit });
	}
</script>

<section class="card">
	<h3>Shell binary</h3>
	<p class="help">
		The Shell tab spawns this program for the interactive terminal. Leave blank to use your
		<code>$SHELL</code>
		(falling back to <code>/bin/bash</code> if unset). Override with an absolute path to launch a
		different shell — e.g. <code>/usr/bin/fish</code> or <code>/usr/bin/nu</code>. Bash and zsh get
		the OSC 133 shell-integration hooks; other shells still work as terminals but lose the
		smart-default capture (use mouse selection instead).
	</p>
	<input
		type="text"
		placeholder="(auto-detect $SHELL)"
		bind:value={shellBinary}
		onblur={persistBinary}
		onkeydown={(e) => e.key === 'Enter' && persistBinary()}
	/>
	<p class="hint">Takes effect the next time you open the Shell tab or restart the app.</p>
</section>

<section class="card danger" class:enabled={shellAllowWrite}>
	<h3>Allow the assistant to write files</h3>
	<label class="row">
		<input type="checkbox" bind:checked={shellAllowWrite} onchange={persistAllowWrite} />
		<span>Enable <code>fs_write_text</code> and <code>fs_edit_text</code> in Shell mode</span>
	</label>
	<p class="help">
		When on, the Shell-tab assistant can write or edit any file the app's user account can write to
		— including system files under <code>/etc</code>, <code>/var</code>, and similar. Off by
		default. The model still won't execute shell commands directly; it just gains the ability to
		modify file contents on its own when it judges that the right fix. Reads are always allowed
		regardless of this setting.
	</p>
</section>

<section class="card">
	<h3>Send command output back to the assistant after Run</h3>
	<label class="row">
		<input type="checkbox" bind:checked={shellRunAutoSubmit} onchange={persistRunAutoSubmit} />
		<span>Auto-submit the result when you click <strong>Run</strong> on a suggested command</span>
	</label>
	<p class="help">
		Off by default. When on, clicking <strong>Run</strong> on an assistant-suggested command
		executes it in the terminal, waits for it to finish, then automatically sends the command's
		output back to the assistant for analysis. While off, <strong>Run</strong> just executes the command
		and stops there — you stay in control of whether the assistant ever sees the output. Either way you
		can still ask about it manually from the composer.
	</p>
</section>

<section class="card">
	<h3>Recent shell commands attached to each chat message</h3>
	<label class="row">
		<input
			type="number"
			min="0"
			max="20"
			bind:value={shellHistoryTurnsForPrompt}
			onblur={persistHistoryTurns}
			onkeydown={(e) => e.key === 'Enter' && persistHistoryTurns()}
		/>
		<span>commands (and their output) included automatically</span>
	</label>
	<p class="help">
		Every message you send from the Shell tab's assistant composer is prefixed with the last N
		completed commands captured from the terminal — including the command, output, exit code, and
		cwd. Set to <code>0</code> to disable auto-attach and only send your typed question. Default
		<code>3</code>.
	</p>
</section>

<section class="card">
	<h3>Max output bytes per captured command</h3>
	<label class="row">
		<input
			type="number"
			min="0"
			max="1048576"
			step="1024"
			bind:value={shellMaxBytesPerCapture}
			onblur={persistMaxBytes}
			onkeydown={(e) => e.key === 'Enter' && persistMaxBytes()}
		/>
		<span>bytes (head + tail kept, middle dropped if larger)</span>
	</label>
	<p class="help">
		Caps each captured command's output before it's sent to the model. Outputs over the cap keep the
		first and last halves with a <code>[middle truncated]</code> marker in between, so one big
		<code>dmesg</code>
		or <code>journalctl</code> doesn't blow your whole context window. Set to <code>0</code> to
		disable and send raw output (risky for long logs). Default
		<code>8192</code> (8 KiB ≈ ~2K tokens).
	</p>
</section>

<style>
	.card {
		background: var(--bg-secondary);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 16px;
		margin-bottom: 16px;
	}

	.card.danger.enabled {
		border-color: var(--error-text, #c66);
	}

	.card h3 {
		margin: 0 0 8px;
		font-size: 0.95rem;
		font-weight: 600;
	}

	.help {
		color: var(--text-secondary);
		font-size: 0.85rem;
		line-height: 1.45;
		margin: 0 0 12px;
	}

	.hint {
		color: var(--text-secondary);
		font-size: 0.78rem;
		margin: 6px 0 0;
		font-style: italic;
	}

	code {
		background: var(--bg-primary);
		padding: 1px 6px;
		border-radius: 4px;
		font-size: 0.85em;
	}

	input[type='text'] {
		width: 100%;
		padding: 8px 10px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-primary);
		color: var(--text-primary);
		font-family: ui-monospace, Menlo, Monaco, 'Cascadia Mono', 'Courier New', monospace;
		font-size: 0.85rem;
		outline: none;
		box-sizing: border-box;
	}

	input[type='text']:focus {
		border-color: var(--accent);
	}

	input[type='number'] {
		width: 70px;
		padding: 6px 8px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-primary);
		color: var(--text-primary);
		font-size: 0.9rem;
		outline: none;
	}

	input[type='number']:focus {
		border-color: var(--accent);
	}

	.row {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 0.9rem;
	}
</style>
