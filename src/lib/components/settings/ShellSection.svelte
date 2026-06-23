<script lang="ts">
	import { getSettings, updateSettings } from '$lib/stores/settings';

	let shellBinary = $state(getSettings().shellBinary);
	let shellHistoryTurnsForPrompt = $state(getSettings().shellHistoryTurnsForPrompt);
	let shellMaxBytesPerCapture = $state(getSettings().shellMaxBytesPerCapture);

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

	let shellCodeModeDefault = $state(getSettings().shellCodeModeDefault);
	let codeAutoApprove = $state(getSettings().codeAutoApprove);
	let codeCommandExec = $state(getSettings().codeCommandExec);
	let codeRunCommandTimeoutSecs = $state(getSettings().codeRunCommandTimeoutSecs);
	let codeMaxIterations = $state(getSettings().codeMaxIterations);

	function persistCodeModeDefault() {
		updateSettings({ shellCodeModeDefault });
	}
	function persistCodeAutoApprove() {
		updateSettings({ codeAutoApprove });
	}
	function persistCodeMaxIterations() {
		const clamped = Math.max(5, Math.min(200, Math.floor(codeMaxIterations)));
		codeMaxIterations = clamped;
		updateSettings({ codeMaxIterations: clamped });
	}
	function persistCodeCommandExec() {
		updateSettings({ codeCommandExec });
	}
	function persistCodeTimeout() {
		const clamped = Math.max(5, Math.min(1800, Math.floor(codeRunCommandTimeoutSecs)));
		codeRunCommandTimeoutSecs = clamped;
		updateSettings({ codeRunCommandTimeoutSecs: clamped });
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

<h2 class="group-heading">Code mode</h2>

<section class="card">
	<h3>Enable Code mode by default in new shells</h3>
	<label class="row">
		<input type="checkbox" bind:checked={shellCodeModeDefault} onchange={persistCodeModeDefault} />
		<span>New Shell sessions start in Code mode</span>
	</label>
	<p class="help">
		Off by default. When off, a new shell opens as the read-only troubleshooting assistant (reads +
		command suggestions only) and you flip Code mode on per-session from the sidebar header. When
		on, every new shell starts already in Code mode, where the assistant can edit files and run
		commands. Only affects shells opened after this change.
	</p>
</section>

<section class="card">
	<h3>Command execution</h3>
	<p class="help">
		How the coding agent's <code>run_command</code> runs. <strong>Auto</strong> drives your live
		interactive terminal (sharing the activated venv / env / cwd, visible in your scrollback) when
		shell integration is available, falling back to a one-shot <code>sh -c</code> otherwise.
		<strong>Terminal</strong> forces the PTY path; <strong>One-shot</strong> always runs a fresh isolated
		process.
	</p>
	<select bind:value={codeCommandExec} onchange={persistCodeCommandExec}>
		<option value="auto">Auto (PTY when available, else one-shot)</option>
		<option value="pty">Terminal (PTY) only</option>
		<option value="oneshot">One-shot capture only</option>
	</select>
</section>

<section class="card">
	<h3>run_command timeout</h3>
	<label class="row">
		<input
			type="number"
			min="5"
			max="1800"
			step="5"
			bind:value={codeRunCommandTimeoutSecs}
			onblur={persistCodeTimeout}
			onkeydown={(e) => e.key === 'Enter' && persistCodeTimeout()}
		/>
		<span>seconds</span>
	</label>
	<p class="help">
		Default wall-clock limit for a single <code>run_command</code> call (the model can override per call).
		A PTY command that hits the limit is left running in your terminal. 5–1800 seconds.
	</p>
</section>

<section class="card">
	<h3>Max steps per task</h3>
	<label class="row">
		<input
			type="number"
			min="5"
			max="200"
			step="5"
			bind:value={codeMaxIterations}
			onblur={persistCodeMaxIterations}
			onkeydown={(e) => e.key === 'Enter' && persistCodeMaxIterations()}
		/>
		<span>tool/model steps before the agent is forced to wrap up</span>
	</label>
	<p class="help">
		Coding tasks chain many steps (grep → read → edit → test → fix). If the agent gets cut off
		mid-task and told to "wrap up", raise this. Context stays bounded across steps via compaction.
		Default <code>40</code>. 5–200.
	</p>
</section>

<section class="card danger" class:enabled={codeAutoApprove}>
	<h3>Auto-approve commands</h3>
	<label class="row">
		<input type="checkbox" bind:checked={codeAutoApprove} onchange={persistCodeAutoApprove} />
		<span>Run risk-flagged commands without prompting</span>
	</label>
	<p class="help">
		Off by default. When off, Code mode pops a confirmation before running anything the risk
		classifier flags (sudo, destructive deletes, pipes to a shell, etc.). Only enable if you fully
		trust the model on this machine — these commands run in your real shell.
	</p>
</section>

<style>
	.group-heading {
		margin: 8px 0 12px;
		font-size: 1.05rem;
		font-weight: 600;
		padding-bottom: 6px;
		border-bottom: 1px solid var(--border);
	}

	.card {
		background: var(--bg-secondary);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 16px;
		margin-bottom: 16px;
	}

	.card select {
		width: 100%;
		padding: 8px 10px;
		border: 1px solid var(--border);
		border-radius: 6px;
		font-size: 0.9rem;
		background-color: var(--bg-primary);
		color: var(--text-primary);
		color-scheme: light dark;
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
