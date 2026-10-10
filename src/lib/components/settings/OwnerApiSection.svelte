<script lang="ts">
	/**
	 * Settings → Remote control: the owner API (plan/remote-api/). The server,
	 * and the devices allowed to use it. A device's token is shown once, when
	 * it is added; Rust keeps only its hash.
	 */
	import { onMount } from 'svelte';

	import { getSettings, updateSettings } from '#lib/stores/settings.ts';
	import {
		ALL_SCOPES,
		applyOwnerApi,
		createOwnerClient,
		listOwnerClients,
		ownerApiStatus,
		revokeOwnerClient,
		type OwnerApiStatus,
		type OwnerClient,
		type Scope
	} from '#lib/owner/service.ts';
	import { errMessage } from '#lib/utils/error.ts';

	const SCOPE_LABELS: Record<Scope, { label: string; title: string }> = {
		read: { label: 'Read', title: 'List and read Code sessions, and follow them as they run.' },
		drive: { label: 'Drive', title: 'Start sessions and turns, steer them and stop them.' },
		approve: {
			label: 'Approve',
			title: 'Answer "Run this command?" and the questions the agent asks you.'
		}
	};

	let enabled = $state(getSettings().ownerApiEnabled);
	let port = $state(getSettings().ownerApiPort);
	let bindAll = $state(getSettings().ownerApiBindAll);

	let status = $state<OwnerApiStatus | null>(null);
	let devices = $state<OwnerClient[]>([]);
	let error = $state<string | null>(null);
	let busy = $state(false);

	let newName = $state('');
	let newScopes = $state<Scope[]>([...ALL_SCOPES]);
	/** The token just made, until the user says they have it. */
	let shown = $state<{ name: string; token: string } | null>(null);
	let copied = $state<string | null>(null);

	const address = $derived(
		status?.running && status.address && status.port
			? `http://${status.address}:${status.port}`
			: null
	);

	async function refresh(): Promise<void> {
		try {
			[status, devices] = await Promise.all([ownerApiStatus(), listOwnerClients()]);
		} catch (e) {
			error = errMessage(e);
		}
	}

	async function apply(): Promise<void> {
		busy = true;
		error = null;
		updateSettings({ ownerApiEnabled: enabled, ownerApiPort: port, ownerApiBindAll: bindAll });
		try {
			status = await applyOwnerApi();
		} catch (e) {
			error = errMessage(e);
			status = await ownerApiStatus().catch(() => null);
		} finally {
			busy = false;
		}
	}

	async function add(): Promise<void> {
		error = null;
		try {
			const made = await createOwnerClient(newName, newScopes);
			shown = { name: made.client.name, token: made.token };
			newName = '';
			newScopes = [...ALL_SCOPES];
			devices = await listOwnerClients();
		} catch (e) {
			error = errMessage(e);
		}
	}

	async function revoke(device: OwnerClient): Promise<void> {
		error = null;
		try {
			await revokeOwnerClient(device.id);
			devices = await listOwnerClients();
		} catch (e) {
			error = errMessage(e);
		}
	}

	function toggleScope(scope: Scope, on: boolean): void {
		newScopes = on ? [...newScopes, scope] : newScopes.filter((s) => s !== scope);
	}

	async function copy(text: string, what: string): Promise<void> {
		await navigator.clipboard.writeText(text);
		copied = what;
		setTimeout(() => (copied = copied === what ? null : copied), 1500);
	}

	function seen(at: number | null): string {
		if (at === null) return 'never used';
		return `last used ${new Date(at * 1000).toLocaleString()}`;
	}

	onMount(() => {
		void refresh();
	});
</script>

<section class="settings-section">
	<h3>Remote control</h3>

	<label class="toggle-row">
		<input type="checkbox" bind:checked={enabled} onchange={apply} disabled={busy} />
		<span>Let your own devices drive your Code sessions</span>
	</label>
	<p class="help">Each device uses its own token, shown once when you add it.</p>

	{#if error}
		<p class="error" role="alert">{error}</p>
	{/if}

	<div class="field">
		<label for="owner-port">Port</label>
		<input
			id="owner-port"
			type="number"
			min="1024"
			max="65535"
			bind:value={port}
			onchange={apply}
			disabled={busy}
		/>
	</div>

	<label
		class="toggle-row"
		title="Off: only this computer answers, which is what `tailscale serve` needs. On: every network this computer is on can reach the port, so firewall it to the devices you mean."
	>
		<input type="checkbox" bind:checked={bindAll} onchange={apply} disabled={busy} />
		<span>Listen on all networks</span>
	</label>

	{#if address}
		<div class="block">
			<span class="label">Address</span>
			<div class="row">
				<code class="value">{address}</code>
				<button onclick={() => copy(address!, 'address')}
					>{copied === 'address' ? 'Copied' : 'Copy'}</button
				>
			</div>
		</div>
	{/if}

	<div class="block">
		<span class="label">Devices</span>
		{#if devices.length === 0}
			<p class="help">No devices yet.</p>
		{/if}
		<ul class="devices">
			{#each devices as device (device.id)}
				<li>
					<div class="who">
						<strong>{device.name}</strong>
						<span class="meta"
							>{device.scopes.map((s) => SCOPE_LABELS[s].label).join(', ')} · {seen(
								device.lastSeen
							)}</span
						>
					</div>
					<button class="btn btn-small btn-danger" onclick={() => revoke(device)}>Revoke</button>
				</li>
			{/each}
		</ul>

		{#if shown}
			<div class="token" role="status">
				<p class="help">
					The token for <strong>{shown.name}</strong>. Copy it now — you won't see it again.
				</p>
				<div class="row">
					<code class="value">{shown.token}</code>
					<button onclick={() => copy(shown!.token, 'token')}
						>{copied === 'token' ? 'Copied' : 'Copy'}</button
					>
					<button onclick={() => (shown = null)}>Done</button>
				</div>
			</div>
		{:else}
			<form
				class="add"
				onsubmit={(e) => {
					e.preventDefault();
					void add();
				}}
			>
				<input
					type="text"
					placeholder="Device name"
					aria-label="Device name"
					maxlength="60"
					bind:value={newName}
				/>
				{#each ALL_SCOPES as scope (scope)}
					<label class="scope" title={SCOPE_LABELS[scope].title}>
						<input
							type="checkbox"
							checked={newScopes.includes(scope)}
							onchange={(e) => toggleScope(scope, e.currentTarget.checked)}
						/>
						{SCOPE_LABELS[scope].label}
					</label>
				{/each}
				<button type="submit" disabled={!newName.trim() || newScopes.length === 0}
					>Add device</button
				>
			</form>
		{/if}
	</div>
</section>

<style>
	.help {
		color: var(--text-secondary);
		font-size: 0.85rem;
		line-height: 1.45;
		margin: 0 0 12px;
	}

	.field {
		display: flex;
		align-items: center;
		gap: 10px;
		margin: 12px 0;
	}

	.field input {
		width: 8rem;
	}

	.label {
		display: block;
		font-size: 0.85rem;
		font-weight: 600;
		margin-bottom: 6px;
	}

	.block {
		margin-top: 16px;
		padding-top: 14px;
		border-top: 1px solid var(--border);
	}

	.row {
		display: flex;
		gap: 8px;
		align-items: center;
		flex-wrap: wrap;
	}

	.value {
		flex: 1;
		min-width: 12rem;
		padding: 6px 8px;
		border-radius: 6px;
		background: var(--bg-secondary);
		overflow-wrap: anywhere;
		font-size: 0.85rem;
	}

	.devices {
		list-style: none;
		margin: 0 0 12px;
		padding: 0;
	}

	.devices li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		padding: 6px 0;
	}

	.who {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.meta {
		color: var(--text-secondary);
		font-size: 0.8rem;
	}

	.add {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}

	.add input[type='text'] {
		flex: 1;
		min-width: 10rem;
	}

	.scope {
		display: flex;
		align-items: center;
		gap: 4px;
		font-size: 0.85rem;
	}

	.token {
		padding: 10px;
		border-radius: 6px;
		border: 1px solid var(--border);
	}

	.error {
		color: var(--error, #b42318);
		font-size: 0.85rem;
	}
</style>
