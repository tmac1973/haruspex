<script lang="ts">
	/**
	 * A detached Code session: one session's pane in a window of its own,
	 * without the sidebar or sub-tabs (see `#lib/code/windows.ts`). The root
	 * layout treats it as detached: no app bootstrap, no MCP servers, no
	 * header; the server status badge stays in the main window, and the
	 * session header names the model.
	 *
	 * The window claims the session when it opens it. Another window already
	 * having it means that one is brought forward and this one closes.
	 */
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { getCurrentWindow } from '@tauri-apps/api/window';
	import CodePane from '#lib/components/code/CodePane.svelte';
	import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
	import { useShellRelay } from '#lib/code/shellBridge.ts';
	import { createShellRelay } from '#lib/code/shellRelay.ts';
	import {
		codeWindowTitle,
		markDetachedCodeWindow,
		moveBlockedReason,
		reattachToMain,
		tauriBus
	} from '#lib/code/windows.ts';
	import { closeSession, openSession, type CodeSession } from '#lib/stores/code.svelte.ts';
	import {
		SETTINGS_KEY,
		applyAccent,
		applyTheme,
		reloadSettingsFromStorage
	} from '#lib/stores/settings.ts';
	import { showToast } from '#lib/stores/toasts.svelte.ts';
	import { errMessage } from '#lib/utils/error.ts';

	const id = page.params.id ?? '';
	const win = getCurrentWindow();

	// Forks go to the main window, and so does open_in_shell: the Shell tabs
	// are there.
	markDetachedCodeWindow();
	useShellRelay(createShellRelay(tauriBus, win.label));

	let session = $state<CodeSession | null>(null);
	let loadError = $state<string | null>(null);
	let confirming = $state(false);
	let closing = false;

	const blocked = $derived(session ? moveBlockedReason(session) : null);

	$effect(() => {
		if (session) void win.setTitle(codeWindowTitle(session)).catch(() => {});
	});

	async function raise(): Promise<void> {
		await win.unminimize().catch(() => {});
		await win.setFocus().catch(() => {});
	}

	/** Like closing the sub-tab: stops the turn and background processes. */
	async function closeNow(): Promise<void> {
		if (closing) return;
		closing = true;
		if (session) await closeSession(session.id);
		await win.destroy();
	}

	function requestClose(): void {
		if (closing) return;
		if (session?.background.some((p) => p.running)) {
			confirming = true;
			void raise();
		} else {
			void closeNow();
		}
	}

	async function reattach(): Promise<void> {
		if (!session || closing || blocked) return;
		closing = true;
		try {
			if (!(await reattachToMain(session))) closing = false;
		} catch (e) {
			closing = false;
			showToast(`Couldn't move it back: ${errMessage(e)}`, { kind: 'error' });
		}
	}

	/** Each window loads the settings once; follow the main window's changes. */
	function onStorage(e: StorageEvent): void {
		if (e.key !== SETTINGS_KEY) return;
		reloadSettingsFromStorage();
		applyTheme();
		applyAccent();
	}

	onMount(() => {
		void (async () => {
			try {
				const opened = await openSession(id);
				if (!opened) {
					// Another window has it and is in front now.
					closing = true;
					await win.destroy();
					return;
				}
				session = opened;
			} catch (e) {
				loadError = errMessage(e);
			}
		})();
		const stop = win.onCloseRequested((e) => {
			if (closing) return;
			e.preventDefault();
			requestClose();
		});
		return () => void stop.then((f) => f());
	});
</script>

<svelte:window onstorage={onStorage} />

<div class="detached">
	<div class="bar">
		<span class="title">{session ? codeWindowTitle(session) : 'Code session'}</span>
		<button
			class="reattach"
			class:blocked={!!blocked}
			aria-disabled={!session || !!blocked}
			title={blocked ?? 'Move back into the main window, as a Code sub-tab'}
			onclick={() => void reattach()}
		>
			⇤ Re-attach
		</button>
	</div>
	<div class="pane">
		{#if session}
			<CodePane {session} />
		{:else if loadError}
			<p class="error">Couldn't open this session: {loadError}</p>
		{/if}
	</div>
</div>

<ConfirmDialog
	open={confirming}
	title="Close session?"
	message="Closing it stops its background processes."
	confirmLabel="Close and stop"
	destructive
	onconfirm={() => {
		confirming = false;
		void closeNow();
	}}
	oncancel={() => (confirming = false)}
/>

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
		background: var(--bg-secondary);
		border-bottom: 1px solid var(--border);
		flex: 0 0 auto;
	}

	.title {
		font-size: 0.8rem;
		color: var(--text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
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
		flex-shrink: 0;
	}

	.reattach:hover {
		background: var(--bg-primary);
	}

	.reattach.blocked {
		opacity: 0.5;
		cursor: default;
	}

	.pane {
		display: flex;
		flex: 1 1 auto;
		min-height: 0;
		overflow: hidden;
	}

	.error {
		margin: 24px;
		color: var(--error-text);
		font-size: 0.85rem;
	}
</style>
