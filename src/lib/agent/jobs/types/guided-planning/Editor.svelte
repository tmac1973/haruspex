<script lang="ts">
	import Tooltip from '$lib/components/Tooltip.svelte';
	import type { GuidedPlanningEditorState } from './definition';

	// The guided-planning section of the job editor (see JobTypeEditorProps):
	// the seed idea and the plan output folder. The output dir auto-derives
	// from the job name (plan/<slug>/) until the user edits it by hand.
	let {
		config = $bindable(),
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

	function slugify(s: string): string {
		return s
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '');
	}

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
		<input type="checkbox" bind:checked={cfg.skip_verification} />
		<span class="label">
			Skip verification
			<Tooltip
				label="About skipping verification"
				text="Verification is an independent fresh-context review of every phase file — dependency ordering, unresolved decisions, embedded code, unreachable steps — with up to three revise rounds. It is usually the longest stage of a run. Skip it when the plan is small or you intend to review it yourself; the approval checkpoint still shows you the files either way."
			/>
		</span>
	</label>
</div>

<style>
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
