<script lang="ts">
	/** The desktop's Code sessions: open ones first, then saved ones; and New session. */
	import type { WebStore } from '../store.svelte.ts';

	let { store }: { store: WebStore } = $props();

	let creating = $state(false);
	let folder = $state('');

	/** Folders of saved sessions, to pick from instead of typing. */
	const recent = $derived([...new Set(store.sessions.map((s) => s.root))].slice(0, 8));

	const STATUS: Record<string, string> = {
		idle: 'Open',
		queued: 'Queued',
		running: 'Working',
		'waiting-shell': 'Waiting for the Shell'
	};

	function name(path: string): string {
		return path.split(/[/\\]/).filter(Boolean).at(-1) ?? path;
	}

	async function start(): Promise<void> {
		if (!folder.trim()) return;
		await store.newSession(folder);
		if (!store.error) {
			creating = false;
			folder = '';
		}
	}
</script>

<div class="head">
	<span class="title">Code</span>
	<span class="conn {store.connection}" title="Connection to your computer">
		{store.connection === 'open'
			? 'Connected'
			: store.connection === 'connecting'
				? 'Connecting…'
				: 'Offline'}
	</span>
</div>

{#if creating}
	<form
		class="new"
		onsubmit={(e) => {
			e.preventDefault();
			void start();
		}}
	>
		<input
			aria-label="Project folder"
			placeholder="Folder on your computer"
			list="recent-folders"
			bind:value={folder}
		/>
		<datalist id="recent-folders">
			{#each recent as path (path)}
				<option value={path}></option>
			{/each}
		</datalist>
		<div class="row">
			<button class="btn btn-primary btn-small" type="submit" disabled={!folder.trim()}
				>Start session</button
			>
			<button class="btn btn-small" type="button" onclick={() => (creating = false)}>Cancel</button>
		</div>
	</form>
{:else}
	<button class="btn btn-small new-btn" onclick={() => (creating = true)}>New session</button>
{/if}

{#if store.error && !store.selected}
	<p class="error-text" role="alert">{store.error}</p>
{/if}

<ul>
	{#each store.sessions as s (s.id)}
		<li>
			<button
				class="item"
				class:active={s.id === store.selected}
				onclick={() => store.select(s.id)}
				title={s.root}
			>
				<span class="name">{s.title || name(s.root)}</span>
				<span class="meta">
					<span>{name(s.root)}</span>
					{#if s.status}
						<span class="sep">·</span>
						<span class="status {s.status}">{STATUS[s.status] ?? s.status}</span>
					{/if}
				</span>
			</button>
		</li>
	{:else}
		<li class="none">No sessions yet.</li>
	{/each}
</ul>

<style>
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 14px 14px 8px;
	}

	.title {
		font-weight: 600;
	}

	.conn {
		font-size: 0.75rem;
		color: var(--text-secondary);
	}

	.conn.open {
		color: var(--accent);
	}

	.new-btn {
		margin: 0 14px 8px;
	}

	.new {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 0 14px 10px;
	}

	.new input {
		padding: 8px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-input);
		color: var(--text-primary);
	}

	.row {
		display: flex;
		gap: 8px;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0 6px 12px;
	}

	.item {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 2px;
		width: 100%;
		padding: 10px;
		border: none;
		border-radius: 8px;
		background: none;
		color: inherit;
		text-align: left;
		cursor: pointer;
		font: inherit;
	}

	.item:hover,
	.item.active {
		background: var(--bg-raised);
	}

	.name {
		font-weight: 500;
		overflow-wrap: anywhere;
	}

	.meta {
		display: flex;
		gap: 5px;
		font-size: 0.78rem;
		color: var(--text-secondary);
	}

	.status.running,
	.status.waiting-shell {
		color: var(--accent);
	}

	.none {
		padding: 10px;
		color: var(--text-secondary);
	}

	.error-text {
		margin: 0 14px 8px;
	}
</style>
