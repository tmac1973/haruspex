<script lang="ts">
	import { onMount } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import { getCurrentWindow } from '@tauri-apps/api/window';
	import { page } from '$app/state';
	import ShellPane from '$lib/components/shell/ShellPane.svelte';
	import { ShellSession } from '$lib/stores/shell.svelte';
	import { handBackToMain } from '$lib/shell/windows';

	// The route param is the live PTY session id this window adopts.
	const ptyId = Number(page.params.id);
	// Standalone session (this window has its own module registry; we don't
	// route it through the registry — it's the only shell here).
	const session = new ShellSession(`detached-${ptyId}`, 'Shell');
	session.setSidebarOpen(true);

	let closing = false;

	async function handBack() {
		if (closing) return;
		closing = true;
		await handBackToMain(ptyId, session.serializeChat(), session.name);
		await getCurrentWindow().destroy();
	}

	onMount(() => {
		// Enable the assistant's Paste/Run code-block buttons (gated on this
		// class) — this window is all shell, all the time.
		document.body.classList.add('shell-tab-active');

		// Re-hydrate the chat thread stashed by the window we detached from.
		void invoke<string | null>('shell_take_chat', { sessionId: ptyId })
			.then((json) => session.hydrateChat(json))
			.catch(() => {});

		// Closing the window (X or Re-attach) hands the shell back to the main
		// window rather than killing the PTY.
		let unlisten: (() => void) | undefined;
		void getCurrentWindow()
			.onCloseRequested((e) => {
				if (closing) return;
				e.preventDefault();
				void handBack();
			})
			.then((u) => (unlisten = u));
		return () => unlisten?.();
	});
</script>

<div class="detached">
	<div class="bar">
		<span class="title">{session.name}</span>
		<button class="reattach" title="Move back into the main window" onclick={() => void handBack()}>
			⇤ Re-attach
		</button>
	</div>
	<div class="pane">
		<ShellPane {session} standalone attachSessionId={ptyId} />
	</div>
</div>

<style>
	.detached {
		display: flex;
		flex-direction: column;
		height: 100vh;
		overflow: hidden;
	}

	.bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 4px 8px;
		background: var(--bg-secondary, #181818);
		border-bottom: 1px solid var(--border);
		flex: 0 0 auto;
	}

	.title {
		font-size: 0.8rem;
		color: var(--text-secondary);
	}

	.reattach {
		appearance: none;
		background: none;
		border: 1px solid var(--border);
		color: var(--text-primary);
		font-size: 0.75rem;
		padding: 3px 8px;
		border-radius: 5px;
		cursor: pointer;
	}

	.reattach:hover {
		background: var(--bg-primary);
	}

	.pane {
		display: flex;
		flex: 1 1 auto;
		min-height: 0;
		overflow: hidden;
	}
</style>
