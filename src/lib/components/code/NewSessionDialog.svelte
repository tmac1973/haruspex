<script lang="ts">
	/**
	 * Pick the folder a new Code session works in. It is fixed for the
	 * session's life. Defaults to the last folder used (`codeLastRoot`).
	 *
	 * On Windows the folder is on This PC (`C:\…`, distro `''`) or inside a
	 * WSL2 distro: a distro and a Linux path, typed or browsed (Explorer's
	 * `\\wsl.localhost\<distro>\…` is split into the two by Rust).
	 *
	 * In a git repository the session can work in a new worktree instead, as
	 * a worktree fork does; the choice is remembered (`codeNewWorktree`).
	 */
	import { open as openDialog } from '@tauri-apps/plugin-dialog';
	import Modal from '#lib/components/Modal.svelte';
	import WorkingDirButton from '#lib/components/WorkingDirButton.svelte';
	import { resolveCodeFolder, wslDistros } from '#lib/code/db.ts';
	import { newSession } from '#lib/stores/code.svelte.ts';
	import { getSettings, updateSettings } from '#lib/stores/settings.ts';
	import { errMessage } from '#lib/utils/error.ts';
	import { wslShare } from '#lib/code/paths.ts';
	import { gitStatus } from '#lib/code/git.ts';
	import { startRemoteSession } from '#lib/peers/remoteCodeSession.svelte.ts';
	import { peerViews, recentRoots } from '#lib/peers/store.svelte.ts';

	let { open, onclose }: { open: boolean; onclose: () => void } = $props();

	const onWindows = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);

	let root = $state('');
	/** Windows: the distro `root` is in; `''` is This PC. */
	let distro = $state('');
	let distros = $state<string[]>([]);
	let starting = $state(false);
	let error = $state<string | null>(null);
	let worktree = $state(false);
	/** `root` is in a git repository, so it can have a worktree. */
	let inRepo = $state(false);

	/** Other computers a session can start on: connected, and not in lean mode. */
	const peers = $derived(peerViews().filter((p) => p.online && !p.client.lean));
	/** Where it runs: '' for this computer, else another's instance id. */
	let where = $state('');
	const peer = $derived(peers.find((p) => p.id === where) ?? null);
	let peerRoot = $state('');
	let peerWorktree = $state(false);
	/** That computer's WSL distros (Windows); '' is its own folders. */
	let peerDistros = $state<string[]>([]);
	let peerDistro = $state('');

	// A computer picked: its last folder to start from, and its distros.
	$effect(() => {
		const p = peer;
		peerDistros = [];
		peerDistro = '';
		if (!p) return;
		peerRoot = recentRoots(p)[0] ?? '';
		let current = true;
		void p.client
			.op<string[]>({ type: 'wsl.distros' })
			.then((list) => {
				if (current) peerDistros = list ?? [];
			})
			.catch(() => {});
		return () => {
			current = false;
		};
	});

	async function startThere(p: NonNullable<typeof peer>): Promise<void> {
		if (!peerRoot.trim() || starting) return;
		starting = true;
		error = null;
		try {
			await startRemoteSession(p, {
				root: peerRoot,
				worktree: peerWorktree,
				wslDistro: peerDistro || null
			});
			onclose();
		} catch (e) {
			error = errMessage(e);
		} finally {
			starting = false;
		}
	}

	// Each time it opens, start from the last folder used.
	$effect(() => {
		if (open) {
			const s = getSettings();
			root = s.codeLastRoot;
			distro = s.codeLastWslDistro;
			worktree = s.codeNewWorktree;
			error = null;
			if (onWindows) void loadDistros();
		}
	});

	// Whether the folder is in a repository; a typed path settles first.
	$effect(() => {
		const folder = root;
		const wsl = onWindows ? distro || null : null;
		inRepo = false;
		if (!open || !folder) return;
		let current = true;
		const timer = setTimeout(() => {
			void gitStatus(folder, wsl)
				.catch(() => null)
				.then((st) => {
					if (current) inRepo = st !== null;
				});
		}, 250);
		return () => {
			current = false;
			clearTimeout(timer);
		};
	});

	async function loadDistros(): Promise<void> {
		const list = await wslDistros();
		distros = list;
		// A distro since removed: back to This PC, without its Linux path.
		if (distro && !list.includes(distro)) {
			distro = '';
			root = '';
		}
	}

	/** Explorer, on the distro's share for one; a share pick is split into distro and path. */
	async function browse(): Promise<void> {
		error = null;
		try {
			const dir = await openDialog({
				directory: true,
				multiple: false,
				title: distro ? 'Choose a folder in WSL' : 'Choose a folder',
				defaultPath: distro ? wslShare(distro, '/home') : undefined
			});
			if (typeof dir !== 'string') return;
			const loc = await resolveCodeFolder(dir, null);
			distro = loc.wslDistro ?? '';
			root = loc.root;
		} catch (e) {
			error = errMessage(e);
		}
	}

	async function start() {
		if (peer) return startThere(peer);
		if (!root || starting) return;
		starting = true;
		error = null;
		try {
			const inWorktree = inRepo && worktree;
			const session = await newSession(root, {
				wslDistro: onWindows ? distro || null : null,
				worktree: inWorktree
			});
			// The repository's folder, not the new worktree, is offered next time.
			updateSettings({
				codeLastRoot: inWorktree ? root : session.root,
				codeLastWslDistro: session.wslDistro ?? '',
				...(inRepo ? { codeNewWorktree: worktree } : {})
			});
			onclose();
		} catch (e) {
			error = errMessage(e);
		} finally {
			starting = false;
		}
	}
</script>

<Modal {open} maxWidth={460} title="New session" dismissable {onclose}>
	{#if peers.length > 0}
		<label
			class="where"
			title="Another computer runs the session in its own folders, with its own models."
		>
			<span>Where</span>
			<select bind:value={where} aria-label="Where">
				<option value="">This computer</option>
				{#each peers as p (p.id)}
					<option value={p.id}>{p.config.name}</option>
				{/each}
			</select>
		</label>
	{/if}
	{#if peer}
		<div class="folder-row">
			{#if peerDistros.length > 0}
				<select
					aria-label="Location"
					title="Where the folder is on {peer.config.name}"
					bind:value={peerDistro}
				>
					<option value="">Its own folders</option>
					{#each peerDistros as d (d)}
						<option value={d}>{d}</option>
					{/each}
				</select>
			{/if}
			<input
				class="path-input"
				aria-label="Folder on {peer.config.name}"
				placeholder="A folder on {peer.config.name}"
				spellcheck="false"
				list="peer-recent-roots"
				bind:value={peerRoot}
				onkeydown={(e) => {
					if (e.key === 'Enter') void start();
				}}
			/>
			<datalist id="peer-recent-roots">
				{#each recentRoots(peer) as r (r)}
					<option value={r}></option>
				{/each}
			</datalist>
		</div>
		<label
			class="worktree"
			title="In a git repository there: a new folder beside the project on a new branch from the last commit."
		>
			<input type="checkbox" bind:checked={peerWorktree} />
			<span>Work in a new worktree</span>
		</label>
	{:else if onWindows}
		<p class="help">
			Pick a project folder on this PC or in WSL. The session works in it and can't leave it.
		</p>
		<div class="folder-row">
			<select aria-label="Location" title="Where the folder is" bind:value={distro}>
				<option value="">This PC (Windows)</option>
				{#each distros as d (d)}
					<option value={d}>{d}</option>
				{/each}
			</select>
			<input
				class="path-input"
				aria-label="Folder"
				placeholder={distro ? '~/project' : 'C:\\Users\\you\\project'}
				spellcheck="false"
				bind:value={root}
				onkeydown={(e) => {
					if (e.key === 'Enter') void start();
				}}
			/>
			<button class="btn" onclick={() => void browse()}>Browse…</button>
		</div>
		{#if distro && root.startsWith('/mnt/')}
			<p class="note" title="Files under /mnt are on Windows; WSL reaches them over a slow bridge.">
				Slow: these files are on Windows. Pick This PC instead.
			</p>
		{/if}
	{:else}
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
	{/if}
	{#if inRepo && !peer}
		<label
			class="worktree"
			title="A new folder beside the project, <project>-worktrees/<branch>, on a new branch from the last commit. Uncommitted changes and ignored files are not in it."
		>
			<input type="checkbox" bind:checked={worktree} />
			<span>Work in a new worktree</span>
		</label>
	{/if}
	{#if error}
		<p class="error">{error}</p>
	{/if}
	<div class="actions">
		<button class="btn" onclick={onclose}>Cancel</button>
		<button
			class="btn btn-primary"
			disabled={(peer ? !peerRoot.trim() : !root) || starting}
			onclick={start}
			>{starting
				? (peer ? peerWorktree : inRepo && worktree)
					? 'Creating the worktree…'
					: 'Starting…'
				: 'Start session'}</button
		>
	</div>
</Modal>

<style>
	.where {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 0 0 12px;
		font-size: 0.85rem;
	}

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

	.path-input {
		flex: 1;
		min-width: 0;
		font-family: var(--font-mono, monospace);
		font-size: 0.8rem;
	}

	.worktree {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 12px 0 0;
		font-size: 0.85rem;
	}

	.note {
		margin: 8px 0 0;
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
