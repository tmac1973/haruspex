<script lang="ts">
	import { getSettings, updateSettings } from '#lib/stores/settings.ts';
	import { clampInt } from '#lib/utils/clampInt.ts';

	let shellBinary = $state(getSettings().shellBinary);
	let shellHistoryTurnsForPrompt = $state(getSettings().shellHistoryTurnsForPrompt);
	let shellIncludeHistoryFile = $state(getSettings().shellIncludeHistoryFile);
	let shellMaxBytesPerCapture = $state(getSettings().shellMaxBytesPerCapture);

	function persistBinary() {
		updateSettings({ shellBinary: shellBinary.trim() });
	}

	function persistHistoryTurns() {
		const clamped = clampInt(shellHistoryTurnsForPrompt, 0, 20);
		shellHistoryTurnsForPrompt = clamped;
		updateSettings({ shellHistoryTurnsForPrompt: clamped });
	}

	function persistIncludeHistoryFile() {
		updateSettings({ shellIncludeHistoryFile });
	}

	function persistMaxBytes() {
		const clamped = clampInt(shellMaxBytesPerCapture, 0, 1_048_576);
		shellMaxBytesPerCapture = clamped;
		updateSettings({ shellMaxBytesPerCapture: clamped });
	}

	let shellFullAccessDefault = $state(getSettings().shellFullAccessDefault);
	let codeCommandExec = $state(getSettings().codeCommandExec);
	let commandMemoryLimitPercent = $state(getSettings().commandMemoryLimitPercent);

	function persistFullAccessDefault() {
		updateSettings({ shellFullAccessDefault });
	}
	function persistCodeCommandExec() {
		updateSettings({ codeCommandExec });
	}
	function persistMemoryLimit() {
		const clamped = clampInt(commandMemoryLimitPercent, 0, 90);
		commandMemoryLimitPercent = clamped;
		updateSettings({ commandMemoryLimitPercent: clamped });
	}
</script>

<section class="settings-section">
	<h2>Shell binary</h2>
	<p class="help">
		The Shell tab spawns this program for the interactive terminal. Leave blank to use your
		<code>$SHELL</code>
		(falling back to <code>/bin/bash</code> if unset). Override with an absolute path to launch a
		different shell — e.g. <code>/usr/bin/fish</code> or <code>/usr/bin/nu</code>. Bash and zsh get
		the OSC 133 shell-integration hooks, and fish 4 sends them itself; other shells still work as
		terminals but lose the smart-default capture (use mouse selection instead).
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

<section class="settings-section">
	<h2>Recent shell commands attached to each chat message</h2>
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

<section class="settings-section">
	<h2>Include your shell history file in prompts</h2>
	<label class="toggle-row">
		<input
			type="checkbox"
			bind:checked={shellIncludeHistoryFile}
			onchange={persistIncludeHistoryFile}
		/>
		<span>Send recent lines from your shell history file as extra context</span>
	</label>
	<p class="help">
		On by default. When on, the assistant's system prompt includes the last 10 lines of your shell
		history file (<code>$HISTFILE</code>, <code>~/.bash_history</code>,
		<code>~/.zsh_history</code>, or the fish history) as breadcrumbs about what you've been working
		on. That file spans <strong>other terminals and previous sessions</strong> — not just the shell in
		front of you — which is useful context but also a privacy consideration: turn this off to keep that
		file out of prompts entirely. While on, the exact lines sent are disclosed above each of your messages
		in the assistant sidebar. This is separate from the per-message command capture above, which only
		ever covers the current session.
	</p>
</section>

<section class="settings-section">
	<h2>Max output bytes per captured command</h2>
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

<h2 class="group-heading">Full access</h2>
<p class="moved">
	Full access also uses the timeout, step limit and auto-approve in Settings → Code.
</p>

<section class="settings-section">
	<h2>Start new shells with Full access</h2>
	<label
		class="toggle-row"
		title="Read-only: the assistant reads files and suggests commands. Full access: it also runs commands in your terminal and edits files. Each shell has its own lock in the assistant's header. Only affects shells opened after this change."
	>
		<input
			type="checkbox"
			bind:checked={shellFullAccessDefault}
			onchange={persistFullAccessDefault}
		/>
		<span>New shells let the assistant run commands and edit files</span>
	</label>
</section>

<section class="settings-section">
	<h2>Command execution</h2>
	<p class="help">
		How the assistant's <code>run_command</code> runs with Full access. <strong>Auto</strong> drives
		your live interactive terminal (sharing the activated venv / env / cwd, visible in your
		scrollback) when shell integration is available, falling back to a one-shot <code>bash -c</code>
		otherwise.
		<strong>Terminal</strong> forces the PTY path; <strong>One-shot</strong> always runs a fresh isolated
		process.
	</p>
	<select bind:value={codeCommandExec} onchange={persistCodeCommandExec}>
		<option value="auto">Auto (PTY when available, else one-shot)</option>
		<option value="pty">Terminal (PTY) only</option>
		<option value="oneshot">One-shot capture only</option>
	</select>
</section>

<section class="settings-section">
	<h2>Memory limit</h2>
	<label
		class="row"
		title="Applies to each command the agent runs on its own, and to each Shell tab's terminal as a whole, your own commands included. Over it, the system stops the process using the memory, and the agent is told why. Tabs opened after a change use the new limit. Needs Linux with a systemd user session. 0 turns it off."
	>
		<input
			type="number"
			min="0"
			max="90"
			step="5"
			bind:value={commandMemoryLimitPercent}
			onblur={persistMemoryLimit}
			onkeydown={(e) => e.key === 'Enter' && persistMemoryLimit()}
		/>
		<span>% of RAM</span>
	</label>
	<p class="help">Stops a runaway build or test before it takes the app down with it.</p>
</section>

<style>
	/* Sub-group label between the terminal cards and the Full-access cards. */
	.group-heading {
		margin: 18px 0 12px;
		font-size: 0.9rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--accent);
	}

	.moved {
		margin: -4px 0 12px;
		font-size: 0.85rem;
		color: var(--text-secondary);
	}

	select {
		width: 100%;
		padding: 8px 10px;
		border: 1px solid var(--border-strong);
		border-radius: 7px;
		font-size: 0.9rem;
		background-color: var(--bg-input);
		color: var(--text-primary);
		color-scheme: light dark;
	}

	.help {
		color: var(--text-secondary);
		font-size: 0.85rem;
		line-height: 1.45;
		margin: 0 0 12px;
	}

	.hint {
		margin: 6px 0 0;
		font-style: italic;
	}

	code {
		background: var(--bg-raised);
		padding: 1px 6px;
		border-radius: 4px;
		font-size: 0.85em;
	}

	input[type='text'] {
		width: 100%;
		padding: 8px 10px;
		border: 1px solid var(--border-strong);
		border-radius: 7px;
		background: var(--bg-input);
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
		border: 1px solid var(--border-strong);
		border-radius: 7px;
		background: var(--bg-input);
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
