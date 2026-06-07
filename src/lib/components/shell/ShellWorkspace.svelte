<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { onMount } from 'svelte';
	import ShellPane from './ShellPane.svelte';
	import ShellTabStrip from './ShellTabStrip.svelte';
	import { getActiveTab } from '$lib/stores/activeTab.svelte';
	import { getShellSessions, getActiveShellId, ensureShellSession } from '$lib/stores/shell.svelte';
	import { listenForReattach } from '$lib/shell/windows';
	import type { UnlistenFn } from '@tauri-apps/api/event';

	// Default to true so the placeholder doesn't flash on a supported platform
	// (Linux/macOS) during the round-trip; the backend flips it to false on
	// unsupported platforms (Windows, until Phase 17).
	let platformSupported = $state<boolean>(true);

	const sessions = $derived(getShellSessions());
	const activeId = $derived(getActiveShellId());

	// Make sure there's always at least one shell once the workspace mounts.
	ensureShellSession();

	onMount(() => {
		invoke<boolean>('shell_platform_supported')
			.then((ok) => (platformSupported = ok))
			.catch(() => (platformSupported = true));
		// Adopt shells handed back from detached windows (this is the main
		// window — ShellWorkspace only mounts here).
		let unlistenReattach: UnlistenFn | null = null;
		void listenForReattach().then((un) => (unlistenReattach = un));
		return () => {
			document.body.classList.remove('shell-tab-active');
			unlistenReattach?.();
		};
	});

	// Body class drives the Paste/Run markdown buttons (only meaningful on the
	// Shell tab). ShellWorkspace stays mounted across tab switches so the PTYs
	// survive, so track tab activation rather than mount lifecycle.
	$effect(() => {
		if (getActiveTab() === 'shell') {
			document.body.classList.add('shell-tab-active');
		} else {
			document.body.classList.remove('shell-tab-active');
		}
	});
</script>

<div class="workspace">
	{#if !platformSupported}
		<div class="platform-placeholder">
			<div class="platform-card">
				<h2>Shell tab — not yet on Windows</h2>
				<p>
					Haruspex's interactive terminal + AI sidebar ships on Linux and macOS. The PTY layer is
					cross-platform, but the OSC 133 capture scripts and the assistant's auto-attach context
					rely on bash/zsh — not <code>cmd.exe</code> or PowerShell.
				</p>
				<p>
					Windows support is the next stop: it needs new capture scripting for PowerShell or WSL
					bridging. The chat and jobs tabs work normally on every platform — switch to those for
					now.
				</p>
			</div>
		</div>
	{:else}
		<ShellTabStrip />
		<div class="panes">
			{#each sessions as session (session.id)}
				<!-- All panes stay mounted so background PTYs and in-flight turns
				     survive; only the active one is shown. -->
				<div class="pane-host" class:hidden={session.id !== activeId}>
					<ShellPane {session} attachSessionId={session.attachPtyId ?? undefined} />
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.workspace {
		display: flex;
		flex-direction: column;
		flex: 1 1 auto;
		min-height: 0;
		overflow: hidden;
	}

	.panes {
		position: relative;
		display: flex;
		flex: 1 1 auto;
		min-height: 0;
		overflow: hidden;
	}

	.pane-host {
		display: flex;
		flex: 1 1 auto;
		min-width: 0;
		min-height: 0;
		overflow: hidden;
	}

	.pane-host.hidden {
		display: none;
	}

	.platform-placeholder {
		flex: 1 1 auto;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 2rem;
		overflow: auto;
	}

	.platform-card {
		max-width: 560px;
		background: var(--bg-primary);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 1.5rem 1.75rem;
		color: var(--text-primary);
	}

	.platform-card h2 {
		margin: 0 0 0.75rem 0;
		font-size: 1.1rem;
	}

	.platform-card p {
		margin: 0.5rem 0;
		font-size: 0.9rem;
		line-height: 1.5;
		color: var(--text-secondary);
	}

	.platform-card code {
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.85em;
		padding: 0 0.25em;
		background: var(--bg-secondary, rgba(255, 255, 255, 0.05));
		border-radius: 3px;
	}
</style>
