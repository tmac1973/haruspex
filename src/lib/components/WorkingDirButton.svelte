<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { open } from '@tauri-apps/plugin-dialog';
	import { getWorkingDir, setWorkingDir } from '#lib/stores/chat.svelte.ts';

	interface Props {
		/** Directory source. Omit to use the Chat tab's working-dir store. */
		workingDir?: string | null;
		/** Called with the chosen directory. Omit to use the Chat store setter. */
		onPick?: (dir: string) => void;
		/** Called when the user clears the directory. Omit to use the Chat store. */
		onClear?: () => void;
	}
	let { workingDir: workingDirProp, onPick, onClear }: Props = $props();

	// Default to the Chat store when no override props are supplied, so the
	// existing `<WorkingDirButton />` usage in ChatView is unchanged.
	const workingDir = $derived(workingDirProp !== undefined ? workingDirProp : getWorkingDir());
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
				if (onPick) onPick(selected);
				else setWorkingDir(selected);
			}
		} catch (e) {
			console.error('Failed to pick directory:', e);
		}
	}

	function clearDirectory(e: MouseEvent) {
		e.stopPropagation();
		if (onClear) onClear();
		else setWorkingDir(null);
	}

	// Right-click menu, in place of the webview's own (which offers only
	// "Inspect Element").
	let menu = $state<{ x: number; y: number } | null>(null);

	function openMenu(e: MouseEvent) {
		e.preventDefault();
		menu = { x: e.clientX, y: e.clientY };
	}

	function closeMenu() {
		menu = null;
	}

	async function openInFileManager() {
		closeMenu();
		if (!workingDir) return;
		try {
			await invoke('open_folder', { path: workingDir });
		} catch (e) {
			console.error('Failed to open folder:', e);
		}
	}

	function onMenuPick(action: () => void) {
		closeMenu();
		action();
	}
</script>

<svelte:window
	onclick={closeMenu}
	onkeydown={(e) => e.key === 'Escape' && closeMenu()}
	onblur={closeMenu}
/>

<div class="workingdir-container">
	<button
		class="workingdir-btn"
		class:active={workingDir !== null}
		onclick={pickDirectory}
		oncontextmenu={openMenu}
		title={workingDir
			? `Working directory: ${workingDir}\nClick to change, right-click for more`
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
	{#if menu}
		<div class="context-menu" style="left: {menu.x}px; top: {menu.y}px" role="menu">
			<button role="menuitem" onclick={openInFileManager} disabled={!workingDir}>
				Open in file manager
			</button>
			<button role="menuitem" onclick={() => onMenuPick(pickDirectory)}>
				{workingDir ? 'Change folder…' : 'Choose folder…'}
			</button>
			{#if workingDir}
				<button role="menuitem" onclick={(e) => onMenuPick(() => clearDirectory(e))}>
					Clear
				</button>
			{/if}
		</div>
	{/if}
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

	.context-menu {
		position: fixed;
		background: var(--bg-primary);
		border: 1px solid var(--border);
		border-radius: 4px;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
		z-index: 100;
		min-width: 170px;
		padding: 4px 0;
	}

	.context-menu button {
		appearance: none;
		background: none;
		border: 0;
		color: var(--text-primary);
		padding: 6px 14px;
		font-size: 0.8rem;
		width: 100%;
		text-align: left;
		cursor: pointer;
	}

	.context-menu button:hover:not(:disabled) {
		background: var(--bg-secondary);
	}

	.context-menu button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
