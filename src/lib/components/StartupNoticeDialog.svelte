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
		Haruspex is an AI assistant, and AI models hallucinate — it can be confidently wrong, misread
		output, and run or suggest commands that are mistaken or destructive. By default it only
		<em>suggests</em> commands, which land at your prompt for you to review and run. In the Shell
		assistant's <strong>Code mode</strong>, the agent runs commands itself in your terminal: ones
		the risk classifier flags (sudo, deletes, pipes to a shell) ask for approval first, but others
		run automatically — and that prompt can be turned off in Settings.
		<strong
			>You are the last line of defense — only enable Code mode on machines and projects you're
			willing to let it act on, and read what it runs.</strong
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
		<button class="btn btn-primary" onclick={dismiss}>Got it</button>
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
</style>
