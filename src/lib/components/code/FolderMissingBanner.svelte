<script lang="ts">
	/**
	 * Shown over a session whose folder is gone (deleted, a worktree removed,
	 * a drive unmounted). The session can still be read; it can be deleted,
	 * or pointed at another folder. Never offers to make the folder again: an
	 * empty folder at the old path would only hide what happened.
	 */
	import { open as openDialog } from '@tauri-apps/plugin-dialog';
	import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
	import { deleteSession, type CodeSession } from '#lib/stores/code.svelte.ts';
	import { showToast } from '#lib/stores/toasts.svelte.ts';
	import { errMessage } from '#lib/utils/error.ts';

	let {
		session,
		ondeleted
	}: {
		session: CodeSession;
		/** After the session is deleted (a detached window closes itself). */
		ondeleted?: () => void;
	} = $props();

	let picked = $state<string | null>(null);
	let deleting = $state(false);

	async function choose(): Promise<void> {
		try {
			const dir = await openDialog({ directory: true, multiple: false, title: 'Choose folder' });
			if (typeof dir === 'string') picked = dir;
		} catch (e) {
			showToast(`Couldn't open the folder picker: ${errMessage(e)}`, { kind: 'error' });
		}
	}

	async function move(): Promise<void> {
		const dir = picked;
		picked = null;
		if (!dir) return;
		try {
			await session.moveTo(dir);
		} catch (e) {
			showToast(`Couldn't use that folder: ${errMessage(e)}`, { kind: 'error' });
		}
	}

	async function remove(): Promise<void> {
		deleting = false;
		try {
			if (await deleteSession(session.id)) ondeleted?.();
		} catch (e) {
			showToast(`Couldn't delete: ${errMessage(e)}`, { kind: 'error' });
		}
	}
</script>

<div class="banner" role="alert">
	<span class="text"
		>Folder not found: <code title="It was deleted, moved, or is on a drive that isn't mounted."
			>{session.root}</code
		></span
	>
	<span class="actions">
		<button
			class="btn"
			disabled={session.busy}
			title="Point this session at another folder; its conversation stays"
			onclick={() => void choose()}>Choose folder…</button
		>
		<button class="btn danger" disabled={session.busy} onclick={() => (deleting = true)}
			>Delete session</button
		>
	</span>
</div>

<ConfirmDialog
	open={picked !== null}
	title="Use this folder?"
	message={picked
		? `The session will work in ${picked} from now on. Paths in its conversation still name the old folder.`
		: ''}
	confirmLabel="Use folder"
	destructive={false}
	onconfirm={() => void move()}
	oncancel={() => (picked = null)}
/>

<ConfirmDialog
	open={deleting}
	title="Delete session?"
	message="Its conversation will be deleted."
	confirmLabel="Delete"
	destructive
	onconfirm={() => void remove()}
	oncancel={() => (deleting = false)}
/>

<style>
	.banner {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 6px 12px;
		padding: 8px 12px;
		border-bottom: 1px solid var(--border);
		background: color-mix(in srgb, var(--error-text) 10%, var(--bg-primary));
		color: var(--text-primary);
		font-size: 0.85rem;
		flex-shrink: 0;
	}

	.text {
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.actions {
		display: flex;
		gap: 6px;
		flex-shrink: 0;
	}

	.btn {
		appearance: none;
		padding: 4px 10px;
		font-size: 0.8rem;
		border-radius: 6px;
		border: 1px solid var(--border-strong);
		background: var(--bg-primary);
		color: var(--text-primary);
		cursor: pointer;
	}

	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.btn.danger {
		color: var(--error-text);
	}
</style>
