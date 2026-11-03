<script lang="ts">
	import Tooltip from '#lib/components/Tooltip.svelte';
	import { resolveImageBackend } from '#lib/image/index.ts';
	import type { GuidedPlanningEditorState } from '#lib/agent/jobs/types/guided-planning/definition.ts';
	import StageModelRow from '#lib/components/jobs/StageModelRow.svelte';
	import Disclosure from '#lib/components/Disclosure.svelte';
	import type { JobModelForm } from '#lib/agent/jobs/jobModelForm.ts';
	import type { SkillSummary } from '#lib/ipc/gen/SkillSummary.ts';
	import { listSkills, usableSkills } from '#lib/skills/client.ts';
	import { knownTrustedRoot } from '#lib/skills/project.ts';
	import { defaultPlanDir } from '#lib/agent/jobs/types/guided-planning/config.ts';

	// The guided-planning section of the job editor (see JobTypeEditorProps):
	// the seed idea and the plan output folder. The output dir auto-derives
	// from the job name (plan/<slug>/) until the user edits it by hand.
	let {
		config = $bindable(),
		// Part of every job-type editor's bindable props: JobEditor binds it, and
		// Svelte throws on a bind to an undeclared prop. This one has no steps.
		// eslint-disable-next-line no-useless-assignment
		steps = $bindable([]),
		jobName = '',
		workingDir = '',
		jobModel
	}: {
		config: Record<string, unknown>;
		steps?: import('#lib/stores/jobs.svelte.ts').JobStepInput[];
		jobName?: string;
		/** The project folder, whose repo's skills count once it is trusted. */
		workingDir?: string;
		/** This job's own model, which a stage's "Same as this job" means. */
		jobModel?: JobModelForm;
	} = $props();

	const cfg = config as unknown as GuidedPlanningEditorState;

	// A loaded value counts as user-set so the name-sync effect doesn't
	// clobber it on edit. (JobEditor remounts this component per job/type,
	// so initializing from the mount-time value is safe.)
	let outputDirEdited = $state(!!cfg.plan_output_dir);

	// Disabled rather than hidden: "why is there no asset option" is a worse
	// question than "why is this greyed out", and the hint answers the second.
	const imageBackendReady = resolveImageBackend().kind !== 'none';

	// The skills the planning-skill picker offers: those written for guided
	// planning first, then the rest. Reloaded (after a pause) as the working
	// directory changes, since a trusted repo's skills count.
	let skills = $state<SkillSummary[] | null>(null);
	$effect(() => {
		const dir = workingDir.trim();
		const timer = setTimeout(async () => {
			const root = await knownTrustedRoot(dir || null);
			skills = usableSkills(await listSkills(root).catch(() => []));
		}, 300);
		return () => clearTimeout(timer);
	});
	const planningSkills = $derived(skills?.filter((s) => s.forGuidedPlanning) ?? []);
	const otherSkills = $derived(skills?.filter((s) => !s.forGuidedPlanning) ?? []);
	const skillMissing = $derived(
		!!cfg.planning_skill && skills !== null && !skills.some((s) => s.name === cfg.planning_skill)
	);

	$effect(() => {
		if (!outputDirEdited) {
			cfg.plan_output_dir = defaultPlanDir(jobName);
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
		required
		rows="5"
		placeholder="e.g. A guided-planning job type that interviews me one question at a time and writes a dependency-ordered, phased implementation plan."
	></textarea>
</div>

<div class="field">
	<span class="label">
		Planning skill
		<Tooltip
			label="About the planning skill"
			text="Questions the interview asks for this kind of project, and requirements the plan must meet. Edit or add skills in Settings → Skills."
		/>
	</span>
	<select bind:value={cfg.planning_skill} aria-label="Planning skill">
		<option value="">None</option>
		{#if skillMissing}
			<option value={cfg.planning_skill}>{cfg.planning_skill} (missing)</option>
		{/if}
		{#if planningSkills.length > 0}
			<optgroup label="For planning">
				{#each planningSkills as skill (skill.name)}
					<option value={skill.name} title={skill.description}>{skill.name}</option>
				{/each}
			</optgroup>
		{/if}
		{#if otherSkills.length > 0}
			<optgroup label="Other skills">
				{#each otherSkills as skill (skill.name)}
					<option value={skill.name} title={skill.description}>{skill.name}</option>
				{/each}
			</optgroup>
		{/if}
	</select>
	{#if skillMissing}
		<p class="hint">Not in your skills any more. Pick another, or None.</p>
	{/if}
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
		<input type="checkbox" bind:checked={cfg.overview_only} />
		<span class="label">
			Overview only
			<Tooltip
				label="About overview only"
				text="Stops once you approve overview.md — no phase outline, phase files or review. For a project small enough to build straight from the overview: open its folder in the Code tab and point the agent at the file."
			/>
		</span>
	</label>
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

{#if !cfg.overview_only}
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

	<div class="toggle-row">
		<label>
			<input type="checkbox" bind:checked={cfg.generate_models} />
			<span class="label">
				Also generate 3D models
				<Tooltip
					label="About generating 3D models"
					text="Writes models.json from the plan. Plan + code chains a 3D run before coding; other modes create the job for you to start."
				/>
			</span>
		</label>
	</div>

	{#if cfg.generate_models}
		<div class="stages">
			<StageModelRow
				bind:form={cfg.chain_models_create_model}
				jobForm={jobModel}
				warnNoVision
				label="3D creation"
				tip="Builds each model as code and checks it with check_3d."
			/>
			<StageModelRow
				bind:form={cfg.chain_models_animate_model}
				jobForm={jobModel}
				warnNoVision
				label="3D animation"
				tip="Writes each animated model's clips."
			/>
		</div>
	{/if}

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

		<div class="stages">
			<span class="group-label">Later stages</span>
			{#if cfg.generate_assets && imageBackendReady}
				<StageModelRow
					bind:form={cfg.chain_assets_model}
					jobForm={jobModel}
					label="Asset run model"
					tip="The model the asset run uses to write prompts and judge the art. The image backend itself is set in Settings → Image."
				/>
			{/if}
			<StageModelRow
				bind:form={cfg.chain_coding_model}
				jobForm={jobModel}
				label="Coding run model"
				tip="The model that writes the code. A fast model here and a strong one for planning is the usual reason to change it."
			/>
		</div>

		<Disclosure label="Coding run settings">
			<p class="hint flush">
				The coding job is created and started without stopping, so this is the only chance to set
				it. Leave anything blank to let the coding run's own preflight settle it.
			</p>

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
		</Disclosure>
	{/if}
{/if}

<style>
	.field.run-mode {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.field.run-mode select {
		width: 100%;
	}

	.sub {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		font-size: 0.9em;
	}

	.hint {
		margin: 0.15rem 0 0 1.6rem;
		font-size: 0.85em;
		opacity: 0.7;
	}

	.hint.flush {
		margin: 0;
	}

	.stages {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.group-label {
		font-size: 0.72rem;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--text-muted);
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
