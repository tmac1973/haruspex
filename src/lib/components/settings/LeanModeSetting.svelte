<script lang="ts">
	/**
	 * Settings → General → Lean mode: Off, Lean, or Lean + files (lean mode
	 * that may also write text and documents), and what it turns off. The
	 * header's Lean mode badge opens Settings here (`#lean-mode`).
	 */
	import ModeSelector from '#lib/components/ModeSelector.svelte';
	import { getLiveSettings, setLeanFileWrites } from '#lib/stores/settings.ts';
	import { codeOrShellBusy, LEAN_BUSY_TITLE } from '#lib/lean/busy.ts';
	import { turnLeanMode } from '#lib/lean/nudges.ts';
	import { pausedIntegrations } from '#lib/lean/pausedIntegrations.ts';

	type LeanChoice = 'off' | 'lean' | 'files';

	const on = $derived(getLiveSettings().leanMode);
	const files = $derived(getLiveSettings().leanFileWrites);
	const choice = $derived<LeanChoice>(!on ? 'off' : files ? 'files' : 'lean');
	// Only turning it on waits for a Code or Shell turn, and that is only
	// possible from Off, so the whole control can wait.
	const blocked = $derived(!on && codeOrShellBusy());
	const paused = $derived(on ? pausedIntegrations() : []);

	function choose(next: LeanChoice): void {
		if (next !== 'off') setLeanFileWrites(next === 'files');
		turnLeanMode(next !== 'off');
	}
</script>

<section class="settings-section" id="lean-mode">
	<h2>Lean mode</h2>
	<fieldset class="lean-choice" disabled={blocked} title={blocked ? LEAN_BUSY_TITLE : undefined}>
		<ModeSelector
			name="lean-mode"
			value={choice}
			onchange={choose}
			options={[
				{ value: 'off', title: 'Off', description: 'The full app.' },
				{
					value: 'lean',
					title: 'Lean',
					description: 'Chat and research only, for small models and slow machines.'
				},
				{
					value: 'files',
					title: 'Lean + files',
					description: 'Lean, and Chat can save text and documents to the working folder.'
				}
			]}
		/>
	</fieldset>
	{#if on}
		<p
			class="hint off-label"
			title="Sends a much smaller tool list, so replies start sooner and leave more room in the context window."
		>
			Off in lean mode:
		</p>
		<ul class="off-list">
			<li>The Code and Shell tabs</li>
			<li>Job types other than Research</li>
			<li>
				{files
					? 'Spreadsheets, slides, skill writing and speech generation'
					: 'File writing, skill writing and speech generation'}
			</li>
			{#each paused as name (name)}
				<li>{name}</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.lean-choice {
		border: 0;
		margin: 0;
		padding: 0;
		min-width: 0;
	}

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
