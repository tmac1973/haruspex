<script lang="ts">
	import Tooltip from '#lib/components/Tooltip.svelte';
	import { onMount } from 'svelte';
	import { getSettings } from '#lib/stores/settings.ts';
	import { resolveImageBackend } from '#lib/image/backend.ts';
	import { chosenVideoInstanceId, listVideoInstances } from '#lib/videogen/toolchest.ts';
	import type { JobModelForm } from '#lib/agent/jobs/jobModelForm.ts';
	import type { VideoSequenceConfig } from '#lib/agent/jobs/types/video-sequence/config.ts';
	import { errMessage } from '#lib/utils/error.ts';

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
	let instances: string[] = $state([]);
	/** Instances that make someone speak (the `audio` capability). */
	let speakers: string[] = $state([]);
	let listError = $state('');
	const chosen = chosenVideoInstanceId();

	onMount(() => {
		if (getSettings().videoGenBackendKind === 'none') return;
		void listVideoInstances()
			.then((list) => {
				instances = list.map((i) => i.id);
				speakers = list.filter((i) => i.capabilities.includes('audio')).map((i) => i.id);
			})
			.catch((e: unknown) => (listError = errMessage(e)));
	});

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
			text="A video instance on the server in Settings → Video generation. Its longest clip decides how many clips a section takes."
		/>
	</span>
	<select bind:value={cfg.video_instance_id} aria-label="Video model">
		<option value="">The one in Settings → Video generation{chosen ? ` (${chosen})` : ''}</option>
		{#each instances.filter((i) => i !== chosen) as id (id)}
			<option value={id}>{id}</option>
		{/each}
		{#if cfg.video_instance_id && !instances.includes(cfg.video_instance_id)}
			<option value={cfg.video_instance_id}>{cfg.video_instance_id}</option>
		{/if}
	</select>
	{#if listError}<p class="hint">Could not list the server's models: {listError}</p>{/if}
</div>

{#if speakers.length || cfg.speaking_instance_id}
	<div class="field">
		<span class="label">
			Speaking model
			<Tooltip
				label="About the speaking model"
				text="A video instance that makes a person in a portrait say lines (Wan2.2 S2V), for speaking sections. None leaves them out."
			/>
		</span>
		<select bind:value={cfg.speaking_instance_id} aria-label="Speaking model">
			<option value="">None</option>
			{#each speakers as id (id)}
				<option value={id}>{id}</option>
			{/each}
			{#if cfg.speaking_instance_id && !speakers.includes(cfg.speaking_instance_id)}
				<option value={cfg.speaking_instance_id}>{cfg.speaking_instance_id}</option>
			{/if}
		</select>
	</div>
{/if}

{#if hasImageBackend}
	<label class="check">
		<input type="checkbox" bind:checked={cfg.image_keyframes} />
		Open each section on a keyframe
		<Tooltip
			label="About keyframes"
			text="Makes an opening still for each generated section with the image backend in Settings → Image, so every clip of it starts from a picture of the subject."
		/>
	</label>
{/if}

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
