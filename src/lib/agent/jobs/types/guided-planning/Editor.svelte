<script lang="ts">
	import Tooltip from '$lib/components/Tooltip.svelte';
	import { resolveImageBackend } from '$lib/image';
	import type { GuidedPlanningEditorState } from './definition';
	import JobModelFields from '$lib/components/jobs/JobModelFields.svelte';
	import { emptyModelForm } from '$lib/agent/jobs/jobModelForm';

	type StageKey = 'chain_assets_model' | 'chain_coding_model';

	// The guided-planning section of the job editor (see JobTypeEditorProps):
	// the seed idea and the plan output folder. The output dir auto-derives
	// from the job name (plan/<slug>/) until the user edits it by hand.
	let {
		config = $bindable(),
		// Part of every job-type editor's bindable props; this one has no steps.
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		steps = $bindable([]),
		jobName = ''
	}: {
		config: Record<string, unknown>;
		steps?: import('$lib/stores/jobs.svelte').JobStepInput[];
		jobName?: string;
	} = $props();

	const cfg = config as unknown as GuidedPlanningEditorState;

	// A loaded value counts as user-set so the name-sync effect doesn't
	// clobber it on edit. (JobEditor remounts this component per job/type,
	// so initializing from the mount-time value is safe.)
	let outputDirEdited = $state(!!cfg.plan_output_dir);

	// Disabled rather than hidden: "why is there no asset option" is a worse
	// question than "why is this greyed out", and the hint answers the second.
	const imageBackendReady = resolveImageBackend().kind !== 'none';

	function slugify(s: string): string {
		return s
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '');
	}

	function setStageModel(key: StageKey, choice: string) {
		cfg[key] = choice === 'choose' ? (cfg[key] ?? emptyModelForm('remote')) : null;
	}

	// "Same as this job" is the planning job's model. The Settings model is a
	// different choice whenever this job has its own server: the local model
	// for the coding run, say, while planning runs remotely.
	const STAGE_SETTINGS = {
		title: 'Settings model',
		description:
			'Whatever Settings → Inference has active — the local model, or the server set there.'
	};

	$effect(() => {
		if (!outputDirEdited) {
			const s = slugify(jobName);
			cfg.plan_output_dir = s ? `plan/${s}/` : '';
		}
	});
</script>

<div class="field">
	<span class="label">
		What do you want to build? <span class="required">(required)</span>
		<Tooltip
			label="About the project description"
			text="The idea seeding this planning session — describe it in your own words. The agent interviews you from here (you can always type your own answer to any question), then writes the overview and phase files."
		/>
	</span>
	<textarea
		bind:value={cfg.initial_description}
		rows="5"
		placeholder="e.g. A guided-planning job type that interviews me one question at a time and writes a dependency-ordered, phased implementation plan."
	></textarea>
</div>

<div class="field">
	<span class="label">
		Output folder
		<Tooltip
			label="About the output folder"
			text="Folder where the overview and phase markdown files are written, relative to the working directory (e.g. plan/my-feature/). Auto-fills from the job name until you edit it. An autonomous-coding job can point its plan directory straight at this folder."
		/>
	</span>
	<input
		type="text"
		bind:value={cfg.plan_output_dir}
		oninput={() => (outputDirEdited = true)}
		placeholder="plan/<name>/"
		aria-label="Output folder"
	/>
</div>

<div class="toggle-row">
	<label>
		<input type="checkbox" bind:checked={cfg.web_research} />
		<span class="label">
			Web research
			<Tooltip
				label="About web research"
				text="Lets the planner search the web to check versions and APIs newer than its training, and to compare options when you ask it to research something. Searches go to the provider in Settings → Search. The verifier never searches."
			/>
		</span>
	</label>
</div>

<div class="field run-mode">
	<span class="label">
		Run mode
		<Tooltip
			label="About run mode"
			text="Attended stops at three checkpoints: the overview, the phase outline, and the finished plan. Unattended plan skips only the last one — the first two land while you are still answering interview questions, and are the cheapest place to catch a bad overview before it becomes an hour of planning. Nothing skips the interview itself."
		/>
	</span>
	<select bind:value={cfg.run_mode} aria-label="Run mode">
		<option value="attended">Attended — stop at every checkpoint</option>
		<option value="unattended_plan">Unattended plan — skip the final approval</option>
		<option value="unattended_chain">Unattended plan + code — start a coding run too</option>
	</select>
</div>

<div class="toggle-row">
	<label>
		<input type="checkbox" bind:checked={cfg.use_git} />
		<span class="label">
			Use git
			<Tooltip
				label="About using git"
				text="Off drops the Commit section from every phase file, so a plan for a project you are not versioning never tells a coding run to commit. The Rollback section stays either way — rolling back without git means deleting the files a phase created. Turn this off for a project with no git repository, or one you do not want versioned."
			/>
		</span>
	</label>
</div>

<div class="field">
	<span class="label">
		Verification
		<Tooltip
			label="About verification"
			text="An independent fresh-context review of every phase file — dependency ordering, unresolved decisions, embedded code, unreachable steps. Full revises and re-checks until clean, up to five rounds; it is usually the longest stage of a run. Lite reads once and revises once, and passes whatever it found to the coding run as open findings. Skip when the plan is small or you will review it yourself."
		/>
	</span>
	<select bind:value={cfg.verification} aria-label="Verification">
		<option value="full">Full — revise until clean</option>
		<option value="lite">Lite — one check, one revise</option>
		<option value="skip" disabled={cfg.run_mode === 'unattended_chain'}>Skip</option>
	</select>
	{#if cfg.run_mode === 'unattended_chain'}
		<p class="hint">At least lite in this mode — it decides whether the coding run may start.</p>
	{/if}
</div>

{#if cfg.run_mode === 'unattended_chain'}
	<div class="toggle-row">
		<label>
			<input type="checkbox" bind:checked={cfg.generate_assets} disabled={!imageBackendReady} />
			<span class="label">
				Also generate assets
				<Tooltip
					label="About generating assets"
					text="Writes an asset spec from the finished plan, then runs an asset-generation job before the coding job, so the code is built against art that already exists. Needs an image backend in Settings → Image."
				/>
			</span>
		</label>
		{#if !imageBackendReady}
			<p class="hint">Needs an image backend — set one in Settings → Image.</p>
		{/if}
	</div>

	{#if cfg.generate_assets && imageBackendReady}
		{@render stageModel(
			'chain_assets_model',
			'Asset run model',
			'The model the asset run uses to write prompts and judge the art. The image backend itself is set in Settings → Image.'
		)}
	{/if}
	{@render stageModel(
		'chain_coding_model',
		'Coding run model',
		'The model that writes the code. A fast model here and a strong one for planning is the usual reason to change it.'
	)}

	<details class="coding-run">
		<summary>Coding run settings</summary>
		<p class="hint">
			The coding job is created and started without stopping, so this is the only chance to set it.
			Leave anything blank to let the coding run's own preflight settle it.
		</p>

		<label class="sub">
			Max attempts per step
			<input
				type="number"
				min="1"
				max="10"
				bind:value={cfg.coding_max_attempts}
				aria-label="Max attempts per step"
			/>
		</label>

		<label class="sub">
			Context mode
			<select bind:value={cfg.coding_context_mode} aria-label="Context mode">
				<option value="">Let the coding job decide</option>
				<option value="phase">One continuous context per phase</option>
				<option value="step">A fresh context per checklist item</option>
			</select>
		</label>

		<label class="sub">
			Max model steps per turn
			<input
				type="number"
				min="50"
				max="600"
				step="50"
				bind:value={cfg.coding_max_turns}
				aria-label="Max model steps per turn"
			/>
		</label>
	</details>
{/if}

{#snippet stageModel(key: StageKey, label: string, tip: string)}
	<div class="field stage-model">
		<span class="label">
			{label}
			<Tooltip label={`About the ${label.toLowerCase()}`} text={tip} />
		</span>
		<select
			value={cfg[key] ? 'choose' : 'same'}
			onchange={(e) => setStageModel(key, e.currentTarget.value)}
			aria-label={label}
		>
			<option value="same">Same as this job</option>
			<option value="choose">Choose…</option>
		</select>
		{#if cfg[key]}
			<div class="stage-fields">
				<JobModelFields
					bind:form={cfg[key]}
					name={`${key}-source`}
					settingsLabel={STAGE_SETTINGS}
				/>
			</div>
		{/if}
	</div>
{/snippet}

<style>
	.stage-model {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.stage-fields {
		margin-left: 1rem;
		padding-left: 0.75rem;
		border-left: 2px solid var(--border);
	}

	.field.run-mode {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.field.run-mode select {
		width: 100%;
	}

	.coding-run {
		margin-top: 0.25rem;
	}

	.coding-run summary {
		cursor: pointer;
		font-weight: 500;
	}

	.coding-run .sub {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		margin-top: 0.5rem;
		font-size: 0.9em;
	}

	.hint {
		margin: 0.15rem 0 0 1.6rem;
		font-size: 0.85em;
		opacity: 0.7;
	}

	.toggle-row label {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.label {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		font-size: 0.82rem;
		color: var(--text-secondary);
	}

	.required {
		font-weight: normal;
		font-size: 0.82rem;
		color: var(--accent);
	}
</style>
