<script lang="ts">
	import Tooltip from '#lib/components/Tooltip.svelte';
	import { videoEntries } from '#lib/videogen/entries.ts';
	import { resolveImageBackend } from '#lib/image/backend.ts';
	import type { JobModelForm } from '#lib/agent/jobs/jobModelForm.ts';
	import type { VideoSequenceConfig } from '#lib/agent/jobs/types/video-sequence/config.ts';
	import { NO_SPEAKER } from '#lib/agent/jobs/types/video-sequence/pick.ts';

	// The Video sequence section of the job editor (see JobTypeEditorProps).
	let {
		config = $bindable(),
		steps = $bindable([]),
		jobModel
	}: {
		config: Record<string, unknown>;
		steps?: import('#lib/stores/jobs.svelte.ts').JobStepInput[];
		jobModel?: JobModelForm;
	} = $props();
	// JobEditor binds steps on every type's editor; this one has none.
	void steps;

	const cfg = config as unknown as VideoSequenceConfig;
	const hasImageBackend = resolveImageBackend().kind !== 'none';
	// Without an image backend there is nothing to draw a still with.
	if (!hasImageBackend) cfg.section_start = 'prompt';
	const models = videoEntries();
	/** Models that make clips without speech, or may: no probe has said. */
	const makers = models.filter((e) => !e.caps?.needsSpeech);
	/** Models that make someone speak, or may. */
	const speakers = models.filter((e) => !e.caps || e.caps.speech);
	const known = (id: string) => models.some((e) => e.id === id);

	// Vision checks need a model that can see; the job's own, unless it says otherwise.
	const canSee = $derived(jobModel?.vision !== 'no');
</script>

<div class="field">
	<span class="label">
		Episode folder
		<Tooltip
			label="About the episode folder"
			text="Where sequence.json, the clips, the project and the render go, relative to the working folder. Leave it empty when the working folder is the episode. Existing clips and start pictures come from here."
		/>
	</span>
	<input type="text" bind:value={cfg.episode_dir} placeholder="ep014" aria-label="Episode folder" />
</div>

<div class="field">
	<span class="label">Brief</span>
	<textarea
		rows="4"
		bind:value={cfg.brief}
		placeholder="2 minutes: a fox walking in snow, then a fox in a summer forest, a gentle piano bed"
		aria-label="Brief"></textarea>
	<p class="hint">Not used when the episode already has a sequence.json.</p>
</div>

<div class="field">
	<span class="label">
		Run mode
		<Tooltip
			label="About run modes"
			text="Attended asks what the brief leaves open, one question at a time, and stops to show the spec before anything is made. Unattended writes the spec from the brief and never asks."
		/>
	</span>
	<select bind:value={cfg.run_mode} aria-label="Run mode">
		<option value="attended">Attended — ask me, and show me the spec</option>
		<option value="unattended">Unattended — never ask</option>
	</select>
</div>

<div class="field">
	<span class="label">
		Video model
		<Tooltip
			label="About the video model"
			text="Automatic takes the first model in Settings → Video generation that can make the clips, preferring one that can end on a picture. Its longest clip decides how many clips a section takes."
		/>
	</span>
	<select bind:value={cfg.video_model_id} aria-label="Video model">
		<option value="">Automatic</option>
		{#each makers as e (e.id)}
			<option value={e.id}>{e.name}</option>
		{/each}
		{#if cfg.video_model_id && !known(cfg.video_model_id)}
			<option value={cfg.video_model_id}>{cfg.video_model_id} — not in Settings</option>
		{/if}
	</select>
</div>

{#if speakers.length || cfg.speaking_model_id}
	<div class="field">
		<span class="label">
			Speaking model
			<Tooltip
				label="About the speaking model"
				text="A video model that makes a person in a portrait say lines (Wan2.2 S2V), for speaking sections. Automatic takes the first that can; None leaves them out."
			/>
		</span>
		<select bind:value={cfg.speaking_model_id} aria-label="Speaking model">
			<option value="">Automatic</option>
			<option value={NO_SPEAKER}>None</option>
			{#each speakers as e (e.id)}
				<option value={e.id}>{e.name}</option>
			{/each}
			{#if cfg.speaking_model_id && cfg.speaking_model_id !== NO_SPEAKER && !known(cfg.speaking_model_id)}
				<option value={cfg.speaking_model_id}>{cfg.speaking_model_id} — not in Settings</option>
			{/if}
		</select>
	</div>
{/if}

<div class="field">
	<span class="label">
		Sections start from
		<Tooltip
			label="About section starts"
			text="A still: the image backend in Settings → Image generation draws an opening picture for each section, and later sections' stills are edits of the first, so the subject stays the same. The prompt: each section's first clip is made from its text alone. Either way, the clips after it start from the last frame of the one before, and a section's own start picture wins."
		/>
	</span>
	<select bind:value={cfg.section_start} aria-label="Sections start from">
		<option value="still" disabled={!hasImageBackend}>A still</option>
		<option value="prompt">The prompt</option>
	</select>
	{#if !hasImageBackend}
		<p class="hint">Stills need an image backend in Settings → Image generation.</p>
	{/if}
</div>

{#if canSee}
	<label class="check">
		<input type="checkbox" bind:checked={cfg.vision_checks} />
		Check each seam
		<Tooltip
			label="About seam checks"
			text="The job's model looks at the frames either side of each join, and a clip that jumps is made once more."
		/>
	</label>
{/if}

{#if cfg.section_start === 'still'}
	<div class="field">
		<span class="label">
			Re-anchor every
			<Tooltip
				label="About re-anchoring"
				text="Every this many clips of a section end on a fresh still of it, so a long section doesn't drift. 0 turns it off. The spec's own value wins."
			/>
		</span>
		<input
			type="number"
			min="0"
			max="30"
			bind:value={cfg.reanchor_every}
			aria-label="Re-anchor every"
		/>
	</div>
{/if}

<div class="field">
	<span class="label">Editor</span>
	<select bind:value={cfg.editor} aria-label="Editor">
		<option value="">As Settings → Video editing</option>
		<option value="shotcut">Shotcut</option>
		<option value="kdenlive">Kdenlive</option>
	</select>
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

	.check {
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
