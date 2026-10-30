<script lang="ts">
	/**
	 * The one-time offer of lean mode to someone who never saw the setup
	 * wizard's Lean or Full step (`lean/nudges.ts`). Every way out of it
	 * marks the offer made.
	 */
	import { updateSettings } from '#lib/stores/settings.ts';
	import { codeOrShellBusy, LEAN_BUSY_TITLE } from '#lib/lean/busy.ts';
	import { turnLeanMode } from '#lib/lean/nudges.ts';

	let { onclose }: { onclose: () => void } = $props();

	const busy = $derived(codeOrShellBusy());

	function close(turnOn: boolean) {
		if (turnOn) turnLeanMode(true);
		updateSettings({ leanNoticeShown: true });
		onclose();
	}
</script>

<div class="lean-notice" role="dialog" aria-labelledby="lean-notice-text">
	<p
		id="lean-notice-text"
		title="Sends far fewer tools and hides the Code and Shell tabs. Change it any time in Settings → General → Lean mode."
	>
		Lean mode keeps Haruspex to chat and research, which suits this model.
	</p>
	<div class="actions">
		<button class="btn" onclick={() => close(false)}>Not now</button>
		<button
			class="btn btn-primary"
			disabled={busy}
			title={busy ? LEAN_BUSY_TITLE : undefined}
			onclick={() => close(true)}>Turn on</button
		>
	</div>
	<button class="dismiss" aria-label="Close" onclick={() => close(false)}>×</button>
</div>

<style>
	/* Bottom left: the toasts own the bottom right. */
	.lean-notice {
		position: fixed;
		left: 16px;
		bottom: 16px;
		z-index: 1100;
		max-width: 340px;
		padding: 12px 32px 12px 14px;
		background: var(--bg-primary);
		border: 1px solid var(--border);
		border-left: 3px solid var(--accent);
		border-radius: 8px;
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
		font-size: 0.85rem;
		color: var(--text-primary);
	}

	p {
		margin: 0 0 10px;
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}

	.dismiss {
		position: absolute;
		top: 4px;
		right: 6px;
		border: none;
		background: none;
		color: var(--text-secondary);
		font-size: 1rem;
		cursor: pointer;
	}
</style>
