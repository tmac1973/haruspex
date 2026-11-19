<script lang="ts">
	/**
	 * Settings → Code → Helpers: one switch per helper (`#lib/helpers/`), off
	 * unless the helper is `defaultOn`. The switches are what a Code session offers its agent
	 * until it chooses its own in the header's Extras menu. A helper with its
	 * own settings shows their editor under the switch while it is on.
	 */
	import { helpers, type HelperDef } from '#lib/helpers/registry.ts';
	import '#lib/helpers/index.ts';
	import { getSettings, setCodeHelper } from '#lib/stores/settings.ts';

	const list = helpers();
	let on = $state<Record<string, boolean>>({ ...getSettings().codeHelpers });

	/** The switch's state: the stored choice, else the helper's default. */
	function checked(h: HelperDef): boolean {
		return on[h.id] ?? h.defaultOn === true;
	}

	function toggle(id: string, value: boolean) {
		setCodeHelper(id, value);
		on = { ...getSettings().codeHelpers };
	}
</script>

<section class="settings-section">
	<h2>Helpers</h2>
	{#each list as h (h.id)}
		<label class="toggle-row" title={h.tooltip}>
			<input
				type="checkbox"
				checked={checked(h)}
				onchange={(e) => toggle(h.id, e.currentTarget.checked)}
			/>
			<span><strong>{h.label}</strong> — {h.summary}</span>
		</label>
		{#if h.settings && checked(h)}
			<div class="helper-settings">
				{#await h.settings.component() then { default: Editor }}
					<Editor helperId={h.id} />
				{/await}
			</div>
		{/if}
	{:else}
		<p class="help">No helpers yet.</p>
	{/each}
	<p
		class="help"
		title="A session can change these for itself in its header's Extras menu; until then it follows these switches."
	>
		Tools the agent runs without a model, such as rendering a 3D model to check it.
	</p>
</section>

<style>
	.helper-settings {
		margin-left: 1.75rem;
	}
</style>
