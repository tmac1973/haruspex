<script lang="ts">
	/**
	 * Get in on another computer with a script token from it, when its Who can
	 * connect doesn't let this one in (Settings → Remote control → Other
	 * computers). The token goes to the secret store, never Settings.
	 */
	import Modal from '#lib/components/Modal.svelte';
	import ModalButton from '#lib/components/ModalButton.svelte';

	interface Props {
		/** The computer's name; the dialog is open while it's set. */
		name: string | null;
		onsave: (token: string) => void;
		oncancel: () => void;
	}

	let { name, onsave, oncancel }: Props = $props();
	let token = $state('');

	function save(): void {
		const value = token.trim();
		if (!value) return;
		token = '';
		onsave(value);
	}

	function cancel(): void {
		token = '';
		oncancel();
	}
</script>

<Modal
	open={name !== null}
	maxWidth={480}
	labelledBy="peer-token-title"
	dismissable
	onclose={cancel}
>
	<h2 id="peer-token-title">Use a token for {name}</h2>
	<label for="peer-token">
		Paste a script token from {name}'s Settings → Remote control → Add a device… → Token for a
		script.
	</label>
	<input
		id="peer-token"
		type="password"
		autocomplete="off"
		bind:value={token}
		onkeydown={(e) => e.key === 'Enter' && save()}
	/>
	<div class="button-row">
		<ModalButton variant="default" disabled={!token.trim()} onclick={save}>
			{#snippet title()}Save{/snippet}
		</ModalButton>
		<ModalButton variant="subtle" onclick={cancel}>
			{#snippet title()}Cancel{/snippet}
		</ModalButton>
	</div>
</Modal>

<style>
	label {
		display: block;
		font-size: 0.85rem;
		margin-bottom: 8px;
	}

	input {
		width: 100%;
	}

	.button-row {
		margin-top: 16px;
	}
</style>
