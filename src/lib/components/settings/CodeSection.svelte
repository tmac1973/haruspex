<script lang="ts">
	/**
	 * Settings → Code: how the coding agent runs commands, in the Code tab and
	 * in the Shell's Full access. The keys predate the Code tab and kept their
	 * names when they moved here from Settings → Shell.
	 */
	import { getSettings, updateSettings } from '#lib/stores/settings.ts';
	import { clampInt } from '#lib/utils/clampInt.ts';
	import { agentPowershell } from '#lib/code/powershell.ts';
	import type { AgentPowershell } from '#lib/ipc/gen/AgentPowershell.ts';
	import { onMount } from 'svelte';

	let codeRunCommandTimeoutSecs = $state(getSettings().codeRunCommandTimeoutSecs);
	let codeMaxIterations = $state(getSettings().codeMaxIterations);
	let codeAutoApprove = $state(getSettings().codeAutoApprove);
	let codeBgLogCapMb = $state(getSettings().codeBgLogCapMb);
	let codeSubtasks = $state(getSettings().codeSubtasks);
	let codeStorePowershell = $state(getSettings().codeStorePowershell);
	/** Windows: what the agent's PowerShell is; the Store option shows only where it applies. */
	let powershell = $state<AgentPowershell | null>(null);

	onMount(async () => {
		powershell = await agentPowershell();
	});

	function persistTimeout() {
		codeRunCommandTimeoutSecs = clampInt(codeRunCommandTimeoutSecs, 5, 1800);
		updateSettings({ codeRunCommandTimeoutSecs });
	}
	function persistMaxIterations() {
		codeMaxIterations = clampInt(codeMaxIterations, 5, 200);
		updateSettings({ codeMaxIterations });
	}
	function persistAutoApprove() {
		updateSettings({ codeAutoApprove });
	}
	async function persistStorePowershell() {
		updateSettings({ codeStorePowershell });
		powershell = await agentPowershell();
	}
	function persistSubtasks() {
		updateSettings({ codeSubtasks });
	}
	function persistLogCap() {
		codeBgLogCapMb = clampInt(codeBgLogCapMb, 1, 1024);
		updateSettings({ codeBgLogCapMb });
	}
</script>

<section class="settings-section">
	<h2>run_command timeout</h2>
	<label
		class="row"
		title="The model can set a longer limit for a slow build or test. Servers and watchers should run in the background instead. 5–1800 seconds."
	>
		<input
			type="number"
			min="5"
			max="1800"
			step="5"
			bind:value={codeRunCommandTimeoutSecs}
			onblur={persistTimeout}
			onkeydown={(e) => e.key === 'Enter' && persistTimeout()}
		/>
		<span>seconds</span>
	</label>
	<p class="help">How long one command may run before it is stopped.</p>
</section>

<section class="settings-section">
	<h2>Max steps per task</h2>
	<label
		class="row"
		title="Each tool call or model reply is a step. Raise it if the agent is told to wrap up before it finishes. 5–200."
	>
		<input
			type="number"
			min="5"
			max="200"
			step="5"
			bind:value={codeMaxIterations}
			onblur={persistMaxIterations}
			onkeydown={(e) => e.key === 'Enter' && persistMaxIterations()}
		/>
		<span>steps</span>
	</label>
	<p class="help">How many steps the agent takes before it has to stop and report.</p>
</section>

<section class="settings-section">
	<h2>Subtasks</h2>
	<label
		class="row"
		title="The agent can hand a self-contained part of a task to a helper agent that starts with a fresh context and reports back. Several run at once when Settings → Inference → Parallel streams allows it. Read-only helpers read and search. With Read and write, a helper can also change files in its own copy of the project (git repositories only), and its changes are applied when it finishes. Helpers never ask you anything; their commands follow the session's approval rules."
	>
		<select bind:value={codeSubtasks} onchange={persistSubtasks}>
			<option value="off">Off</option>
			<option value="read">Read only</option>
			<option value="write">Read and write</option>
		</select>
	</label>
	<p class="help">Let the agent hand parts of a task to helper agents.</p>
</section>

<section class="settings-section">
	<h2>Background log size</h2>
	<label
		class="row"
		title="Each command the agent starts in the background in the Code tab keeps its output in a log. Past this size the oldest output is dropped. Applies to commands started after a change. 1–1024 MB."
	>
		<input
			type="number"
			min="1"
			max="1024"
			step="1"
			bind:value={codeBgLogCapMb}
			onblur={persistLogCap}
			onkeydown={(e) => e.key === 'Enter' && persistLogCap()}
		/>
		<span>MB per process</span>
	</label>
	<p class="help">The most output a background process keeps.</p>
</section>

{#if powershell?.store_pwsh}
	<section class="settings-section">
		<h2>PowerShell 7 from the Microsoft Store</h2>
		<label
			class="toggle-row"
			title="Windows runs the Store's PowerShell 7 outside Haruspex's control: Stop and the time limit may leave what a command started running, and Settings → Shell → Memory limit doesn't apply. Off, commands in a Windows folder run in Windows PowerShell 5.1. To have both, install PowerShell 7 with: winget install Microsoft.PowerShell"
		>
			<input
				type="checkbox"
				bind:checked={codeStorePowershell}
				onchange={() => void persistStorePowershell()}
			/>
			<span>Run commands in a Windows folder with it instead of Windows PowerShell 5.1</span>
		</label>
		<p class="help">
			Stop and the memory limit don't fully reach it. <code
				>winget install Microsoft.PowerShell</code
			>
			gives you PowerShell 7 without that.
		</p>
	</section>
{/if}

<section class="settings-section danger" class:enabled={codeAutoApprove}>
	<h2>Auto-approve commands</h2>
	<label
		class="toggle-row"
		title="When off, a command the risk check flags (sudo, destructive deletes, a pipe to a shell) asks first. A command that reaches outside the project always asks."
	>
		<input type="checkbox" bind:checked={codeAutoApprove} onchange={persistAutoApprove} />
		<span>Run risk-flagged commands without prompting</span>
	</label>
	<p class="help">Only turn this on if you fully trust the model on this machine.</p>
</section>

<style>
	section.danger.enabled {
		border-color: var(--error-text);
	}

	.help {
		color: var(--text-secondary);
		font-size: 0.85rem;
		line-height: 1.45;
		margin: 8px 0 0;
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
