<script lang="ts">
	import {
		getSettings,
		updateSettings,
		applyTheme,
		applyAccent,
		type ResponseFormat,
		type ThemeMode,
		type AccentColor
	} from '$lib/stores/settings';
	import ModeSelector from '$lib/components/ModeSelector.svelte';

	let responseFormat = $state<ResponseFormat>(getSettings().responseFormat);
	let theme = $state<ThemeMode>(getSettings().theme);
	let accent = $state<AccentColor>(getSettings().accentColor);

	function setTheme(mode: ThemeMode) {
		theme = mode;
		updateSettings({ theme: mode });
		applyTheme(mode);
	}

	function setAccent(color: AccentColor) {
		accent = color;
		updateSettings({ accentColor: color });
		applyAccent(color);
	}

	function setResponseFormat(format: ResponseFormat) {
		responseFormat = format;
		updateSettings({ responseFormat: format });
	}

	const accentOptions: { value: AccentColor; label: string }[] = [
		{ value: 'teal', label: 'Teal' },
		{ value: 'amber', label: 'Amber' },
		{ value: 'violet', label: 'Violet' }
	];
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
	<h2>Highlight color</h2>
	<p class="hint accent-hint">Accent used for buttons, active states, and links.</p>
	<div class="segmented">
		{#each accentOptions as opt (opt.value)}
			<button class:active={accent === opt.value} onclick={() => setAccent(opt.value)}>
				<span class="swatch-label">
					<span class="swatch" style:background="var(--accent-{opt.value})"></span>
					{opt.label}
				</span>
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

<style>
	.accent-hint {
		margin: -4px 0 10px;
	}

	.swatch-label {
		display: inline-flex;
		align-items: center;
		gap: 7px;
	}

	.swatch {
		width: 10px;
		height: 10px;
		border-radius: 50%;
		flex: none;
	}

	/* On the filled (active) button the swatch would vanish into its own
	   accent background — ring it with the button's ink color. */
	button.active .swatch {
		box-shadow: 0 0 0 1px var(--accent-contrast);
	}
</style>
