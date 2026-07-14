<script lang="ts">
	import {
		getSettings,
		updateSettings,
		applyTheme,
		type ResponseFormat,
		type ThemeMode
	} from '$lib/stores/settings';
	import ModeSelector from '$lib/components/ModeSelector.svelte';

	let responseFormat = $state<ResponseFormat>(getSettings().responseFormat);
	let theme = $state<ThemeMode>(getSettings().theme);

	function setTheme(mode: ThemeMode) {
		theme = mode;
		updateSettings({ theme: mode });
		applyTheme(mode);
	}

	function setResponseFormat(format: ResponseFormat) {
		responseFormat = format;
		updateSettings({ responseFormat: format });
	}
</script>

<section class="settings-section">
	<h2>Theme</h2>
	<div class="segmented">
		{#each [{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }] as opt (opt.value)}
			<button class:active={theme === opt.value} onclick={() => setTheme(opt.value as ThemeMode)}>
				{opt.label}
			</button>
		{/each}
	</div>
</section>

<section class="settings-section">
	<h2>Response Format</h2>
	<ModeSelector
		name="format"
		value={responseFormat}
		onchange={setResponseFormat}
		options={[
			{ value: 'minimal', title: 'Minimal', description: 'Plain text, no formatting or emojis' },
			{
				value: 'standard',
				title: 'Standard',
				description: 'Clean markdown (headings, lists, code blocks)'
			},
			{ value: 'rich', title: 'Rich', description: 'Full markdown with tables and emojis' }
		]}
	/>
</section>
