<script lang="ts">
	import { onMount, onDestroy } from 'svelte';

	import { getSettings, updateSettings } from '$lib/stores/settings';
	import {
		disconnectRemoteSession,
		generateRemoteToken,
		getLanAddress,
		getLinkQr,
		getRemoteStatus,
		listRemoteSessions,
		qrPath,
		remoteLink,
		type QrMatrix,
		type RemoteSession,
		type RemoteStatus
	} from '$lib/remote/api';
	import { syncRemoteServer } from '$lib/remote/service';
	import {
		forgetRemoteActivity,
		getRemoteActivity,
		type RemoteActivity
	} from '$lib/remote/activity.svelte';

	let enabled = $state(getSettings().remoteAccessEnabled);
	let port = $state(getSettings().remoteAccessPort);
	let token = $state(getSettings().remoteAccessToken);

	let status = $state<RemoteStatus | null>(null);
	let address = $state<string | null>(null);
	let qr = $state<QrMatrix | null>(null);
	let sessions = $state<RemoteSession[]>([]);
	let error = $state<string | null>(null);
	let copied = $state(false);
	let busy = $state(false);

	const activity = $derived(getRemoteActivity());
	const link = $derived(address && status?.running ? remoteLink(address, port, token) : null);

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
		} catch (e) {
			error = String(e);
		}
	}

	async function refreshLink() {
		address = await getLanAddress().catch(() => null);
		qr = null;
		if (!address || !status?.running || !token) return;
		try {
			qr = await getLinkQr(remoteLink(address, port, token));
		} catch {
			// A missing QR is a missing convenience, not a broken feature: the
			// link is still on screen and still copyable.
			qr = null;
		}
	}

	async function apply() {
		busy = true;
		error = null;
		try {
			updateSettings({
				remoteAccessEnabled: enabled,
				remoteAccessPort: port,
				remoteAccessToken: token
			});
			const result = await syncRemoteServer();
			if (enabled && !result?.running) {
				error = `Could not start on port ${port}. Another program may already be using it.`;
			}
			// The token is minted on first enable, so read back what was stored.
			token = getSettings().remoteAccessToken;
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

	async function rotate() {
		// Everyone holding the old link is cut off, which is the point: this is
		// revocation, and there is nothing else to revoke.
		token = generateRemoteToken();
		forgetRemoteActivity();
		await apply();
	}

	async function copyLink() {
		if (!link) return;
		try {
			await navigator.clipboard.writeText(link);
			copied = true;
			setTimeout(() => (copied = false), 1500);
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

	onMount(async () => {
		await refresh();
		await refreshLink();
		timer = setInterval(refresh, POLL_MS);
	});

	onDestroy(() => {
		if (timer) clearInterval(timer);
	});
</script>

<section class="settings-section">
	<h3>Remote access</h3>

	<label class="toggle-row">
		<input type="checkbox" bind:checked={enabled} onchange={toggle} disabled={busy} />
		<span>Let people on your network chat with this Haruspex</span>
	</label>

	<!-- Said next to the switch, not buried: someone who reads this and
	     proceeds has consented to what is actually happening. A checkbox
	     labelled "enable remote access" would not have told them any of it. -->
	<p class="help">
		Anyone on your network who has the link can chat with your Haruspex, using your computer's GPU.
		Their conversations are saved here and appear in your sidebar. Traffic is not encrypted, so use
		this on networks you trust.
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

	{#if enabled && status?.running}
		<div class="link-block">
			<span class="label">The link to share</span>
			{#if link}
				<div class="link-row">
					<code class="link">{link}</code>
					<button onclick={copyLink}>{copied ? 'Copied' : 'Copy'}</button>
				</div>
				{#if qr}
					<!-- The guest is holding a phone and the token is 32
					     characters of noise. Typing it by hand is the step
					     where this would lose them. -->
					<svg
						class="qr"
						viewBox="-2 -2 {qr.size + 4} {qr.size + 4}"
						role="img"
						aria-label="QR code for the sharing link"
					>
						<rect x="-2" y="-2" width={qr.size + 4} height={qr.size + 4} fill="#fff" />
						<path d={qrPath(qr)} fill="#000" />
					</svg>
				{/if}
			{:else}
				<p class="help">
					This computer has no network address right now, so there is no link to share. It is
					probably offline or on a network that does not route between devices.
				</p>
			{/if}
			<button class="rotate" onclick={rotate} disabled={busy}>
				Rotate link (cuts off everyone using the old one)
			</button>
		</div>

		<div class="guests">
			<span class="label">
				{sessions.length === 0 ? 'Nobody connected' : `${sessions.length} connected`}
			</span>

			{#each activity as entry (entry.sessionId)}
				<div class="guest">
					<div class="guest-head">
						<strong>{guestName(entry)}</strong>
						<span class="state" class:live={entry.state === 'answering'}>
							{entry.state === 'waiting'
								? 'waiting for a slot'
								: entry.state === 'answering'
									? 'answering'
									: entry.state === 'failed'
										? 'failed'
										: 'idle'}
						</span>
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
