<script lang="ts">
	import { open } from '@tauri-apps/plugin-dialog';
	import { getWorkingDir, setWorkingDir } from '$lib/stores/chat.svelte';

	const workingDir = $derived(getWorkingDir());
	const displayName = $derived(
		workingDir ? workingDir.split(/[/\\]/).filter(Boolean).pop() || '/' : ''
	);

	async function pickDirectory() {
		try {
			const selected = await open({
				directory: true,
				multiple: false,
				title: 'Select working directory'
			});
			if (typeof selected === 'string') {
				setWorkingDir(selected);
			}
		} catch (e) {
			console.error('Failed to pick directory:', e);
		}
	}

	function clearDirectory(e: MouseEvent) {
		e.stopPropagation();
		setWorkingDir(null);
	}
</script>

<div class="workingdir-container">
	<button
		class="workingdir-btn"
		class:active={workingDir !== null}
		onclick={pickDirectory}
		title={workingDir
			? `Working directory: ${workingDir}\nClick to change`
			: 'Select a working directory to enable file tools'}
	>
		<svg
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
		>
			{#if workingDir}
				<path
					d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"
					fill="currentColor"
					fill-opacity="0.2"
				></path>
			{:else}
				<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"
				></path>
			{/if}
		</svg>
		{#if displayName}
			<span class="dir-label">{displayName}</span>
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<span class="clear-btn" onclick={clearDirectory} title="Clear working directory">×</span>
		{/if}
	</button>
</div>

<style>
	.workingdir-container {
		display: flex;
		align-items: center;
		flex-shrink: 0;
	}

	.workingdir-btn {
		height: 40px;
		padding: 0 12px;
		border-radius: 20px;
		border: 1px solid var(--border);
		background: var(--bg-secondary);
		color: var(--text-secondary);
		cursor: pointer;
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 0.8rem;
		transition: all 0.15s;
		max-width: 180px;
	}

	.workingdir-btn:hover {
		color: var(--text-primary);
		border-color: var(--text-secondary);
	}

	.workingdir-btn.active {
		background: color-mix(in srgb, var(--accent) 15%, transparent);
		border-color: var(--accent);
		color: var(--accent);
	}

	.dir-label {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		font-weight: 500;
		max-width: 100px;
	}

	.clear-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		font-size: 1rem;
		line-height: 1;
		color: var(--text-secondary);
		margin-left: 2px;
	}

	.clear-btn:hover {
		background: color-mix(in srgb, var(--accent) 25%, transparent);
		color: var(--text-primary);
	}
</style>
