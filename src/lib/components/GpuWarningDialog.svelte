<script lang="ts">
	import { getSettings, updateSettings } from '$lib/stores/settings';

	interface Props {
		onclose: () => void;
	}

	let { onclose }: Props = $props();
	let dontShowAgain = $state(false);

	function dismiss() {
		if (dontShowAgain) {
			updateSettings({ dismissedGpuWarning: true });
		}
		onclose();
	}
</script>

<div class="backdrop">
	<div class="dialog">
		<h2>GPU Usage Notice</h2>
		<p>
			Haruspex uses your GPU for AI inference. While it is running, other GPU-intensive
			applications such as games may experience reduced performance.
		</p>
		<p>For the best experience, close Haruspex before launching games or other GPU-heavy programs.</p>
		<div class="footer">
			<label class="checkbox-row">
				<input type="checkbox" bind:checked={dontShowAgain} />
				Don't show this again
			</label>
			<button class="btn" onclick={dismiss}>Got it</button>
		</div>
	</div>
</div>

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.5);
		z-index: 200;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.dialog {
		width: min(420px, 90vw);
		background: var(--bg-primary);
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 24px;
	}

	h2 {
		margin: 0 0 12px 0;
		font-size: 1.1rem;
	}

	p {
		font-size: 0.9rem;
		color: var(--text-secondary);
		line-height: 1.5;
		margin: 0 0 12px 0;
	}

	.footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-top: 16px;
	}

	.checkbox-row {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 0.8rem;
		color: var(--text-secondary);
		cursor: pointer;
	}

	.checkbox-row input {
		accent-color: var(--accent);
	}

	.btn {
		padding: 8px 20px;
		border-radius: 6px;
		font-size: 0.85rem;
		cursor: pointer;
		border: none;
		background: var(--accent);
		color: white;
		font-weight: 500;
	}

	.btn:hover {
		opacity: 0.9;
	}
</style>
