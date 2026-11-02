<script lang="ts">
	/**
	 * Settings → Code → Helpers: one switch per helper (`#lib/helpers/`), each
	 * off by default. A helper's tools reach the Code tab's agent only while its
	 * switch is on.
	 */
	import { helpers } from '#lib/helpers/registry.ts';
	import '#lib/helpers/index.ts';
	import { getSettings, setCodeHelper } from '#lib/stores/settings.ts';

	const list = helpers();
	let on = $state<Record<string, boolean>>({ ...getSettings().codeHelpers });

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
				checked={on[h.id] === true}
				onchange={(e) => toggle(h.id, e.currentTarget.checked)}
			/>
			<span><strong>{h.label}</strong> — {h.summary}</span>
		</label>
	{:else}
		<p class="help">No helpers yet.</p>
	{/each}
	<p class="help">
		Tools the agent runs without a model, such as rendering a 3D model to check it.
	</p>
</section>
