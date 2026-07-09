<script lang="ts">
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

<div
	class="field"
	title="The idea seeding this planning session. The agent asks follow-up questions from here, then writes the overview and phase files."
>
	<span class="label">
		What do you want to build? <span class="required">(required)</span>
	</span>
	<span class="hint">
		Describe the project or feature in your own words. The agent interviews you from here — you can
		always type your own answer to any question.
	</span>
	<textarea
		bind:value={cfg.initial_description}
		rows="5"
		placeholder="e.g. A guided-planning job type that interviews me one question at a time and writes a dependency-ordered, phased implementation plan."
	></textarea>
</div>

<label
	class="field"
	title="Folder where the overview and phase markdown files are written, relative to the working directory. Auto-fills from the name until you edit it."
>
	<span class="label">Output folder</span>
	<input
		type="text"
		bind:value={cfg.plan_output_dir}
		oninput={() => (outputDirEdited = true)}
		placeholder="plan/<name>/"
	/>
	<span class="hint">Relative to the working directory (e.g. plan/my-feature/).</span>
</label>

<style>
	.label {
		font-size: 0.82rem;
		color: var(--text-secondary);
	}

	.hint {
		font-style: italic;
	}

	.required {
		font-weight: normal;
		font-size: 0.82rem;
		color: var(--accent);
	}
</style>
