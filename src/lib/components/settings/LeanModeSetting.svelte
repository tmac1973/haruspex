<script lang="ts">
	/**
	 * Settings → General → Lean mode: the switch, and what it turns off. The
	 * header's Lean mode badge opens Settings here (`#lean-mode`).
	 */
	import { getLiveSettings } from '#lib/stores/settings.ts';
	import { codeOrShellBusy, LEAN_BUSY_TITLE } from '#lib/lean/busy.ts';
	import { turnLeanMode } from '#lib/lean/nudges.ts';
	import { pausedIntegrations } from '#lib/lean/pausedIntegrations.ts';

	const on = $derived(getLiveSettings().leanMode);
	const blocked = $derived(!on && codeOrShellBusy());
	const paused = $derived(on ? pausedIntegrations() : []);
</script>

<section class="settings-section" id="lean-mode">
	<h2>Lean mode</h2>
	<label
		class="toggle-row"
		title={blocked
			? LEAN_BUSY_TITLE
			: 'Sends a much smaller tool list, so replies start sooner and leave more room in the context window.'}
	>
		<input
			type="checkbox"
			checked={on}
			disabled={blocked}
			onchange={(e) => turnLeanMode(e.currentTarget.checked)}
		/>
		<span>Chat and research only, for small models and slow machines</span>
	</label>
	{#if on}
		<p class="hint off-label">Off in lean mode:</p>
		<ul class="off-list">
			<li>The Code and Shell tabs</li>
			<li>Job types other than Research</li>
			<li>File writing, skill writing and speech generation</li>
			{#each paused as name (name)}
				<li>{name}</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.off-label {
		margin-top: 8px;
	}

	.off-list {
		margin: 2px 0 0;
		padding-left: 20px;
		font-size: 0.78rem;
		color: var(--text-secondary);
	}
</style>
