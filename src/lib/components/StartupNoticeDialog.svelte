<script lang="ts">
	import Modal from './Modal.svelte';
	import { updateSettings } from '$lib/stores/settings';

	interface Props {
		onclose: () => void;
	}

	let { onclose }: Props = $props();
	let dontShowAgain = $state(false);

	function dismiss() {
		if (dontShowAgain) {
			updateSettings({ dismissedStartupNotice: true });
		}
		onclose();
	}
</script>

<!-- Deliberately NOT dismissable: this safety notice should be acknowledged
     via "Got it" (so the don't-show-again choice is recorded), not waved away
     with Esc or a backdrop click. -->
<Modal open maxWidth={420} labelledBy="startup-title">
	<h2 id="startup-title">Before you begin</h2>
	<h3>AI safety</h3>
	<p>
		Haruspex is an AI assistant, and AI models hallucinate. It can be confidently wrong, misread
		output, and suggest commands — including in the Shell tab — that are mistaken or destructive.
		The agent never runs commands on its own: anything it suggests lands at your prompt for you to
		review and run. <strong
			>You are the last line of defense — read and understand a command before you run it.</strong
		>
	</p>
	<h3>GPU usage</h3>
	<p>
		Haruspex uses your GPU for AI inference. While it is running, other GPU-intensive applications
		such as games may experience reduced performance — close Haruspex before launching games or
		other GPU-heavy programs.
	</p>
	<div class="footer">
		<label class="checkbox-row">
			<input type="checkbox" bind:checked={dontShowAgain} />
			Don't show this again
		</label>
		<button class="btn" onclick={dismiss}>Got it</button>
	</div>
</Modal>

<style>
	h3 {
		margin: 16px 0 6px 0;
		font-size: 0.95rem;
		color: var(--text-primary);
	}

	h3:first-of-type {
		margin-top: 0;
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
