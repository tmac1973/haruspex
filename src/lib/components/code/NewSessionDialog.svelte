<script lang="ts">
	/**
	 * Pick the folder a new Code session works in. It is fixed for the
	 * session's life. Defaults to the last folder used (`codeLastRoot`).
	 */
	import Modal from '#lib/components/Modal.svelte';
	import WorkingDirButton from '#lib/components/WorkingDirButton.svelte';
	import { newSession } from '#lib/stores/code.svelte.ts';
	import { getSettings, updateSettings } from '#lib/stores/settings.ts';
	import { errMessage } from '#lib/utils/error.ts';

	let { open, onclose }: { open: boolean; onclose: () => void } = $props();

	let root = $state('');
	let starting = $state(false);
	let error = $state<string | null>(null);

	// Each time it opens, start from the last folder used.
	$effect(() => {
		if (open) {
			root = getSettings().codeLastRoot;
			error = null;
		}
	});

	async function start() {
		if (!root || starting) return;
		starting = true;
		error = null;
		try {
			const session = await newSession(root);
			updateSettings({ codeLastRoot: session.root });
			onclose();
		} catch (e) {
			error = errMessage(e);
		} finally {
			starting = false;
		}
	}
</script>

<Modal {open} maxWidth={460} title="New session" dismissable {onclose}>
	<p class="help">Pick the project folder. The session works in it and can't leave it.</p>
	<div class="folder-row">
		<WorkingDirButton
			workingDir={root || null}
			onPick={(dir) => (root = dir)}
			onClear={() => (root = '')}
		/>
		{#if root}
			<code class="path" title={root}>{root}</code>
		{/if}
	</div>
	{#if error}
		<p class="error">{error}</p>
	{/if}
	<div class="actions">
		<button class="btn" onclick={onclose}>Cancel</button>
		<button class="btn btn-primary" disabled={!root || starting} onclick={start}
			>{starting ? 'Starting…' : 'Start session'}</button
		>
	</div>
</Modal>

<style>
	.help {
		margin: 0 0 12px;
		font-size: 0.85rem;
		color: var(--text-secondary);
	}

	.folder-row {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}

	.path {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.78rem;
		color: var(--text-secondary);
	}

	.error {
		margin: 10px 0 0;
		font-size: 0.8rem;
		color: var(--error-text);
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 16px;
	}
</style>
