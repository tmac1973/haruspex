<script lang="ts">
	/**
	 * Settings → Remote control → Other computers (plan/instance-sync/): the
	 * owner's other computers running Haruspex, found on the network or added
	 * by address, each trusted by its certificate's fingerprint. Their
	 * sessions and chats show here through their own Remote control.
	 */
	import { onMount } from 'svelte';

	import PeerTokenDialog from '#lib/components/settings/PeerTokenDialog.svelte';
	import PeerTrustDialog from '#lib/components/settings/PeerTrustDialog.svelte';
	import {
		DEFAULT_PEER_PORT,
		checkPeer,
		refusePeer,
		removePeer,
		setPeerToken,
		setPeersEnabled,
		trustPeer,
		watchPeers,
		type CheckResult,
		type FoundPeer,
		type PeerConfig,
		type PeerProbe,
		type PeerStatus
	} from '#lib/peers/service.ts';
	import { getSettings } from '#lib/stores/settings.ts';
	import { errMessage } from '#lib/utils/error.ts';

	let enabled = $state(getSettings().peersEnabled);
	let peers = $state<PeerConfig[]>(getSettings().peers);
	let refused = $state<string[]>(getSettings().refusedPeers);
	let found = $state<FoundPeer[]>([]);
	let statuses = $state<Record<string, PeerStatus>>({});

	let error = $state<string | null>(null);
	let note = $state<string | null>(null);
	let busy = $state(false);

	let adding = $state(false);
	let address = $state('');
	let port = $state(DEFAULT_PEER_PORT);

	/** The computer the trust dialog asks about, and its old pin if it changed. */
	let asking = $state<{ probe: PeerProbe; pinned: string | null } | null>(null);
	let tokenFor = $state<PeerConfig | null>(null);

	const offered = $derived(
		found.filter(
			(f) => !peers.some((p) => p.instanceId === f.instanceId) && !refused.includes(f.instanceId)
		)
	);

	function reload(): void {
		const s = getSettings();
		peers = s.peers;
		refused = s.refusedPeers;
	}

	/** Run one action: busy while it runs, its error shown, Settings re-read after. */
	async function run(action: () => Promise<void>): Promise<void> {
		busy = true;
		error = null;
		note = null;
		try {
			await action();
		} catch (e) {
			error = errMessage(e);
		} finally {
			reload();
			busy = false;
		}
	}

	function show(result: CheckResult): void {
		if (result.kind === 'new') asking = { probe: result.probe, pinned: null };
		else if (result.kind === 'changed')
			asking = { probe: result.probe, pinned: result.peer.fingerprint };
		else note = `${result.peer.name} is already trusted; its address is updated.`;
	}

	function toggle(on: boolean): void {
		enabled = on;
		if (!on) statuses = {};
		void run(() => setPeersEnabled(on));
	}

	function connect(peer: FoundPeer): void {
		void run(async () => show(await checkPeer(peer.addresses, peer.port)));
	}

	function add(): void {
		const target = address.trim();
		if (!target) return;
		void run(async () => {
			show(await checkPeer([target], port));
			adding = false;
			address = '';
			port = DEFAULT_PEER_PORT;
		});
	}

	function checkAgain(peer: PeerConfig): void {
		void run(async () => show(await checkPeer([peer.address], peer.port)));
	}

	function trust(): void {
		const probe = asking!.probe;
		asking = null;
		void run(() => trustPeer(probe));
	}

	function refuse(): void {
		const { probe, pinned } = asking!;
		asking = null;
		// A changed certificate left untrusted keeps the old pin: never contacted.
		if (!pinned) {
			refusePeer(probe.instanceId);
			reload();
		}
	}

	function saveToken(token: string): void {
		const peer = tokenFor!;
		tokenFor = null;
		void run(() => setPeerToken(peer.instanceId, token));
	}

	function remove(peer: PeerConfig): void {
		void run(() => removePeer(peer.instanceId));
	}

	const LABELS: Record<PeerStatus['connection'], string> = {
		open: 'Connected',
		connecting: 'Connecting',
		offline: 'Offline',
		notLetIn: 'Not letting this computer in',
		certificateChanged: 'Certificate changed'
	};

	function notLetInHint(name: string): string {
		return `On ${name}: Settings → Remote control → Who can connect → add this computer under These computers, or use a token. My whole network doesn't cover tailnet addresses.`;
	}

	onMount(() => {
		let stop: (() => void) | null = null;
		let gone = false;
		void watchPeers({
			found: (list) => (found = list),
			status: (s) => (statuses = { ...statuses, [s.peerId]: s })
		})
			.then((unlisten) => (gone ? unlisten() : (stop = unlisten)))
			.catch((e: unknown) => console.warn('Other computers:', e));
		return () => {
			gone = true;
			stop?.();
		};
	});
</script>

<div class="other-computers">
	<span class="label">Other computers</span>
	<label
		class="toggle-row"
		title="Lists the sessions and chats of your other computers running Haruspex, through their Remote control. They keep running there."
	>
		<input
			type="checkbox"
			checked={enabled}
			onchange={(e) => toggle(e.currentTarget.checked)}
			disabled={busy}
		/>
		<span>Show my other computers here</span>
	</label>

	{#if error}
		<p class="error" role="alert">{error}</p>
	{/if}
	{#if note}
		<p class="note" role="status">{note}</p>
	{/if}

	{#if enabled && offered.length > 0}
		<span
			class="sublabel"
			title="Computers on this network whose Remote control listens on all networks."
		>
			Found on your network
		</span>
		<ul class="list">
			{#each offered as peer (peer.instanceId)}
				<li>
					<span class="name">{peer.name}</span>
					<span class="meta">v{peer.version}</span>
					<button class="btn btn-small" disabled={busy} onclick={() => connect(peer)}>
						Connect…
					</button>
				</li>
			{/each}
		</ul>
	{/if}

	{#if peers.length > 0}
		<span class="sublabel">Your computers</span>
		<ul class="list">
			{#each peers as peer (peer.instanceId)}
				{@const connection = enabled ? statuses[peer.instanceId]?.connection : undefined}
				<li>
					<span class="name" title="{peer.address}:{peer.port}">{peer.name}</span>
					<span
						class="meta"
						title={connection === 'notLetIn' ? notLetInHint(peer.name) : undefined}
					>
						{connection ? LABELS[connection] : ''}
					</span>
					{#if connection === 'notLetIn'}
						<button
							class="btn btn-small"
							title={notLetInHint(peer.name)}
							onclick={() => (tokenFor = peer)}
						>
							Use a token…
						</button>
					{:else if connection === 'certificateChanged'}
						<button
							class="btn btn-small"
							title="A computer makes a new certificate when its old one nears expiry and when its names change. Check the new fingerprint before trusting it."
							disabled={busy}
							onclick={() => checkAgain(peer)}
						>
							Check again…
						</button>
					{/if}
					<button
						class="btn btn-small btn-danger"
						title="Stop showing this computer here and forget its token."
						disabled={busy}
						onclick={() => remove(peer)}
					>
						Remove
					</button>
				</li>
			{/each}
		</ul>
	{/if}

	{#if adding}
		<form
			class="add"
			onsubmit={(e) => {
				e.preventDefault();
				add();
			}}
		>
			<div class="field">
				<label
					for="peer-address"
					title="Its name on your network or its IP address, as you'd reach it from here."
				>
					Name or address
				</label>
				<input id="peer-address" placeholder="e.g. desk-pc" bind:value={address} />
			</div>
			<div class="field">
				<label for="peer-port" title="Its Settings → Remote control → Advanced → Port.">Port</label>
				<input id="peer-port" class="short" type="number" min="1" max="65535" bind:value={port} />
			</div>
			<div class="row">
				<button class="btn btn-small btn-primary" type="submit" disabled={busy || !address.trim()}>
					Connect…
				</button>
				<button class="btn btn-small" type="button" onclick={() => (adding = false)}>Cancel</button>
			</div>
		</form>
	{:else}
		<button
			class="btn btn-small"
			title="A computer that isn't found on your network, by its name or address."
			onclick={() => (adding = true)}
		>
			Add a computer…
		</button>
	{/if}
</div>

<PeerTrustDialog
	probe={asking?.probe ?? null}
	pinned={asking?.pinned ?? null}
	ontrust={trust}
	onrefuse={refuse}
	oncancel={() => (asking = null)}
/>
<PeerTokenDialog
	name={tokenFor?.name ?? null}
	onsave={saveToken}
	oncancel={() => (tokenFor = null)}
/>

<style>
	.label {
		display: block;
		font-size: 0.85rem;
		font-weight: 600;
		margin-bottom: 8px;
	}

	.sublabel {
		display: block;
		margin-top: 12px;
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--text-secondary);
	}

	.list {
		list-style: none;
		margin: 6px 0 10px;
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

	.add {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin-top: 8px;
		padding: 12px;
		border: 1px solid var(--border);
		border-radius: 8px;
	}

	.row {
		display: flex;
		gap: 8px;
	}

	.short {
		width: 8rem;
	}

	.error {
		color: var(--error, #b42318);
		font-size: 0.85rem;
	}

	.note {
		font-size: 0.85rem;
		color: var(--text-secondary);
	}
</style>
