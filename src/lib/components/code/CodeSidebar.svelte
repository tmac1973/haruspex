<script lang="ts">
	/**
	 * Saved Code sessions, grouped by folder, newest first. Click opens one as
	 * a sub-tab; right-click renames or deletes it.
	 */
	import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
	import { deleteCodeSession, listCodeSessions, updateCodeSessionMeta } from '#lib/code/db.ts';
	import type { CodeSessionSummary } from '#lib/code/db.ts';
	import { groupByRoot } from '#lib/code/sessionList.ts';
	import {
		closeSession,
		getActiveSessionId,
		getOpenSessions,
		openSession
	} from '#lib/stores/code.svelte.ts';
	import { getSettings, updateSettings } from '#lib/stores/settings.ts';
	import { showToast } from '#lib/stores/toasts.svelte.ts';
	import { errMessage } from '#lib/utils/error.ts';
	import { tick } from 'svelte';

	let { onNew }: { onNew: () => void } = $props();

	let list = $state<CodeSessionSummary[]>([]);
	let loadError = $state<string | null>(null);
	const groups = $derived(groupByRoot(list));
	const activeId = $derived(getActiveSessionId());
	const openIds = $derived(new Set(getOpenSessions().map((s) => s.id)));
	let collapsedRoots = $state<Record<string, boolean>>({});

	let open = $state(getSettings().codeSidebarOpen);
	const MIN_WIDTH = 180;
	const MAX_WIDTH = 480;
	let width = $state(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, getSettings().codeSidebarWidth)));

	export async function refresh(): Promise<void> {
		try {
			list = await listCodeSessions();
			loadError = null;
		} catch (e) {
			loadError = errMessage(e);
		}
	}

	// Reload when an open session is created, renamed, or finishes a turn
	// (which moves it to the top).
	const openSignature = $derived(
		getOpenSessions()
			.map((s) => `${s.id}:${s.title}:${s.status}`)
			.join('|')
	);
	$effect(() => {
		void openSignature;
		void refresh();
	});

	function toggleOpen() {
		open = !open;
		updateSettings({ codeSidebarOpen: open });
	}

	function startResize(event: MouseEvent) {
		event.preventDefault();
		const startX = event.clientX;
		const startWidth = width;
		document.body.style.cursor = 'col-resize';
		document.body.style.userSelect = 'none';
		function onMove(e: MouseEvent) {
			width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startWidth + e.clientX - startX));
		}
		function onUp() {
			window.removeEventListener('mousemove', onMove);
			window.removeEventListener('mouseup', onUp);
			document.body.style.cursor = '';
			document.body.style.userSelect = '';
			updateSettings({ codeSidebarWidth: width });
		}
		window.addEventListener('mousemove', onMove);
		window.addEventListener('mouseup', onUp);
	}

	async function openOne(id: string) {
		try {
			await openSession(id);
		} catch (e) {
			showToast(`Couldn't open that session: ${errMessage(e)}`, { kind: 'error' });
		}
	}

	// Right-click menu, rename and delete.
	let menu = $state<{ x: number; y: number; session: CodeSessionSummary } | null>(null);
	let renamingId = $state<string | null>(null);
	let renameText = $state('');
	let renameInput = $state<HTMLInputElement | null>(null);
	let deleting = $state<CodeSessionSummary | null>(null);

	function openMenu(e: MouseEvent, session: CodeSessionSummary) {
		e.preventDefault();
		menu = { x: e.clientX, y: e.clientY, session };
	}

	async function startRename(session: CodeSessionSummary) {
		menu = null;
		renamingId = session.id;
		renameText = session.title;
		await tick();
		renameInput?.select();
	}

	async function commitRename() {
		const id = renamingId;
		renamingId = null;
		const title = renameText.trim();
		const session = list.find((s) => s.id === id);
		if (!id || !session || !title || title === session.title) return;
		try {
			const live = getOpenSessions().find((s) => s.id === id);
			if (live) await live.rename(title);
			else await updateCodeSessionMeta(id, { title });
			await refresh();
		} catch (e) {
			showToast(`Couldn't rename: ${errMessage(e)}`, { kind: 'error' });
		}
	}

	async function confirmDelete() {
		const session = deleting;
		deleting = null;
		if (!session) return;
		try {
			await closeSession(session.id);
			await deleteCodeSession(session.id);
			await refresh();
		} catch (e) {
			showToast(`Couldn't delete: ${errMessage(e)}`, { kind: 'error' });
		}
	}

	function label(s: CodeSessionSummary): string {
		return s.title || 'New session';
	}
</script>

<svelte:window
	onclick={() => (menu = null)}
	onkeydown={(e) => {
		if (e.key === 'Escape') menu = null;
	}}
/>

{#if open}
	<aside class="sidebar" style="width: {width}px" aria-label="Code sessions">
		<header>
			<button class="new" onclick={onNew} title="Start a session in a folder">New session</button>
			<button class="collapse" onclick={toggleOpen} title="Hide sessions" aria-label="Hide sessions"
				>‹</button
			>
		</header>
		<div class="list">
			{#if loadError}
				<p class="empty">Couldn't load sessions: {loadError}</p>
			{:else if groups.length === 0}
				<p class="empty">No sessions yet.</p>
			{/if}
			{#each groups as group (group.root)}
				<div class="group">
					<button
						class="folder"
						title={group.root}
						aria-expanded={!collapsedRoots[group.root]}
						onclick={() => (collapsedRoots[group.root] = !collapsedRoots[group.root])}
					>
						<span class="chev">{collapsedRoots[group.root] ? '▸' : '▾'}</span>
						<span class="folder-name">{group.name}</span>
					</button>
					{#if !collapsedRoots[group.root]}
						<ul>
							{#each group.sessions as s (s.id)}
								<li>
									{#if renamingId === s.id}
										<input
											class="rename"
											bind:this={renameInput}
											bind:value={renameText}
											aria-label="Session name"
											onblur={commitRename}
											onkeydown={(e) => {
												if (e.key === 'Enter') commitRename();
												if (e.key === 'Escape') renamingId = null;
											}}
										/>
									{:else}
										<button
											class="session"
											class:active={s.id === activeId}
											class:open={openIds.has(s.id)}
											title="{label(s)} — right-click to rename or delete"
											onclick={() => openOne(s.id)}
											oncontextmenu={(e) => openMenu(e, s)}>{label(s)}</button
										>
									{/if}
								</li>
							{/each}
						</ul>
					{/if}
				</div>
			{/each}
		</div>
		<button
			class="resize-handle"
			onmousedown={startResize}
			aria-label="Drag to resize"
			title="Drag to resize"
		></button>
	</aside>
{:else}
	<button class="rail" onclick={toggleOpen} title="Show sessions" aria-label="Show sessions">
		<span class="rail-glyph">›</span>
		<span class="rail-label">Sessions</span>
	</button>
{/if}

{#if menu}
	<div class="menu" role="menu" style="left: {menu.x}px; top: {menu.y}px">
		<button role="menuitem" onclick={() => menu && startRename(menu.session)}>Rename</button>
		<button
			role="menuitem"
			class="danger"
			onclick={() => {
				deleting = menu?.session ?? null;
				menu = null;
			}}>Delete</button
		>
	</div>
{/if}

<ConfirmDialog
	open={deleting !== null}
	title="Delete session?"
	message={deleting
		? `"${label(deleting)}" and its conversation will be deleted. Files in the folder stay.`
		: ''}
	confirmLabel="Delete"
	destructive
	onconfirm={confirmDelete}
	oncancel={() => (deleting = null)}
/>

<style>
	.sidebar {
		position: relative;
		display: flex;
		flex-direction: column;
		flex-shrink: 0;
		min-height: 0;
		border-right: 1px solid var(--border);
		background: var(--bg-secondary);
	}

	header {
		display: flex;
		gap: 6px;
		padding: 8px;
		border-bottom: 1px solid var(--border);
	}

	/* Filled, so accent-contrast. */
	.new {
		flex: 1;
		appearance: none;
		background: var(--accent);
		color: var(--accent-contrast);
		border: 1px solid var(--accent);
		border-radius: 6px;
		padding: 6px 10px;
		font-size: 0.8rem;
		font-weight: 500;
		cursor: pointer;
	}

	.collapse {
		appearance: none;
		background: none;
		border: 1px solid var(--border);
		border-radius: 6px;
		color: var(--text-secondary);
		cursor: pointer;
		padding: 0 8px;
	}

	.collapse:hover {
		color: var(--text-primary);
	}

	.list {
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
		padding: 6px 4px 12px;
	}

	.empty {
		color: var(--text-secondary);
		font-size: 0.8rem;
		padding: 8px;
		margin: 0;
	}

	.folder {
		display: flex;
		align-items: center;
		gap: 4px;
		width: 100%;
		appearance: none;
		background: none;
		border: 0;
		padding: 6px 6px 4px;
		color: var(--text-secondary);
		font-size: 0.72rem;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		cursor: pointer;
		text-align: left;
	}

	.folder:hover {
		color: var(--text-primary);
	}

	.chev {
		font-size: 0.65rem;
		width: 10px;
	}

	.folder-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.session {
		display: block;
		width: 100%;
		appearance: none;
		background: none;
		border: 0;
		border-left: 2px solid transparent;
		border-radius: 0 4px 4px 0;
		padding: 5px 8px 5px 18px;
		font-size: 0.8rem;
		color: var(--text-secondary);
		text-align: left;
		cursor: pointer;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.session:hover {
		background: var(--bg-primary);
		color: var(--text-primary);
	}

	.session.open {
		color: var(--text-primary);
	}

	.session.active {
		background: var(--accent-soft);
		border-left-color: var(--accent);
		color: var(--text-primary);
	}

	.rename {
		width: calc(100% - 22px);
		margin: 2px 4px 2px 18px;
		padding: 3px 6px;
		font-size: 0.8rem;
		border: 1px solid var(--accent);
		border-radius: 4px;
		background: var(--bg-input);
		color: var(--text-primary);
		outline: none;
	}

	.resize-handle {
		position: absolute;
		right: -3px;
		top: 0;
		bottom: 0;
		width: 6px;
		background: transparent;
		border: 0;
		padding: 0;
		cursor: col-resize;
		z-index: 5;
	}

	.resize-handle:hover,
	.resize-handle:active {
		background: color-mix(in srgb, var(--accent) 40%, transparent);
	}

	.rail {
		appearance: none;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		padding: 12px 4px;
		width: 28px;
		flex-shrink: 0;
		border: 0;
		border-right: 1px solid var(--border);
		background: var(--bg-secondary);
		color: var(--text-secondary);
		cursor: pointer;
	}

	.rail:hover {
		color: var(--text-primary);
	}

	.rail-glyph {
		font-size: 1.2rem;
		line-height: 1;
	}

	.rail-label {
		writing-mode: vertical-rl;
		transform: rotate(180deg);
		font-size: 0.75rem;
		letter-spacing: 0.05em;
		text-transform: uppercase;
	}

	.menu {
		position: fixed;
		z-index: 1000;
		display: flex;
		flex-direction: column;
		min-width: 120px;
		padding: 4px;
		background: var(--bg-primary);
		border: 1px solid var(--border);
		border-radius: 6px;
		box-shadow: 0 6px 18px rgba(0, 0, 0, 0.25);
	}

	.menu button {
		appearance: none;
		background: none;
		border: 0;
		border-radius: 4px;
		padding: 6px 10px;
		text-align: left;
		font-size: 0.8rem;
		color: var(--text-primary);
		cursor: pointer;
	}

	.menu button:hover {
		background: var(--bg-secondary);
	}

	.menu button.danger {
		color: var(--error-text);
	}
</style>
