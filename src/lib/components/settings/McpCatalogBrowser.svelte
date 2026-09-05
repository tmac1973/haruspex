<script lang="ts">
	/**
	 * The bundled catalog, with what each entry will cost the user in setup
	 * **before** they commit to installing it.
	 *
	 * That disclosure is the point of this component. Finding out after a
	 * download that the integration needs a Google Cloud project, two enabled
	 * APIs and a browser sign-in is the moment someone abandons it
	 * half-configured — and a half-configured server is worse than none, because
	 * it sits in the list looking broken.
	 */
	import type { CatalogEntry } from '$lib/ipc/gen/CatalogEntry';
	import type { RuntimeAvailability } from '$lib/ipc/gen/RuntimeAvailability';
	import type { DownloadProgress } from '$lib/ipc/gen/DownloadProgress';
	import { describeSetup } from '$lib/stores/mcpSetup';

	interface Props {
		entries: CatalogEntry[];
		/** Ids already configured, so an entry can say so rather than duplicating. */
		installedEntryIds: string[];
		runtimes: RuntimeAvailability | null;
		/** Non-null while an install is running, for the progress line. */
		progress: DownloadProgress | null;
		installingId: string | null;
		oninstall: (entry: CatalogEntry) => void;
		oncancel: () => void;
	}

	const {
		entries,
		installedEntryIds,
		runtimes,
		progress,
		installingId,
		oninstall,
		oncancel
	}: Props = $props();

	/**
	 * Why an entry cannot be installed right now, or null.
	 *
	 * Checked here rather than at spawn time: a missing bundled runtime is a
	 * broken install of Haruspex itself, and telling the user that up front
	 * beats an npm failure deep inside a progress bar.
	 */
	function blockedReason(entry: CatalogEntry): string | null {
		if (!runtimes) return null;
		switch (entry.acquisition.kind) {
			case 'npm':
				return runtimes.node && runtimes.npm
					? null
					: 'Needs the bundled Node runtime, which is missing from this install.';
			case 'pypi':
				return runtimes.uv ? null : 'Needs the bundled uv runtime, which is missing.';
			default:
				return null;
		}
	}

	function percent(p: DownloadProgress): number | null {
		return p.total > 0 ? Math.round((p.downloaded / p.total) * 100) : null;
	}
</script>

<ul class="catalog">
	{#each entries as entry (entry.id)}
		{@const blocked = blockedReason(entry)}
		{@const setup = describeSetup(entry.setup)}
		{@const installed = installedEntryIds.includes(entry.id)}
		<li>
			<div class="head">
				<span class="name">{entry.name}</span>
				{#if installed}<span class="tag">added</span>{/if}
			</div>
			<p class="description">{entry.description}</p>
			{#if entry.companion}
				<p class="companion-requirement">
					Needs {entry.companion.app}{#if entry.companion.minVersion}
						{entry.companion.minVersion} or newer{/if} installed and running on this computer. Haruspex
					does not install it.
				</p>
			{/if}
			{#if setup}<p class="setup-cost">{setup}</p>{/if}
			{#if entry.provenance && !entry.provenance.firstParty}
				<p class="provenance">
					Community project by {entry.provenance.maintainer} ({entry.provenance.license}). Its tools
					run with the same approval prompts as any other server.
				</p>
			{/if}
			{#if blocked}
				<p class="blocked">{blocked}</p>
			{/if}
			{#if installingId === entry.id}
				<p class="progress">
					{progress?.stage ?? 'Installing…'}
					{#if progress && percent(progress) !== null}· {percent(progress)}%{/if}
				</p>
				<button type="button" onclick={oncancel}>Cancel</button>
			{:else}
				<button
					type="button"
					disabled={blocked !== null || installingId !== null}
					onclick={() => oninstall(entry)}
				>
					{installed ? 'Add another' : 'Add'}
				</button>
			{/if}
		</li>
	{/each}
</ul>

<style>
	.catalog {
		list-style: none;
		padding: 0;
		margin: 0;
	}
	.catalog li {
		padding: 0.75rem 0;
		border-bottom: 1px solid var(--border-subtle, #292524);
	}
	.head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.name {
		font-weight: 600;
	}
	.tag {
		font-size: 0.75em;
		padding: 0 0.35rem;
		border: 1px solid var(--border-subtle, #292524);
		border-radius: 3px;
		color: var(--text-secondary, #a8a29e);
	}
	.description,
	.setup-cost,
	.progress {
		margin: 0.2rem 0;
		font-size: 0.9em;
	}
	.setup-cost,
	.provenance {
		color: var(--text-secondary, #a8a29e);
	}
	.provenance,
	.companion-requirement {
		margin: 0.2rem 0;
		font-size: 0.85em;
	}
	.companion-requirement {
		color: var(--warning, #d97706);
	}
	.blocked {
		font-size: 0.9em;
		color: var(--danger, #ef4444);
	}
</style>
