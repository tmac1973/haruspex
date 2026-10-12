<script lang="ts">
	/**
	 * "Who can connect", shared by Settings → Remote control and Settings →
	 * Guest chat: the token (or link) alone, the computers listed here, or the
	 * whole local network (`owner::trust` in Rust). Each section names the
	 * modes in its own words and keeps its own settings.
	 */
	import type { Snippet } from 'svelte';

	import type { AccessMode } from '#lib/ipc/gen/AccessMode.ts';
	import type { TrustedHost } from '#lib/ipc/gen/TrustedHost.ts';

	interface Props {
		modes: { value: AccessMode; label: string; title: string }[];
		mode: AccessMode;
		hosts: string[];
		/** Where each listed computer was last found. */
		found: TrustedHost[];
		onmode: (next: AccessMode) => void;
		onhosts: (next: string[]) => void;
		/** Shown under the picker, e.g. the address to open. */
		children?: Snippet;
	}

	let { modes, mode, hosts, found, onmode, onhosts, children }: Props = $props();

	let newHost = $state('');

	function addHost(): void {
		const host = newHost.trim();
		if (!host || hosts.includes(host)) return;
		newHost = '';
		onhosts([...hosts, host]);
	}

	function where(host: string): { text: string; ok: boolean } {
		const hit = found.find((f) => f.name === host);
		if (!hit) return { text: '…', ok: true };
		return hit.addresses.length
			? { text: hit.addresses.join(', '), ok: true }
			: { text: 'not found', ok: false };
	}
</script>

<span class="label">Who can connect</span>
<div class="segmented">
	{#each modes as m (m.value)}
		<button class:active={mode === m.value} title={m.title} onclick={() => onmode(m.value)}
			>{m.label}</button
		>
	{/each}
</div>

{#if mode === 'trusted'}
	<ul class="list">
		{#each hosts as host (host)}
			{@const at = where(host)}
			<li>
				<span class="name">{host}</span>
				<span
					class="meta"
					class:bad={!at.ok}
					title={at.ok
						? 'Where this name points on your network right now.'
						: 'Nothing on your network answers to this name. Check the spelling, or use its IP address.'}
					>{at.text}</span
				>
				<button
					class="icon"
					title="Stop trusting this computer"
					aria-label="Remove {host}"
					onclick={() => onhosts(hosts.filter((h) => h !== host))}>×</button
				>
			</li>
		{/each}
	</ul>
	<form
		class="row"
		onsubmit={(e) => {
			e.preventDefault();
			addHost();
		}}
	>
		<input
			class="grow"
			aria-label="Computer name or IP address"
			placeholder="Computer name or IP address"
			title="The other computer's name on your network (like laptop or laptop.local) or its IP address."
			bind:value={newHost}
		/>
		<button class="btn btn-small" type="submit" disabled={!newHost.trim()}>Add</button>
	</form>
{/if}

{@render children?.()}

<style>
	.label {
		display: block;
		font-size: 0.85rem;
		font-weight: 600;
		margin-bottom: 8px;
	}

	.row {
		display: flex;
		gap: 8px;
		align-items: center;
		flex-wrap: wrap;
		margin-top: 8px;
	}

	.grow {
		flex: 1;
		min-width: 12rem;
		padding: 8px 12px;
		border: 1px solid var(--border-strong);
		border-radius: 7px;
		background: var(--bg-input);
		color: var(--text-primary);
		font-size: 0.9rem;
	}

	.list {
		list-style: none;
		margin: 8px 0;
		padding: 0;
	}

	.list li {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 5px 0;
	}

	.name {
		font-weight: 500;
	}

	.meta {
		flex: 1;
		color: var(--text-secondary);
		font-size: 0.8rem;
	}

	.meta.bad {
		color: var(--error-text);
	}

	.icon {
		border: none;
		background: none;
		color: var(--text-secondary);
		font-size: 1.1rem;
		cursor: pointer;
	}
</style>
