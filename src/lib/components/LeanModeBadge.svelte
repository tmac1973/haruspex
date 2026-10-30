<script lang="ts">
	/**
	 * The header's reminder that lean mode is on (Settings → General → Lean
	 * mode). It opens Settings at the switch, so turning it off is one click
	 * away from wherever the user noticed something missing. A dot says the
	 * model now in use can run the full app (`lean/nudges.ts`), once.
	 */
	import { getLiveSettings, markLeanHinted } from '#lib/stores/settings.ts';
	import { openSettings } from '#lib/stores/settingsNav.svelte.ts';
	import { activeModelId } from '#lib/lean/recommend.ts';
	import { shouldHintFull } from '#lib/lean/nudges.ts';

	const settings = $derived(getLiveSettings());
	const modelId = $derived(activeModelId(settings));
	const hint = $derived(shouldHintFull(modelId, settings));

	function open() {
		if (hint) markLeanHinted(modelId);
		openSettings('general', 'lean-mode');
	}
</script>

{#if settings.leanMode}
	<button
		class="lean-badge"
		title={hint
			? 'This model can run the full app. Click to change.'
			: 'Fewer tools and tabs for small models. Click to change.'}
		onclick={open}
	>
		{#if hint}<span class="dot" aria-hidden="true"></span>{/if}
		Lean mode
	</button>
{/if}

<style>
	.lean-badge {
		display: inline-flex;
		align-items: center;
		gap: 6px;
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

	.dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--accent);
		box-shadow: 0 0 4px color-mix(in srgb, var(--accent) 60%, transparent);
	}
</style>
