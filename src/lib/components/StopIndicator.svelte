<script lang="ts">
	/**
	 * Shown under an assistant message when the SYSTEM forced the turn to end
	 * (hit the turn-count cap, or broke on degraded output) rather than the
	 * model finishing on its own — so the user can tell "it was interrupted"
	 * apart from "it gave up", and resume with one click.
	 */
	import type { AgentStopReason } from '$lib/agent/loop';

	interface Props {
		reason: AgentStopReason;
		disabled?: boolean;
		onContinue: () => void;
	}

	let { reason, disabled = false, onContinue }: Props = $props();

	const text = $derived(
		reason === 'max_iterations'
			? 'Stopped at the turn limit — the agent ran out of steps and was told to wrap up, so this answer may be incomplete.'
			: 'Stopped early — the agent produced malformed output or kept repeating the same action.'
	);
</script>

<div class="stop-indicator">
	<span class="stop-text">⏸ {text}</span>
	<button class="continue-btn" {disabled} onclick={onContinue}>Continue</button>
</div>

<style>
	.stop-indicator {
		display: flex;
		align-items: center;
		gap: 10px;
		margin: 6px 16px 10px;
		padding: 8px 12px;
		border: 1px solid var(--border);
		border-left: 3px solid var(--accent);
		border-radius: 6px;
		background: var(--bg-secondary);
		font-size: 0.82rem;
		color: var(--text-secondary);
	}
	.stop-text {
		flex: 1;
		line-height: 1.4;
	}
	.continue-btn {
		flex-shrink: 0;
		padding: 4px 12px;
		border-radius: 6px;
		border: 1px solid var(--accent);
		background: var(--accent);
		color: white;
		font-size: 0.8rem;
		cursor: pointer;
	}
	.continue-btn:hover:not(:disabled) {
		opacity: 0.9;
	}
	.continue-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
