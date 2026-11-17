<script lang="ts">
	/**
	 * Trust another computer (Settings → Remote control → Other computers):
	 * its certificate's fingerprint, to check by eye against that computer's
	 * own Settings. For a computer whose certificate changed, the pinned one
	 * is shown too.
	 */
	import Modal from '#lib/components/Modal.svelte';
	import ModalButton from '#lib/components/ModalButton.svelte';
	import { groupFingerprint, type PeerProbe } from '#lib/peers/service.ts';

	interface Props {
		probe: PeerProbe | null;
		/** The fingerprint already trusted, when the certificate changed. */
		pinned?: string | null;
		ontrust: () => void;
		onrefuse: () => void;
		/** Esc or a click outside: closed, nothing decided. */
		oncancel: () => void;
	}

	let { probe, pinned = null, ontrust, onrefuse, oncancel }: Props = $props();
</script>

<Modal
	open={probe !== null}
	maxWidth={480}
	labelledBy="peer-trust-title"
	dismissable
	onclose={oncancel}
>
	{#if probe}
		<h2 id="peer-trust-title">
			{pinned ? `${probe.name}'s certificate changed` : `Trust ${probe.name}?`}
		</h2>
		<p>Check it matches Settings → Remote control → Advanced → Certificate on {probe.name}.</p>
		{#if pinned}
			<span class="label">Trusted before</span>
			<code class="fingerprint" aria-label="Trusted before">
				{#each groupFingerprint(pinned) as group, i (i)}<span>{group}</span>{/each}
			</code>
			<span class="label">Now</span>
		{/if}
		<code class="fingerprint" aria-label={pinned ? 'Now' : 'Fingerprint'}>
			{#each groupFingerprint(probe.fingerprint) as group, i (i)}<span>{group}</span>{/each}
		</code>
		<div class="button-row">
			<ModalButton variant="default" onclick={ontrust}>
				{#snippet title()}Trust{/snippet}
			</ModalButton>
			<ModalButton variant="subtle" autofocus onclick={onrefuse}>
				{#snippet title()}Don't trust{/snippet}
			</ModalButton>
		</div>
	{/if}
</Modal>

<style>
	.label {
		display: block;
		margin-top: 12px;
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--text-secondary);
	}

	.fingerprint {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 12px;
		margin-top: 6px;
		padding: 8px 10px;
		border-radius: 6px;
		background: var(--bg-secondary);
		font-size: 0.8rem;
	}

	.button-row {
		margin-top: 16px;
	}
</style>
