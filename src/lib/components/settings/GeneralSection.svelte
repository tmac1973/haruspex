<script lang="ts">
	import {
		getSettings,
		updateSettings,
		applyTheme,
		type ResponseFormat,
		type ThemeMode
	} from '$lib/stores/settings';

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

<section>
	<h2>Theme</h2>
	<div class="theme-options">
		{#each [{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }] as opt (opt.value)}
			<button
				class="theme-btn"
				class:selected={theme === opt.value}
				onclick={() => setTheme(opt.value as ThemeMode)}
			>
				{opt.label}
			</button>
		{/each}
	</div>
</section>

<section>
	<h2>Response Format</h2>
	<div class="format-options">
		<label class="format-option" class:selected={responseFormat === 'minimal'}>
			<input
				type="radio"
				name="format"
				value="minimal"
				checked={responseFormat === 'minimal'}
				onchange={() => setResponseFormat('minimal')}
			/>
			<div>
				<strong>Minimal</strong>
				<span>Plain text, no formatting or emojis</span>
			</div>
		</label>
		<label class="format-option" class:selected={responseFormat === 'standard'}>
			<input
				type="radio"
				name="format"
				value="standard"
				checked={responseFormat === 'standard'}
				onchange={() => setResponseFormat('standard')}
			/>
			<div>
				<strong>Standard</strong>
				<span>Clean markdown (headings, lists, code blocks)</span>
			</div>
		</label>
		<label class="format-option" class:selected={responseFormat === 'rich'}>
			<input
				type="radio"
				name="format"
				value="rich"
				checked={responseFormat === 'rich'}
				onchange={() => setResponseFormat('rich')}
			/>
			<div>
				<strong>Rich</strong>
				<span>Full markdown with tables and emojis</span>
			</div>
		</label>
	</div>
</section>

<style>
	section {
		padding-bottom: 24px;
		margin-bottom: 24px;
		border-bottom: 1px solid var(--border);
	}

	section:last-child {
		border-bottom: none;
		margin-bottom: 0;
		padding-bottom: 0;
	}

	h2 {
		font-size: 1rem;
		margin: 0 0 8px 0;
		color: var(--text-primary);
	}

	.theme-options {
		display: flex;
		gap: 8px;
	}

	.theme-btn {
		flex: 1;
		padding: 8px 16px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-primary);
		color: var(--text-primary);
		cursor: pointer;
		font-size: 0.9rem;
	}

	.theme-btn:hover {
		border-color: var(--text-secondary);
	}

	.theme-btn.selected {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 10%, transparent);
		font-weight: 500;
	}

	.format-options {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.format-option {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 10px 14px;
		border: 1px solid var(--border);
		border-radius: 8px;
		cursor: pointer;
		transition: border-color 0.15s;
	}

	.format-option:hover {
		border-color: var(--text-secondary);
	}

	.format-option.selected {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 5%, transparent);
	}

	.format-option input[type='radio'] {
		margin-top: 3px;
		accent-color: var(--accent);
	}

	.format-option strong {
		display: block;
		font-size: 0.9rem;
	}

	.format-option span {
		display: block;
		font-size: 0.8rem;
		color: var(--text-secondary);
		margin-top: 2px;
	}
</style>
