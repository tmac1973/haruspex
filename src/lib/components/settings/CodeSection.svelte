<script lang="ts">
	import { getSettings, updateSettings } from '$lib/stores/settings';
	import { open } from '@tauri-apps/plugin-dialog';
	import { setCodeWorkingDir } from '$lib/stores/code.svelte';

	let codeAutoApprove = $state(getSettings().codeAutoApprove);
	let codeDefaultWorkingDir = $state(getSettings().codeDefaultWorkingDir);
	let codeRunCommandTimeoutSecs = $state(getSettings().codeRunCommandTimeoutSecs);

	function persistAutoApprove() {
		updateSettings({ codeAutoApprove });
	}

	function persistTimeout() {
		const clamped = Math.max(5, Math.min(1800, Math.floor(codeRunCommandTimeoutSecs)));
		codeRunCommandTimeoutSecs = clamped;
		updateSettings({ codeRunCommandTimeoutSecs: clamped });
	}

	async function pickDefaultDir() {
		try {
			const selected = await open({
				directory: true,
				multiple: false,
				title: 'Select default project directory'
			});
			if (typeof selected === 'string') {
				codeDefaultWorkingDir = selected;
				// Route through the Code store so the open tab updates too.
				setCodeWorkingDir(selected);
			}
		} catch (e) {
			console.error('Failed to pick directory:', e);
		}
	}

	function clearDefaultDir() {
		codeDefaultWorkingDir = '';
		setCodeWorkingDir(null);
	}
</script>

<section class="card">
	<h3>Default project directory</h3>
	<p class="help">
		The folder the Code tab opens in. The agent reads, edits, and runs commands here; it cannot
		escape this directory for file tools.
	</p>
	<div class="dir-row">
		<input type="text" readonly placeholder="(none chosen yet)" value={codeDefaultWorkingDir} />
		<button onclick={pickDefaultDir}>Choose…</button>
		{#if codeDefaultWorkingDir}
			<button class="secondary" onclick={clearDefaultDir}>Clear</button>
		{/if}
	</div>
</section>

<section class="card">
	<h3>run_command timeout</h3>
	<p class="help">
		Default wall-clock limit for a single <code>run_command</code> call (the model can override per call).
		5–1800 seconds.
	</p>
	<input
		type="number"
		min="5"
		max="1800"
		step="5"
		bind:value={codeRunCommandTimeoutSecs}
		onblur={persistTimeout}
		onkeydown={(e) => e.key === 'Enter' && persistTimeout()}
	/>
</section>

<section class="card danger" class:enabled={codeAutoApprove}>
	<h3>Auto-approve commands</h3>
	<label class="row">
		<input type="checkbox" bind:checked={codeAutoApprove} onchange={persistAutoApprove} />
		<span>
			Run risk-flagged commands without prompting. Off by default — when off, the Code tab pops a
			confirmation before running anything the risk classifier flags (sudo, destructive deletes,
			pipes to a shell, etc.). Only enable if you fully trust the model on this machine.
		</span>
	</label>
</section>

<style>
	.card {
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 14px 16px;
		margin-bottom: 16px;
	}

	.card h3 {
		margin: 0 0 6px 0;
		font-size: 0.95rem;
	}

	.help {
		font-size: 0.82rem;
		color: var(--text-secondary);
		margin: 0 0 10px 0;
		line-height: 1.45;
	}

	.dir-row {
		display: flex;
		gap: 8px;
		align-items: center;
	}

	.dir-row input {
		flex: 1;
		min-width: 0;
	}

	input[type='text'],
	input[type='number'] {
		padding: 8px 10px;
		border: 1px solid var(--border);
		border-radius: 6px;
		font-size: 0.9rem;
		background-color: var(--bg-primary);
		color: var(--text-primary);
		color-scheme: light dark;
	}

	button {
		padding: 8px 14px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-secondary);
		color: var(--text-primary);
		font-size: 0.85rem;
		cursor: pointer;
		white-space: nowrap;
	}

	button.secondary {
		color: var(--text-secondary);
	}

	.row {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		cursor: pointer;
	}

	.row span {
		font-size: 0.85rem;
		line-height: 1.45;
		color: var(--text-secondary);
	}

	.card.danger {
		border-color: color-mix(in srgb, var(--error-text, #c0392b) 35%, var(--border));
	}

	.card.danger.enabled {
		background: color-mix(in srgb, var(--error-text, #c0392b) 7%, transparent);
	}

	code {
		background: var(--bg-secondary);
		padding: 1px 5px;
		border-radius: 3px;
		font-size: 0.8rem;
	}
</style>
