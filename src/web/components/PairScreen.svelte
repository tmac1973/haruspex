<script lang="ts">
	/** Shown until this browser is paired: the link does it, a pasted code also works. */
	let { error, onpair }: { error: string | null; onpair: (code: string) => void } = $props();
	let code = $state('');
</script>

<div class="pair">
	<h1>Haruspex</h1>
	<p
		title="Or, on the computer running Haruspex, add this computer under Settings → Remote control → These computers, or allow your whole network."
	>
		Open this device's link from Settings → Remote control, or paste its code.
	</p>
	<form
		onsubmit={(e) => {
			e.preventDefault();
			if (code.trim()) onpair(code.trim());
		}}
	>
		<input aria-label="Pairing code" placeholder="Pairing code" bind:value={code} />
		<button class="btn btn-primary" type="submit" disabled={!code.trim()}>Pair</button>
	</form>
	{#if error}
		<p class="error-text" role="alert">{error}</p>
	{/if}
</div>

<style>
	.pair {
		max-width: 28rem;
		margin: 18vh auto 0;
		padding: 0 20px;
		grid-column: 1 / -1;
	}

	h1 {
		font-size: 1.4rem;
	}

	p {
		color: var(--text-secondary);
		line-height: 1.5;
	}

	form {
		display: flex;
		gap: 8px;
	}

	input {
		flex: 1;
		min-width: 0;
		padding: 8px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-input);
		color: var(--text-primary);
	}
</style>
