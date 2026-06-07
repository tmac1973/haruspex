<script lang="ts">
	import { onMount } from 'svelte';
	import { getCurrentWindow } from '@tauri-apps/api/window';
	import { page } from '$app/state';
	import ShellPane from '$lib/components/shell/ShellPane.svelte';
	import { setActiveTab } from '$lib/stores/activeTab.svelte';
	import { reattachShellSession, getActiveShellSession } from '$lib/stores/shell.svelte';
	import { handBackToMain } from '$lib/shell/windows';

	// The route param is the live PTY session id this window adopts.
	const ptyId = Number(page.params.id);
	// Register the adopted shell in this window's own registry (each webview
	// has its own module state) so the layout's global hotkeys (F2/F3) resolve
	// it via getActiveShellSession(). reattach also re-hydrates the chat stash.
	setActiveTab('shell');
	const session = reattachShellSession(ptyId, 'Shell') ?? getActiveShellSession()!;
	session.setSidebarOpen(true);

	let closing = false;

	async function handBack() {
		if (closing) return;
		closing = true;
		await handBackToMain(ptyId, session.serializeChat(), session.name, session.serializeTerminal());
		await getCurrentWindow().destroy();
	}

	onMount(() => {
		// Enable the assistant's Paste/Run code-block buttons (gated on this
		// class) — this window is all shell, all the time.
		document.body.classList.add('shell-tab-active');

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
