<script lang="ts">
	import Tooltip from '$lib/components/Tooltip.svelte';
	import type { AssetGenerationEditorState } from './definition';

	// The asset-generation section of the job editor (see JobTypeEditorProps).
	// The job's working dir is the project the assets are written into.
	let {
		config = $bindable(),
		steps = $bindable([])
	}: {
		config: Record<string, unknown>;
		steps?: import('$lib/stores/jobs.svelte').JobStepInput[];
		workingDir?: string;
	} = $props();
	// Both are declared only because JobEditor binds them on every type's
	// editor; this one has no use for either.
	void steps;

	const cfg = config as unknown as AssetGenerationEditorState;
</script>

<div class="field">
	<span class="label">
		Asset spec
		<Tooltip
			label="About the asset spec"
			text="A JSON file in your project listing every image to make. If it does not exist yet, the run writes one from the description below."
		/>
	</span>
	<input type="text" bind:value={cfg.spec_path} aria-label="Asset spec path" />
</div>

<div class="field">
	<span class="label">What to make</span>
	<textarea
		rows="3"
		bind:value={cfg.description}
		placeholder="a top-down pixel-art roguelike set in a ruined city"
		aria-label="What to make"
	></textarea>
	<p class="hint">Only used when the spec file does not exist yet.</p>
</div>

<div class="field">
	<span class="label">
		Run mode
		<Tooltip
			label="About run modes"
			text="Attended stops once, to show you the style anchor before anything else is generated. Unattended accepts the first anchor and never asks, so the job can run overnight or as part of a chain."
		/>
	</span>
	<select bind:value={cfg.run_mode} aria-label="Run mode">
		<option value="attended">Attended — show me the style anchor</option>
		<option value="unattended">Unattended — accept the first anchor</option>
	</select>
</div>

<div class="field">
	<span class="label">
		Asset size
		<Tooltip
			label="About asset size"
			text="The output edge in pixels. Generation happens much larger and is downscaled to this, so a small number here is not a small generation. Powers of two only."
		/>
	</span>
	<input
		type="number"
		min="8"
		max="512"
		step="8"
		bind:value={cfg.target_size}
		aria-label="Asset size"
	/>
</div>

<div class="field">
	<span class="label">Attempts per asset</span>
	<input
		type="number"
		min="1"
		max="10"
		bind:value={cfg.max_attempts}
		aria-label="Attempts per asset"
	/>
</div>

<div class="field">
	<span class="label">
		Anchor attempts
		<Tooltip
			label="About anchor attempts"
			text="How many times the style anchor may be regenerated before the run gives up. Separate from attempts per asset: raising one should not raise the other."
		/>
	</span>
	<input
		type="number"
		min="1"
		max="10"
		bind:value={cfg.anchor_attempts}
		aria-label="Anchor attempts"
	/>
</div>

<div class="field">
	<span class="label">
		Simultaneous requests
		<Tooltip
			label="About simultaneous requests"
			text="How many assets to generate at once. Raise it when the backend has the capacity; leave it at one for a single local GPU."
		/>
	</span>
	<input
		type="number"
		min="1"
		max="8"
		bind:value={cfg.concurrency}
		aria-label="Simultaneous requests"
	/>
</div>

<div class="field">
	<label class="check">
		<input type="checkbox" bind:checked={cfg.vision_judge} />
		<span>Check each asset against the anchor</span>
	</label>
	<Tooltip
		label="About the visual check"
		text="Asks the model whether each finished asset is recognisably the thing it was meant to be, in the anchor's style. Skipped when the job's model cannot see images."
	/>
</div>

<div class="field">
	<label class="check">
		<input type="checkbox" bind:checked={cfg.use_git} />
		<span>Commit the assets</span>
	</label>
	<Tooltip
		label="About git"
		text="Off for a project that is not a git repository, or one you do not want versioned."
	/>
</div>

<style>
	.field {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.field .label {
		font-size: 0.85em;
		color: var(--text-muted, #888);
	}

	.field .check {
		display: flex;
		align-items: center;
		gap: 0.4rem;
	}

	.hint {
		font-size: 0.8em;
		color: var(--text-muted, #888);
		margin: 0;
	}
</style>
