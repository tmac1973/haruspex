<script lang="ts">
	/**
	 * The header's reminder that lean mode is on (Settings → General → Lean
	 * mode). It opens Settings at the switch, so turning it off is one click
	 * away from wherever the user noticed something missing.
	 */
	import { getLiveSettings } from '#lib/stores/settings.ts';
	import { openSettings } from '#lib/stores/settingsNav.svelte.ts';
</script>

{#if getLiveSettings().leanMode}
	<button
		class="lean-badge"
		title="Fewer tools and tabs for small models. Click to change."
		onclick={() => openSettings('general', 'lean-mode')}
	>
		Lean mode
	</button>
{/if}

<style>
	.lean-badge {
		display: inline-flex;
		align-items: center;
		padding: 4px 10px;
		border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
		border-radius: 12px;
		font-family: inherit;
		font-size: 0.8rem;
		font-weight: 500;
		color: var(--accent);
		background: color-mix(in srgb, var(--accent) 10%, var(--bg-secondary));
		cursor: pointer;
		white-space: nowrap;
	}

	.lean-badge:hover {
		background: color-mix(in srgb, var(--accent) 18%, var(--bg-secondary));
	}
</style>
