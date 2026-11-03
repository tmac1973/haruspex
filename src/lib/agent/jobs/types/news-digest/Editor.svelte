<script lang="ts">
	// The news digest's section of the job editor (see JobTypeEditorProps),
	// also the body of Home's Add card form for News.
	import Tooltip from '#lib/components/Tooltip.svelte';
	import { PRESET_FEEDS } from '#lib/agent/jobs/types/news-digest/feeds.ts';
	import { isFeedUrl, type NewsDigestConfig } from '#lib/agent/jobs/types/news-digest/config.ts';

	let { config = $bindable() }: { config: Record<string, unknown> } = $props();

	const cfg = config as unknown as NewsDigestConfig;
	const presetUrls = new Set(PRESET_FEEDS.map((p) => p.url));

	/** The feeds that aren't presets, one per line, as typed. */
	let custom = $state(cfg.feeds.filter((f) => !presetUrls.has(f)).join('\n'));
	const badLines = $derived(
		custom
			.split('\n')
			.map((l) => l.trim())
			.filter((l) => l && !isFeedUrl(l))
	);

	function setFeeds(presets: string[], customText: string) {
		const typed = customText
			.split('\n')
			.map((l) => l.trim())
			.filter((l) => l && isFeedUrl(l));
		cfg.feeds = [...new Set([...presets, ...typed])];
	}

	function togglePreset(url: string, on: boolean) {
		const presets = cfg.feeds.filter((f) => presetUrls.has(f) && f !== url);
		setFeeds(on ? [...presets, url] : presets, custom);
	}
</script>

<fieldset class="field feeds">
	<legend class="label">
		Feeds
		<Tooltip
			label="About the feeds"
			text="RSS or Atom feeds, read through Settings → Network → Network Proxy. The model picks from their latest items; it never opens the articles."
		/>
	</legend>
	<div class="list">
		{#each PRESET_FEEDS as preset (preset.url)}
			<label class="check">
				<input
					type="checkbox"
					checked={cfg.feeds.includes(preset.url)}
					onchange={(e) => togglePreset(preset.url, (e.currentTarget as HTMLInputElement).checked)}
					required={cfg.feeds.length === 0}
				/>
				{preset.name}
			</label>
		{/each}
	</div>
	<label class="field">
		<span class="label">Other feeds, one URL per line</span>
		<textarea
			rows="2"
			bind:value={custom}
			oninput={() =>
				setFeeds(
					cfg.feeds.filter((f) => presetUrls.has(f)),
					custom
				)}
			placeholder="https://example.com/feed.xml"></textarea>
		{#if badLines.length > 0}
			<span class="bad">Not a URL: {badLines[0]}</span>
		{/if}
	</label>
</fieldset>

<label class="field">
	<span class="label">
		Interests
		<Tooltip
			label="About the interests"
			text="The model reads each item's headline and first lines and keeps the ones that match this."
		/>
	</span>
	<input
		type="text"
		bind:value={cfg.interests}
		required={!cfg.interests.trim()}
		placeholder="Local politics, Rust, space"
	/>
</label>

<div class="grid">
	<label class="field">
		<span class="label">Look back (hours)</span>
		<input type="number" min="1" max="168" bind:value={cfg.hours} />
	</label>
	<label class="field">
		<span class="label">At most</span>
		<input type="number" min="1" max="20" bind:value={cfg.max} />
	</label>
</div>

<style>
	.label {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		font-size: 0.82rem;
		color: var(--text-secondary);
	}

	.feeds {
		border: none;
		margin: 0;
		padding: 0;
	}

	/* A box of its own, so a long list scrolls where you can see it does. */
	.list {
		display: flex;
		flex-direction: column;
		gap: 4px;
		/* Six and a half rows: a cut row says there is more. */
		max-height: 155px;
		overflow-y: auto;
		margin-bottom: 8px;
		padding: 6px 8px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-input);
	}

	.check {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 0.88rem;
	}

	.bad {
		font-size: 0.78rem;
		color: var(--error-text);
	}

	.grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 12px;
	}
</style>
