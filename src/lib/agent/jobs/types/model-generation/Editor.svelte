<script lang="ts">
	import Tooltip from '#lib/components/Tooltip.svelte';
	import Disclosure from '#lib/components/Disclosure.svelte';
	import StageModelRow from '#lib/components/jobs/StageModelRow.svelte';
	import type { ModelGenerationEditorState } from '#lib/agent/jobs/types/model-generation/definition.ts';
	import type { JobModelForm } from '#lib/agent/jobs/jobModelForm.ts';
	import { DEFAULT_MODELS_SPEC_PATH } from '#lib/models3d/spec/paths.ts';
	import {
		MAX_ROUNDS,
		MAX_STAGE_TURNS,
		MIN_ROUNDS,
		MIN_STAGE_TURNS
	} from '#lib/agent/jobs/types/model-generation/config.ts';

	// The 3D models section of the job editor (see JobTypeEditorProps). The
	// job's working dir is the project the models are written into.
	let {
		config = $bindable(),
		steps = $bindable([]),
		jobModel
	}: {
		config: Record<string, unknown>;
		steps?: import('#lib/stores/jobs.svelte.ts').JobStepInput[];
		/** This job's own model, which a stage's "Same as this job" means. */
		jobModel?: JobModelForm;
	} = $props();
	// Declared only because JobEditor binds it on every type's editor.
	void steps;

	const cfg = config as unknown as ModelGenerationEditorState;
</script>

<div class="field">
	<span class="label">What to make</span>
	<textarea
		rows="3"
		bind:value={cfg.description}
		placeholder="a knight, a goblin, a crate and a tree for a small low-poly arena game"
		aria-label="What to make"></textarea>
	<p class="hint">Only used when the spec file does not exist yet.</p>
</div>

<div class="field">
	<span class="label">
		Models spec
		<Tooltip
			label="About the models spec"
			text="A models.json file in your project: each model's size, parts and clips. If it does not exist yet, the run writes one from the description, on this job's model."
		/>
	</span>
	<input
		type="text"
		bind:value={cfg.spec_path}
		placeholder={DEFAULT_MODELS_SPEC_PATH}
		aria-label="Models spec path"
	/>
</div>

<div class="field">
	<span class="label">
		Run mode
		<Tooltip
			label="About run modes"
			text="Attended stops after creation so you can accept or rebuild each model."
		/>
	</span>
	<select bind:value={cfg.run_mode} aria-label="Run mode">
		<option value="attended">Attended</option>
		<option value="unattended">Unattended</option>
	</select>
</div>

<div class="stages">
	<StageModelRow
		bind:form={cfg.chain_create_model}
		jobForm={jobModel}
		warnNoVision
		label="Creation model"
		tip="Builds each model as code and checks it with check_3d."
	/>
	<StageModelRow
		bind:form={cfg.chain_animate_model}
		jobForm={jobModel}
		warnNoVision
		label="Animation model"
		tip="Writes each animated model's clips. It never changes the model itself."
	/>
</div>

<div class="field">
	<label class="check">
		<input type="checkbox" bind:checked={cfg.allow_textures} />
		<span>Allow textures</span>
		<Tooltip
			label="About textures"
			text="The creation model may draw tiling textures and map them with kit.texture."
		/>
	</label>
</div>

{#if cfg.coding_run}
	<div class="field">
		<label class="check">
			<input type="checkbox" bind:checked={cfg.hand_off} />
			<span>Start the coding run when done</span>
		</label>
		<Tooltip
			label="About the coding handoff"
			text="This job was made by a plan's chain. A run you start here creates and starts the coding job too, as the chain would have. A chained run always does."
		/>
	</div>
{/if}

<Disclosure label="Limits">
	<label class="sub">
		<span class="label">
			Steps per creation turn
			<Tooltip
				label="About steps per creation turn"
				text="How many tool calls one creation turn may make before it stops."
			/>
		</span>
		<input
			type="number"
			min={MIN_STAGE_TURNS}
			max={MAX_STAGE_TURNS}
			bind:value={cfg.create_turns}
			aria-label="Steps per creation turn"
		/>
	</label>
	<label class="sub">
		<span class="label">Steps per animation turn</span>
		<input
			type="number"
			min={MIN_STAGE_TURNS}
			max={MAX_STAGE_TURNS}
			bind:value={cfg.animate_turns}
			aria-label="Steps per animation turn"
		/>
	</label>
	<label class="sub">
		<span class="label">
			Turns per model
			<Tooltip
				label="About turns per model"
				text="Turns a model or its clips get before the run marks it needs work and moves on."
			/>
		</span>
		<input
			type="number"
			min={MIN_ROUNDS}
			max={MAX_ROUNDS}
			bind:value={cfg.rounds}
			aria-label="Turns per model"
		/>
	</label>
</Disclosure>

<style>
	.field,
	.sub {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.stages {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.label {
		display: inline-flex;
		align-items: center;
		gap: 2px;
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
