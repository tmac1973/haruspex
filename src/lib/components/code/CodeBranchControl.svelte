<script lang="ts">
	/**
	 * The session folder's git branch, with ● when it has uncommitted work. The
	 * dropdown switches to another local branch (only while the session is idle
	 * and the tree is clean: git's rule, nothing is stashed) or creates one from
	 * HEAD. It warns first when another open session, in any window, works in
	 * the same repository, since a switch changes its files too.
	 *
	 * Refreshed after each turn (the store) and when the window gains focus.
	 */
	import { onMount, tick } from 'svelte';
	import BranchGlyph from './BranchGlyph.svelte';
	import {
		branchLabel,
		gitBranches,
		gitCreateBranch,
		gitSwitch,
		isDirty,
		switchBlockedReason
	} from '#lib/code/git.ts';
	import { openSessionsSharing } from '#lib/code/folders.ts';
	import { sessionLabel } from '#lib/code/sessionList.ts';
	import { getOpenSessions, type CodeSession } from '#lib/stores/code.svelte.ts';
	import { showToast } from '#lib/stores/toasts.svelte.ts';
	import { errMessage } from '#lib/utils/error.ts';

	let { session }: { session: CodeSession } = $props();

	const git = $derived(session.git);
	const blocked = $derived(git ? switchBlockedReason(git, session.busy) : null);

	let open = $state(false);
	let branches = $state<string[]>([]);
	let sharing = $state<string[]>([]);
	let creating = $state(false);
	/** The branch the new one starts from; null is the current commit. */
	let createFrom = $state<string | null>(null);
	/** "Branch from main", offered when the default branch isn't checked out. */
	const fromDefault = $derived(
		git?.default_branch && git.default_branch !== git.branch ? git.default_branch : null
	);
	let newName = $state('');
	let working = $state(false);
	let nameInput = $state<HTMLInputElement | null>(null);
	let root = $state<HTMLDivElement | null>(null);

	onMount(() => {
		void session.refreshGit();
		const onFocus = () => void session.refreshGit();
		window.addEventListener('focus', onFocus);
		return () => window.removeEventListener('focus', onFocus);
	});

	const title = $derived.by(() => {
		if (!git) return '';
		const parts = [git.repo_root];
		if (git.changed) parts.push(`${git.changed} changed`);
		if (git.untracked) parts.push(`${git.untracked} untracked`);
		if (!git.branch) parts.push('detached HEAD');
		return parts.join(' · ');
	});

	async function toggle() {
		if (open) {
			close();
			return;
		}
		open = true;
		creating = false;
		newName = '';
		await session.refreshGit();
		const folder = session.git?.repo_root ?? session.root;
		const [names, others] = await Promise.all([
			gitBranches(session.root).catch(() => [] as string[]),
			openSessionsSharing(
				session.id,
				folder,
				getOpenSessions().map((s) => s.id)
			)
		]);
		branches = names;
		sharing = others.map(sessionLabel);
	}

	function close() {
		open = false;
		creating = false;
	}

	async function run(action: () => Promise<void>, failure: string) {
		if (working) return;
		working = true;
		try {
			await action();
			close();
		} catch (e) {
			showToast(`${failure}: ${errMessage(e)}`, { kind: 'error' });
		} finally {
			working = false;
			await session.refreshGit();
		}
	}

	function switchTo(branch: string) {
		if (blocked || branch === git?.branch) return;
		void run(() => gitSwitch(session.root, branch), `Couldn't switch to ${branch}`);
	}

	async function startCreate(from: string | null) {
		createFrom = from;
		creating = true;
		await tick();
		nameInput?.focus();
	}

	function create() {
		const name = newName.trim();
		if (!name || session.busy) return;
		const from = createFrom ?? undefined;
		void run(() => gitCreateBranch(session.root, name, from), `Couldn't create ${name}`);
	}

	function onWindowClick(e: MouseEvent) {
		// The path as it was when the click started: "New branch…" swaps itself
		// for the name form, so by the time the click reaches the window its
		// target is no longer inside the menu and `contains` would close it.
		if (open && root && !e.composedPath().includes(root)) close();
	}

	function onKey(e: KeyboardEvent) {
		if (open && e.key === 'Escape') close();
	}
</script>

<svelte:window onclick={onWindowClick} onkeydown={onKey} />

{#if git}
	<div class="branch-control" bind:this={root}>
		<button
			class="branch"
			{title}
			aria-haspopup="menu"
			aria-expanded={open}
			aria-label="Branch {branchLabel(git)}{isDirty(git) ? ', uncommitted changes' : ''}"
			onclick={toggle}
		>
			<BranchGlyph size={12} />
			<span class="name">{branchLabel(git)}</span>
			{#if isDirty(git)}<span class="dirty" data-testid="dirty-marker">●</span>{/if}
		</button>
		{#if open}
			<div class="menu" role="menu" data-testid="branch-menu">
				{#if sharing.length > 0}
					<p class="warn" role="note">
						Also open here: {sharing.join(', ')}. A switch changes its files too.
					</p>
				{/if}
				{#if blocked}
					<p class="blocked">{blocked}</p>
				{/if}
				{#each branches as name (name)}
					<button
						role="menuitem"
						class:current={name === git.branch}
						disabled={!!blocked || working || name === git.branch}
						title={name === git.branch ? 'Checked out' : (blocked ?? `Switch to ${name}`)}
						onclick={() => switchTo(name)}
						><span class="check" aria-hidden="true">{name === git.branch ? '✓' : ''}</span
						>{name}</button
					>
				{/each}
				<div class="sep"></div>
				{#if creating}
					<form
						class="create"
						onsubmit={(e) => {
							e.preventDefault();
							create();
						}}
					>
						<span class="from">From {createFrom ?? (git.branch ? git.branch : 'this commit')}</span>
						<input
							bind:this={nameInput}
							bind:value={newName}
							placeholder="branch-name"
							aria-label="New branch name"
						/>
						<button type="submit" disabled={!newName.trim() || working || session.busy}
							>Create</button
						>
					</form>
				{:else}
					<button
						role="menuitem"
						disabled={session.busy || working}
						title={session.busy
							? 'Wait for the turn to finish.'
							: 'Create a branch at the current commit and switch to it. Uncommitted changes come along.'}
						onclick={() => startCreate(null)}
						><span class="check" aria-hidden="true"></span>Branch from current…</button
					>
					{#if fromDefault}
						<button
							role="menuitem"
							disabled={session.busy || working}
							title={session.busy
								? 'Wait for the turn to finish.'
								: `Create a branch at the tip of ${fromDefault} and switch to it. Uncommitted changes come along if git allows it.`}
							onclick={() => startCreate(fromDefault)}
							><span class="check" aria-hidden="true"></span>Branch from {fromDefault}…</button
						>
					{/if}
				{/if}
			</div>
		{/if}
	</div>
{/if}

<style>
	.from {
		font-size: 0.75rem;
		color: var(--text-secondary);
		white-space: nowrap;
	}

	.branch-control {
		position: relative;
	}

	.branch {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		max-width: 220px;
		padding: 3px 7px;
		font-size: 0.76rem;
		border: 1px solid transparent;
		border-radius: 6px;
		background: none;
		color: var(--text-secondary);
		cursor: pointer;
	}

	.branch:hover {
		border-color: var(--border);
		background: var(--bg-secondary);
		color: var(--text-primary);
	}

	.name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-mono, monospace);
	}

	.dirty {
		color: var(--warning, #d9a400);
		font-size: 0.7rem;
	}

	.menu {
		position: absolute;
		top: calc(100% + 4px);
		left: 0;
		z-index: 30;
		min-width: 220px;
		max-width: 320px;
		max-height: 340px;
		overflow-y: auto;
		padding: 4px;
		border: 1px solid var(--border-strong);
		border-radius: 8px;
		background: var(--bg-primary);
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
	}

	.menu button[role='menuitem'] {
		display: flex;
		align-items: center;
		width: 100%;
		padding: 5px 8px;
		border: none;
		border-radius: 5px;
		background: none;
		color: var(--text-primary);
		font-size: 0.78rem;
		text-align: left;
		cursor: pointer;
	}

	.menu button[role='menuitem']:hover:not(:disabled) {
		background: var(--bg-secondary);
	}

	.menu button:disabled {
		cursor: default;
		opacity: 0.6;
	}

	.menu button.current {
		opacity: 1;
		font-weight: 600;
	}

	.check {
		display: inline-block;
		width: 16px;
		flex: none;
		color: var(--accent);
	}

	.warn,
	.blocked {
		margin: 4px 6px 6px;
		font-size: 0.74rem;
		line-height: 1.4;
		color: var(--text-secondary);
	}

	.warn {
		color: var(--warning, #d9a400);
	}

	.sep {
		height: 1px;
		margin: 4px 0;
		background: var(--border);
	}

	.create {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		padding: 4px;
	}

	.create input {
		flex: 1;
		min-width: 0;
		padding: 3px 6px;
		font-size: 0.78rem;
		border: 1px solid var(--border-strong);
		border-radius: 5px;
		background: var(--bg-input);
		color: var(--text-primary);
	}

	.create button {
		padding: 3px 8px;
		font-size: 0.76rem;
		border: 1px solid var(--border-strong);
		border-radius: 5px;
		background: var(--bg-secondary);
		color: var(--text-primary);
		cursor: pointer;
	}
</style>
