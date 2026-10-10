<script lang="ts">
	/**
	 * Pick the folder a new Code session works in. It is fixed for the
	 * session's life. Defaults to the last folder used (`codeLastRoot`).
	 *
	 * On Windows the folder is inside a WSL2 distro: a distro, a Linux path
	 * typed or browsed (Explorer's `\\wsl.localhost\<distro>\…` is split into
	 * the two by Rust). Native Windows folders are refused there (#396).
	 */
	import { open as openDialog } from '@tauri-apps/plugin-dialog';
	import Modal from '#lib/components/Modal.svelte';
	import WorkingDirButton from '#lib/components/WorkingDirButton.svelte';
	import { resolveCodeFolder, wslDistros } from '#lib/code/db.ts';
	import { newSession } from '#lib/stores/code.svelte.ts';
	import { getSettings, updateSettings } from '#lib/stores/settings.ts';
	import { errMessage } from '#lib/utils/error.ts';

	let { open, onclose }: { open: boolean; onclose: () => void } = $props();

	const onWindows = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);

	let root = $state('');
	/** Windows: the distro `root` is in. */
	let distro = $state('');
	let distros = $state<string[] | null>(null);
	let starting = $state(false);
	let error = $state<string | null>(null);

	// Each time it opens, start from the last folder used.
	$effect(() => {
		if (open) {
			const s = getSettings();
			root = s.codeLastRoot;
			distro = s.codeLastWslDistro;
			error = null;
			if (onWindows) void loadDistros();
		}
	});

	async function loadDistros(): Promise<void> {
		const list = await wslDistros();
		distros = list;
		if (!list.includes(distro)) {
			distro = list[0] ?? '';
			if (!root.startsWith('/') && !root.startsWith('~')) root = '';
		}
	}

	/** Explorer opened on the distro's share; the pick is split into distro and path. */
	async function browse(): Promise<void> {
		error = null;
		try {
			const dir = await openDialog({
				directory: true,
				multiple: false,
				title: 'Choose a folder in WSL',
				defaultPath: distro ? `\\\\wsl.localhost\\${distro}\\home` : undefined
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
		if (!root || starting) return;
		starting = true;
		error = null;
		try {
			const session = await newSession(root, { wslDistro: onWindows ? distro || null : null });
			updateSettings({ codeLastRoot: session.root, codeLastWslDistro: session.wslDistro ?? '' });
			onclose();
		} catch (e) {
			error = errMessage(e);
		} finally {
			starting = false;
		}
	}
</script>

<Modal {open} maxWidth={460} title="New session" dismissable {onclose}>
	{#if onWindows}
		<p class="help">
			Pick a project folder inside WSL. The session works in it and can't leave it.
		</p>
		{#if distros && distros.length === 0}
			<p class="error">No WSL2 distro found. Install one with <code>wsl --install</code>.</p>
		{:else}
			<div class="folder-row">
				<select
					aria-label="WSL distro"
					title="The WSL distro the folder is in"
					bind:value={distro}
					disabled={!distros}
				>
					{#each distros ?? [] as d (d)}
						<option value={d}>{d}</option>
					{/each}
				</select>
				<input
					class="path-input"
					aria-label="Folder"
					placeholder="~/project"
					spellcheck="false"
					bind:value={root}
					onkeydown={(e) => {
						if (e.key === 'Enter') void start();
					}}
				/>
				<button class="btn" onclick={() => void browse()}>Browse…</button>
			</div>
			{#if root.startsWith('/mnt/')}
				<p
					class="note"
					title="Files under /mnt are on Windows; WSL reaches them over a slow bridge."
				>
					Slow: these files are on Windows.
				</p>
			{/if}
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
	{#if error}
		<p class="error">{error}</p>
	{/if}
	<div class="actions">
		<button class="btn" onclick={onclose}>Cancel</button>
		<button class="btn btn-primary" disabled={!root || starting} onclick={start}
			>{starting ? 'Starting…' : 'Start session'}</button
		>
	</div>
</Modal>

<style>
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
