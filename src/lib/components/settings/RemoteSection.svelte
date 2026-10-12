<script lang="ts">
	import { onMount, onDestroy } from 'svelte';

	import { getSettings, updateSettings } from '#lib/stores/settings.ts';
	import {
		disconnectRemoteSession,
		generateRemoteToken,
		getLanAddress,
		getLinkQr,
		getRemoteStatus,
		listRemoteSessions,
		qrPath,
		remoteLink,
		remoteTrustedHosts,
		type QrMatrix,
		type RemoteSession,
		type RemoteStatus
	} from '#lib/remote/api.ts';
	import { syncRemoteServer } from '#lib/remote/service.ts';
	import { getRemoteToken, remoteToken } from '#lib/stores/remoteSecrets.ts';
	import {
		forgetRemoteActivity,
		getRemoteActivity,
		type RemoteActivity
	} from '#lib/remote/activity.svelte.ts';
	import type { AccessMode } from '#lib/ipc/gen/AccessMode.ts';
	import type { TrustedHost } from '#lib/ipc/gen/TrustedHost.ts';
	import WhoCanConnect from '#lib/components/settings/WhoCanConnect.svelte';

	const MODES: { value: AccessMode; label: string; title: string }[] = [
		{
			value: 'tokens',
			label: 'People with the link',
			title: 'Only someone you give the link (or its QR code) to can chat.'
		},
		{
			value: 'trusted',
			label: 'These computers',
			title:
				'The computers and phones you list chat without the link, by name or IP address. Names are looked up on your network, so a changed address still works. The link still works too.'
		},
		{
			value: 'lan',
			label: 'My whole network',
			title:
				'Any device on your local network (192.168.x.x, 10.x.x.x, …) chats without the link. Only for a network you trust. The link still works too.'
		}
	];

	let enabled = $state(getSettings().remoteAccessEnabled);
	let port = $state(getSettings().remoteAccessPort);
	let mode = $state<AccessMode>(getSettings().remoteAccessMode);
	let trustedHosts = $state<string[]>([...getSettings().remoteAccessTrustedHosts]);
	let found = $state<TrustedHost[]>([]);
	/** Read back from the secret store on mount; needed for the link and QR. */
	let token = $state('');

	let status = $state<RemoteStatus | null>(null);
	let address = $state<string | null>(null);
	let qr = $state<QrMatrix | null>(null);
	/** The page without the link, for a device let in without it. */
	let pageQr = $state<QrMatrix | null>(null);
	/** Link for other devices is open: its QR replaces the page's, so a phone
	 *  pointed at the screen never sees two codes. */
	let showLink = $state(false);
	let sessions = $state<RemoteSession[]>([]);
	let error = $state<string | null>(null);
	let copied = $state<string | null>(null);
	let busy = $state(false);

	const activity = $derived(getRemoteActivity());
	const link = $derived(address && status?.running ? remoteLink(address, port, token) : null);
	/** The page without the link's secret, for a device let in without it. */
	const pageUrl = $derived(address && status?.running ? `https://${address}:${port}/` : null);
	/** Said next to the switch, so it matches who can actually get in. */
	const consent = $derived(
		mode === 'lan'
			? "Anyone on your network can chat with your Haruspex, using your computer's GPU."
			: mode === 'trusted'
				? "The computers you list, and anyone on your network who has the link, can chat with your Haruspex, using your computer's GPU."
				: "Anyone on your network who has the link can chat with your Haruspex, using your computer's GPU."
	);

	/**
	 * Connected-guest state lives in Rust and changes without telling us — a tab
	 * closing is not an event this window sees. Polled while the section is open
	 * and only while it is open; the cost is a map walk over at most eight
	 * entries.
	 */
	const POLL_MS = 3000;
	let timer: ReturnType<typeof setInterval> | null = null;

	async function refresh() {
		try {
			status = await getRemoteStatus();
			sessions = status.running ? await listRemoteSessions() : [];
			found = mode === 'trusted' ? await remoteTrustedHosts() : [];
		} catch (e) {
			error = String(e);
		}
	}

	async function refreshLink() {
		address = await getLanAddress().catch(() => null);
		qr = null;
		pageQr = null;
		if (!address || !status?.running || !token) return;
		// A missing QR is a missing convenience, not a broken feature: the
		// link is still on screen and still copyable.
		qr = await getLinkQr(remoteLink(address, port, token)).catch(() => null);
		pageQr = await getLinkQr(`https://${address}:${port}/`).catch(() => null);
	}

	async function apply() {
		busy = true;
		error = null;
		try {
			// A rotated token is stored before the server restarts with it.
			if (token && token !== (await getRemoteToken())) await remoteToken.save(token);
			updateSettings({
				remoteAccessEnabled: enabled,
				remoteAccessPort: port,
				remoteAccessMode: mode,
				remoteAccessTrustedHosts: [...trustedHosts]
			});
			const result = await syncRemoteServer();
			if (enabled && !result?.running) {
				error = `Could not start on port ${port}. Another program may already be using it.`;
			}
			// The token is minted on first enable, so read back what was stored.
			token = await getRemoteToken();
			await refresh();
			await refreshLink();
		} finally {
			busy = false;
		}
	}

	async function toggle() {
		if (!enabled) forgetRemoteActivity();
		await apply();
	}

	function setMode(next: AccessMode) {
		mode = next;
		void apply();
	}

	function setHosts(next: string[]) {
		trustedHosts = next;
		void apply();
	}

	async function rotate() {
		// Everyone holding the old link is cut off, which is the point: this is
		// revocation, and there is nothing else to revoke.
		token = generateRemoteToken();
		forgetRemoteActivity();
		await apply();
	}

	async function copy(text: string | null, what: string) {
		if (!text) return;
		try {
			await navigator.clipboard.writeText(text);
			copied = what;
			setTimeout(() => (copied = copied === what ? null : copied), 1500);
		} catch {
			error = 'Could not copy — select the link and copy it by hand.';
		}
	}

	async function disconnect(sessionId: string) {
		await disconnectRemoteSession(sessionId).catch(() => {});
		forgetRemoteActivity(sessionId);
		await refresh();
	}

	function guestName(entry: RemoteActivity): string {
		return entry.label || 'Guest';
	}

	function stateLabel(state: RemoteActivity['state']): string {
		switch (state) {
			case 'waiting':
				return 'waiting for a slot';
			// A reasoning model spends most of a turn here, which is why it is
			// not folded into "waiting".
			case 'thinking':
				return 'thinking';
			case 'answering':
				return 'answering';
			case 'failed':
				return 'failed';
			default:
				return 'idle';
		}
	}

	function isLive(entry: RemoteActivity): boolean {
		return entry.state === 'thinking' || entry.state === 'answering';
	}

	onMount(async () => {
		token = await getRemoteToken();
		await refresh();
		await refreshLink();
		timer = setInterval(refresh, POLL_MS);
	});

	onDestroy(() => {
		if (timer) clearInterval(timer);
	});
</script>

<section class="settings-section">
	<h3>Guest chat</h3>

	<label class="toggle-row">
		<input type="checkbox" bind:checked={enabled} onchange={toggle} disabled={busy} />
		<span>Let people on your network chat with this Haruspex</span>
	</label>

	<!-- Said next to the switch, not buried: someone who reads this and
	     proceeds has consented to what is actually happening. A checkbox
	     labelled "enable remote access" would not have told them any of it. -->
	<p class="help">
		{consent} Their conversations are saved here and appear in your sidebar. Use this on networks you
		trust.
	</p>
	<p class="help">
		Windows will ask whether to allow Haruspex on your network the first time you turn this on — say
		yes, or nobody can connect.
	</p>

	{#if error}
		<p class="error">{error}</p>
	{/if}

	<div class="field">
		<label for="remote-port">Port</label>
		<input
			id="remote-port"
			type="number"
			min="1024"
			max="65535"
			bind:value={port}
			onchange={apply}
			disabled={busy}
		/>
	</div>

	<div class="who">
		<WhoCanConnect
			modes={MODES}
			{mode}
			hosts={trustedHosts}
			{found}
			onmode={setMode}
			onhosts={setHosts}
		/>
	</div>

	{#snippet share(url: string, what: string, code: QrMatrix | null)}
		<div class="link-row">
			<code class="link">{url}</code>
			<button onclick={() => copy(url, what)}>{copied === what ? 'Copied' : 'Copy'}</button>
		</div>
		{#if code}
			<!-- The guest is holding a phone, and the link's token is 32
			     characters of noise. Typing it by hand is the step where
			     this would lose them. -->
			<svg
				class="qr"
				viewBox="-2 -2 {code.size + 4} {code.size + 4}"
				role="img"
				aria-label="QR code for {url}"
			>
				<rect x="-2" y="-2" width={code.size + 4} height={code.size + 4} fill="#fff" />
				<path d={qrPath(code)} fill="#000" />
			</svg>
		{/if}
	{/snippet}

	{#snippet rotateButton()}
		<button class="rotate" onclick={rotate} disabled={busy}>
			Rotate link (cuts off everyone using the old one)
		</button>
	{/snippet}

	{#if enabled && status?.running}
		<div class="link-block">
			{#if !link || !pageUrl}
				<p class="help">
					This computer has no network address right now, so there is no link to share. It is
					probably offline or on a network that does not route between devices.
				</p>
			{:else if mode === 'tokens'}
				<span class="label">The link to share</span>
				{@render share(link, 'link', qr)}
			{:else}
				<span
					class="label"
					title="Open this in a browser on a device allowed above. No link needed. The browser warns about the certificate the first time; continue if the fingerprint matches Certificate below."
					>Open on the other device</span
				>
				{@render share(pageUrl, 'page', showLink ? null : pageQr)}
				<details class="other" bind:open={showLink}>
					<summary title="For a device not allowed above. It works in every mode."
						>Link for other devices</summary
					>
					{@render share(link, 'link', qr)}
					{@render rotateButton()}
				</details>
			{/if}
			{#if status.fingerprint}
				<div class="cert">
					<span
						class="label"
						title="Haruspex made its own certificate, so a guest's browser warns the first time. They can continue if the fingerprint it shows matches this one."
						>Certificate</span
					>
					<code class="fingerprint" title="SHA-256 fingerprint">{status.fingerprint}</code>
				</div>
			{/if}
			{#if mode === 'tokens'}
				{@render rotateButton()}
			{/if}
		</div>

		<div class="guests">
			<span class="label">
				{sessions.length === 0 ? 'Nobody connected' : `${sessions.length} connected`}
			</span>

			{#each activity as entry (entry.sessionId)}
				<div class="guest">
					<div class="guest-head">
						<strong>{guestName(entry)}</strong>
						<span class="state" class:live={isLive(entry)}>{stateLabel(entry.state)}</span>
						<button class="kick" onclick={() => disconnect(entry.sessionId)}>Disconnect</button>
					</div>
					<p class="prompt">{entry.prompt}</p>
					{#if entry.answer}
						<p class="answer">{entry.answer}</p>
					{/if}
				</div>
			{/each}

			{#if activity.length === 0 && sessions.length > 0}
				<p class="help">Connected, but nobody has asked anything yet.</p>
			{/if}
			<p class="help">
				The full conversation is in your sidebar, named after the guest — this panel is just what is
				happening right now.
			</p>
		</div>
	{/if}
</section>

<style>
	/* Matches the other settings sections, which each carry their own copy —
	   `.settings-section` and `.toggle-row` are global, `.help` is not. */
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

	.cert {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.fingerprint {
		overflow-wrap: anywhere;
		font-size: 0.75rem;
	}

	.who {
		margin-top: 12px;
	}

	.other {
		margin: 12px 0;
	}

	.other summary {
		cursor: pointer;
		font-size: 0.85rem;
		font-weight: 600;
	}

	.other .link-row {
		margin-top: 8px;
	}

	.other .qr,
	.other .rotate {
		display: block;
	}

	.link-block,
	.guests {
		margin-top: 16px;
		padding-top: 14px;
		border-top: 1px solid var(--border);
	}

	.link-row {
		display: flex;
		gap: 8px;
		align-items: center;
		flex-wrap: wrap;
	}

	.link {
		flex: 1;
		min-width: 12rem;
		padding: 6px 8px;
		border-radius: 6px;
		background: var(--bg-secondary);
		overflow-wrap: anywhere;
		font-size: 0.85rem;
	}

	.qr {
		width: 180px;
		height: 180px;
		margin-top: 12px;
		border-radius: 6px;
		shape-rendering: crispEdges;
	}

	.rotate {
		margin-top: 12px;
	}

	.guest {
		margin-bottom: 12px;
		padding: 10px;
		border: 1px solid var(--border);
		border-radius: 8px;
	}

	.guest-head {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.state {
		font-size: 0.8rem;
		color: var(--text-secondary);
	}

	.state.live {
		color: var(--accent);
	}

	.kick {
		margin-left: auto;
	}

	.prompt {
		margin: 8px 0 4px;
		font-size: 0.9rem;
	}

	.answer {
		margin: 0;
		font-size: 0.85rem;
		color: var(--text-secondary);
		max-height: 7rem;
		overflow-y: auto;
		white-space: pre-wrap;
	}

	.error {
		color: var(--error, #b42318);
		font-size: 0.85rem;
	}
</style>
