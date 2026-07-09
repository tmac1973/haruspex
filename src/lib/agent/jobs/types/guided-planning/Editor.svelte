<script lang="ts">
	// The guided-planning-specific section of the job editor: the seed idea and
	// the plan output folder. The output dir auto-derives from the job name
	// (plan/<slug>/) until the user edits it by hand.
	let {
		jobName,
		initialDescription = $bindable(),
		planOutputDir = $bindable(),
		planOutputDirEdited = $bindable()
	}: {
		jobName: string;
		initialDescription: string;
		planOutputDir: string;
		planOutputDirEdited: boolean;
	} = $props();

	function slugify(s: string): string {
		return s
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '');
	}

	$effect(() => {
		if (!planOutputDirEdited) {
			const s = slugify(jobName);
			planOutputDir = s ? `plan/${s}/` : '';
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
		bind:value={initialDescription}
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
		bind:value={planOutputDir}
		oninput={() => (planOutputDirEdited = true)}
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
