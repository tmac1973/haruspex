<script lang="ts">
	/**
	 * Settings → Remote control: the owner API (plan/remote-api/) and its web
	 * page, for using this Haruspex from the owner's other computers.
	 *
	 * Who can connect: devices with a token (each added below, its token or
	 * one-time link shown once), plus, if chosen, listed computers or the whole
	 * local network with no token. Explanations live in tooltips.
	 */
	import { onMount } from 'svelte';

	import { getLinkQr, qrPath, type QrMatrix } from '#lib/remote/api.ts';
	import { getSettings, updateSettings } from '#lib/stores/settings.ts';
	import {
		ALL_SCOPES,
		applyOwnerApi,
		createOwnerClient,
		listOwnerClients,
		ownerApiStatus,
		ownerTrustedHosts,
		pairOwnerClient,
		pairingLink,
		revokeOwnerClient,
		type AccessMode,
		type CreatedOwnerClient,
		type OwnerApiStatus,
		type OwnerClient,
		type Scope,
		type TrustedHost
	} from '#lib/owner/service.ts';
	import { errMessage } from '#lib/utils/error.ts';
	import WhoCanConnect from '#lib/components/settings/WhoCanConnect.svelte';

	const SCOPE_LABELS: Record<Scope, { label: string; title: string }> = {
		read: { label: 'Read', title: 'List and read Code sessions, and follow them as they run.' },
		drive: { label: 'Drive', title: 'Start sessions and turns, steer them and stop them.' },
		approve: {
			label: 'Approve',
			title: 'Answer "Run this command?" and the questions the agent asks you.'
		}
	};

	const MODES: { value: AccessMode; label: string; title: string }[] = [
		{
			value: 'tokens',
			label: 'Devices with a token',
			title:
				'Only devices you add below can connect. Each gets its own token, or a one-time link that signs a browser in.'
		},
		{
			value: 'trusted',
			label: 'These computers',
			title:
				'The computers you list connect without a token, by name or IP address. Names are looked up on your network, so a changed address still works. Devices with a token still work too.'
		},
		{
			value: 'lan',
			label: 'My whole network',
			title:
				'Any computer on your local network (192.168.x.x, 10.x.x.x, …) connects without a token. Only for a network you trust. Devices with a token still work too.'
		}
	];

	let enabled = $state(getSettings().ownerApiEnabled);
	let port = $state(getSettings().ownerApiPort);
	let bindAll = $state(getSettings().ownerApiBindAll);
	let linkBase = $state(getSettings().ownerApiLinkBase);
	let mode = $state<AccessMode>(getSettings().ownerApiAccess);
	let trustedHosts = $state<string[]>([...getSettings().ownerApiTrustedHosts]);

	let status = $state<OwnerApiStatus | null>(null);
	let devices = $state<OwnerClient[]>([]);
	let found = $state<TrustedHost[]>([]);
	let error = $state<string | null>(null);
	let busy = $state(false);

	let adding = $state(false);
	let newName = $state('');
	let newScopes = $state<Scope[]>([...ALL_SCOPES]);
	/** The link and token just made, until the user says they have them. */
	let shown = $state<{ name: string; token: string; link: string | null } | null>(null);
	let qr = $state<QrMatrix | null>(null);
	let copied = $state<string | null>(null);

	/** Where it answers, from this computer's point of view. */
	const address = $derived(
		status?.running && status.address && status.port
			? `https://${status.address}:${status.port}`
			: null
	);
	/** Where another computer opens the page: the link address, else the address. */
	const base = $derived(linkBase.trim() ? asHttps(linkBase.trim()) : address);

	/** A link address as HTTPS, which is all the server speaks: `box.lan` or `http://…` too. */
	function asHttps(link: string): string {
		if (/^http:\/\//i.test(link)) return `https://${link.slice(7)}`;
		return /^[a-z]+:\/\//i.test(link) ? link : `https://${link}`;
	}

	const CERT_HINT =
		'Haruspex made its own certificate, so a browser warns the first time. Continue if the fingerprint it shows matches Settings → Remote control → Advanced → Certificate.';
	const pageUrl = $derived(base ? `${base.replace(/\/+$/, '')}/app/` : null);

	async function refresh(): Promise<void> {
		try {
			[status, devices, found] = await Promise.all([
				ownerApiStatus(),
				listOwnerClients(),
				ownerTrustedHosts()
			]);
		} catch (e) {
			error = errMessage(e);
		}
	}

	async function apply(): Promise<void> {
		busy = true;
		error = null;
		updateSettings({
			ownerApiEnabled: enabled,
			ownerApiPort: port,
			ownerApiBindAll: bindAll,
			ownerApiLinkBase: linkBase.trim(),
			ownerApiAccess: mode,
			ownerApiTrustedHosts: [...trustedHosts]
		});
		try {
			status = await applyOwnerApi();
			found = await ownerTrustedHosts();
		} catch (e) {
			error = errMessage(e);
			status = await ownerApiStatus().catch(() => null);
		} finally {
			busy = false;
		}
	}

	function setMode(next: AccessMode): void {
		mode = next;
		// Letting other computers in without a token means listening for them.
		if (next !== 'tokens') bindAll = true;
		void apply();
	}

	function setHosts(next: string[]): void {
		trustedHosts = next;
		void apply();
	}

	async function show(made: CreatedOwnerClient): Promise<void> {
		const link = base ? pairingLink(base, made.pairCode) : null;
		shown = { name: made.client.name, token: made.token, link };
		qr = link ? await getLinkQr(link).catch(() => null) : null;
	}

	async function add(): Promise<void> {
		error = null;
		try {
			await show(await createOwnerClient(newName, newScopes));
			adding = false;
			newName = '';
			newScopes = [...ALL_SCOPES];
			devices = await listOwnerClients();
		} catch (e) {
			error = errMessage(e);
		}
	}

	async function newLink(device: OwnerClient): Promise<void> {
		error = null;
		try {
			await show(await pairOwnerClient(device.id));
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
		return at === null ? 'never used' : `last used ${new Date(at * 1000).toLocaleString()}`;
	}

	onMount(() => {
		void refresh();
	});
</script>

<section class="settings-section">
	<h3>Remote control</h3>

	<label
		class="toggle-row"
		title="Serves a web page for using your Code sessions from another computer's browser. Turns still run here, with this computer's files and models."
	>
		<input type="checkbox" bind:checked={enabled} onchange={apply} disabled={busy} />
		<span>Let your other computers use this Haruspex</span>
	</label>

	{#if error}
		<p class="error" role="alert">{error}</p>
	{/if}

	<div class="block">
		<WhoCanConnect
			modes={MODES}
			{mode}
			hosts={trustedHosts}
			{found}
			onmode={setMode}
			onhosts={setHosts}
		>
			{#if mode !== 'tokens' && pageUrl}
				<div class="row open">
					<span
						class="label inline"
						title="Open this in a browser on a computer allowed above. No token or link needed.{status?.hostname
							? ` ${status.hostname}'s name may work in place of the address.`
							: ''} {CERT_HINT}">Open on your other computer</span
					>
					<code class="value">{pageUrl}</code>
					<button class="btn btn-small" onclick={() => copy(pageUrl!, 'page')}
						>{copied === 'page' ? 'Copied' : 'Copy'}</button
					>
				</div>
			{/if}
		</WhoCanConnect>
	</div>

	<div class="block">
		<span
			class="label"
			title="Each device gets its own token and permissions, and can be revoked on its own. A browser signs in with a one-time link instead of the token."
			>Devices with a token</span
		>
		{#if devices.length > 0}
			<ul class="list">
				{#each devices as device (device.id)}
					<li>
						<span class="name">{device.name}</span>
						<span class="meta"
							>{device.scopes.map((s) => SCOPE_LABELS[s].label).join(', ')} · {seen(
								device.lastSeen
							)}</span
						>
						<button
							class="btn btn-small"
							title="A new one-time link for this device. It also gets a new token, so anything using the old one must use the new one."
							onclick={() => newLink(device)}>New link</button
						>
						<button
							class="btn btn-small btn-danger"
							title="Cut this device off now."
							onclick={() => revoke(device)}>Revoke</button
						>
					</li>
				{/each}
			</ul>
		{/if}

		{#if shown}
			<div class="made" role="status">
				{#if shown.link}
					<span
						class="label"
						title="Open it in a browser on {shown.name}. It works once, within 10 minutes; after that the browser stays signed in."
						>Open this link on {shown.name}</span
					>
					<div class="row">
						<code class="value">{shown.link}</code>
						<button class="btn btn-small" onclick={() => copy(shown!.link!, 'link')}
							>{copied === 'link' ? 'Copied' : 'Copy'}</button
						>
					</div>
					{#if qr}
						<svg
							class="qr"
							viewBox="-2 -2 {qr.size + 4} {qr.size + 4}"
							role="img"
							aria-label="QR code for the link"
						>
							<rect x="-2" y="-2" width={qr.size + 4} height={qr.size + 4} fill="#fff" />
							<path d={qrPath(qr)} fill="#000" />
						</svg>
					{/if}
				{:else}
					<span class="label" title="The link needs an address to point at."
						>Turn Remote control on to get a link</span
					>
				{/if}
				<details>
					<summary
						title="For a script or another program: send it as Authorization: Bearer <token>. Shown only now."
						>Token for a script</summary
					>
					<div class="row">
						<code class="value">{shown.token}</code>
						<button class="btn btn-small" onclick={() => copy(shown!.token, 'token')}
							>{copied === 'token' ? 'Copied' : 'Copy'}</button
						>
					</div>
				</details>
				<button class="btn btn-small" onclick={() => ((shown = null), (qr = null))}>Done</button>
			</div>
		{:else if adding}
			<form
				class="made"
				onsubmit={(e) => {
					e.preventDefault();
					void add();
				}}
			>
				<div class="field">
					<label for="owner-device-name" title="Only a label for this list.">Name</label>
					<input
						id="owner-device-name"
						placeholder="e.g. Laptop"
						maxlength="60"
						bind:value={newName}
					/>
				</div>
				<div class="row">
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
				</div>
				<div class="row">
					<button
						class="btn btn-small btn-primary"
						type="submit"
						disabled={!newName.trim() || newScopes.length === 0}>Create link</button
					>
					<button class="btn btn-small" type="button" onclick={() => (adding = false)}
						>Cancel</button
					>
				</div>
			</form>
		{:else}
			<button
				class="btn btn-small"
				title="Make a one-time link (and a token) for a device that isn't trusted above."
				onclick={() => (adding = true)}>Add a device…</button
			>
		{/if}
	</div>

	<details class="block">
		<summary>Advanced</summary>
		<div class="field">
			<label
				for="owner-port"
				title="The port the page and the API answer on. 8788 unless something else uses it."
				>Port</label
			>
			<input
				id="owner-port"
				class="short"
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
			title="On: other computers on your networks can reach the port (choosing These computers or My whole network turns it on). Off: only this computer, or a proxy running on it."
		>
			<input type="checkbox" bind:checked={bindAll} onchange={apply} disabled={busy} />
			<span>Listen on all networks</span>
		</label>
		<div class="field">
			<label
				for="owner-link-base"
				title="The address other computers use to reach this one, if it isn't the one shown in links (for example a name your router gives it, or a proxy's address). Links and QR codes use it, and the page accepts it as this computer's name."
				>Link address</label
			>
			<input
				id="owner-link-base"
				type="url"
				placeholder={address ?? 'https://…'}
				bind:value={linkBase}
				onchange={apply}
			/>
		</div>
		{#if status?.fingerprint}
			<div class="field">
				<span class="label" title={CERT_HINT}>Certificate</span>
				<div class="row">
					<code class="value fingerprint" title="SHA-256 fingerprint">{status.fingerprint}</code>
					<button class="btn btn-small" onclick={() => copy(status!.fingerprint!, 'cert')}
						>{copied === 'cert' ? 'Copied' : 'Copy'}</button
					>
					{#if status.certificate}
						<button
							class="btn btn-small"
							title="The certificate itself (PEM), for a script to trust: save it to a file and pass it to curl --cacert."
							onclick={() => copy(status!.certificate!, 'pem')}
							>{copied === 'pem' ? 'Copied' : 'Copy certificate'}</button
						>
					{/if}
				</div>
			</div>
		{/if}
	</details>
</section>

<style>
	.fingerprint {
		overflow-wrap: anywhere;
		font-size: 0.75rem;
	}

	.block {
		margin-top: 16px;
		padding-top: 14px;
		border-top: 1px solid var(--border);
	}

	.label {
		display: block;
		font-size: 0.85rem;
		font-weight: 600;
		margin-bottom: 8px;
	}

	.label.inline {
		display: inline;
		margin: 0;
	}

	.row {
		display: flex;
		gap: 8px;
		align-items: center;
		flex-wrap: wrap;
		margin-top: 8px;
	}

	.open {
		margin-top: 12px;
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

	.made {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 12px;
		border: 1px solid var(--border);
		border-radius: 8px;
	}

	.made > button {
		align-self: flex-start;
	}

	.scope {
		display: flex;
		align-items: center;
		gap: 4px;
		font-size: 0.85rem;
	}

	.qr {
		width: 180px;
		height: 180px;
		border-radius: 6px;
		shape-rendering: crispEdges;
	}

	summary {
		cursor: pointer;
		font-size: 0.85rem;
		font-weight: 600;
	}

	details .field,
	details .toggle-row {
		margin-top: 12px;
	}

	.short {
		width: 8rem;
	}

	.error {
		color: var(--error, #b42318);
		font-size: 0.85rem;
	}
</style>
