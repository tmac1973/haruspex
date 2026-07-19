<script lang="ts">
	import { onMount } from 'svelte';
	import { getJob, getJobs } from '$lib/stores/jobs.svelte';
	import { parseGuidedPlanningConfig } from '../guided-planning/config';
	import type { AutonomousCodingEditorState } from './definition';

	// The autonomous-coding section of the job editor (see JobTypeEditorProps).
	// The job's working dir is the project being built; `plan_dir` points at a
	// folder of .md plans — commonly a guided-planning job's output dir, so we
	// offer those as suggestions, but any folder of plans works.
	let {
		config = $bindable(),
		steps = $bindable([])
	}: {
		config: Record<string, unknown>;
		steps?: import('$lib/stores/jobs.svelte').JobStepInput[];
	} = $props();
	void steps; // declared only because JobEditor binds it on every type's editor

	const cfg = config as unknown as AutonomousCodingEditorState;

	// Plan-dir suggestions: every guided-planning job's configured output dir.
	let planDirSuggestions = $state<string[]>([]);
	onMount(async () => {
		const guided = getJobs().filter((j) => j.job_type === 'guided_planning');
		const dirs: string[] = [];
		for (const summary of guided) {
			const job = await getJob(summary.id);
			const dir = job ? parseGuidedPlanningConfig(job.type_config).plan_output_dir : null;
			if (dir) dirs.push(dir);
		}
		planDirSuggestions = [...new Set(dirs)];
	});
</script>

<label
	class="field"
	title="Folder of markdown plan files, relative to the working directory — typically a guided-planning job's output folder, but hand-written plans work too. The preflight interview reads every .md file in it."
>
	<span class="label">Plan directory <span class="required">(required)</span></span>
	<input
		type="text"
		bind:value={cfg.plan_dir}
		placeholder="plan/my-feature/"
		list="plan-dir-suggestions"
	/>
	<datalist id="plan-dir-suggestions">
		{#each planDirSuggestions as dir (dir)}
			<option value={dir}></option>
		{/each}
	</datalist>
	<span class="hint">
		Relative to the working directory. Suggestions come from your guided-planning jobs.
	</span>
</label>

<label
	class="field"
	title="Command run in the working directory to prove each step works. A step only counts as done when it exits 0. Leave blank and preflight will inspect the repo, propose a command, try it, and confirm it with you before the run starts."
>
	<span class="label">Verify command <span class="optional">(optional)</span></span>
	<input
		type="text"
		bind:value={cfg.verify_command}
		placeholder="Leave blank and preflight will work it out with you"
	/>
	<span class="hint">
		Run after every step; the step is only done when it exits 0. <strong
			>Not sure? Leave it blank.</strong
		> Preflight reads your repo, proposes a command, runs it once to check it actually works, and asks
		you to confirm — before the unattended run starts.
	</span>
</label>

<!-- Outside the <label> on purpose: a <summary> nested in a label activates the
	 label too, focusing the input on every expand/collapse. -->
<details class="verify-examples">
	<summary>Verify command examples</summary>
	<ul>
		<li>
			<code>npm test</code> — or <code>npm run check &amp;&amp; npm test</code> to typecheck too
		</li>
		<li><code>cargo test</code> · <code>pytest</code> · <code>go test ./...</code></li>
		<li>
			<strong>Several languages?</strong> Chain them with <code>&amp;&amp;</code> so any failure
			fails the step — <code>npm test &amp;&amp; cargo test</code>. Preflight composes this for you
			if you leave the field blank.
		</li>
		<li>
			<strong>No tests yet?</strong> A build or syntax check still beats nothing —
			<code>tsc --noEmit</code>, <code>cargo check</code>, <code>node --check index.js</code>.
		</li>
	</ul>
</details>

<label
	class="field signing"
	title="Commit signing agents (e.g. 1Password) need authorization. The run primes it with the baseline commit right after your preflight interview, but the authorization can expire overnight."
>
	<span class="label">If commit signing becomes unavailable mid-run</span>
	<select bind:value={cfg.signing_fallback}>
		<option value="unsigned">Commit unsigned — re-sign before pushing</option>
		<option value="skip">Don't commit — leave work uncommitted</option>
	</select>
	<span class="hint">
		Choose "Don't commit" for repos that reject unsigned commits; the loop keeps working and the
		report notes what went uncommitted.
	</span>
</label>

<label
	class="field attempts"
	title="How many failed attempts a single step gets before it's marked BLOCKED and the loop moves on to steps that don't depend on it."
>
	<span class="label">Max attempts per step</span>
	<input type="number" min="1" max="10" bind:value={cfg.max_attempts} />
	<span class="hint">
		After this many failures a step is marked blocked and the run continues — you wake up to maximum
		progress plus a list of what needs you.
	</span>
</label>

<p class="unattended-note">
	Runs are <strong>fully unattended</strong> after the preflight interview: the run starts by asking you
	about anything the plan leaves open, then codes without interruption — one atomic step at a time, verified
	and committed — until every step is done or blocked.
</p>

<style>
	.label {
		font-size: 0.82rem;
		color: var(--text-secondary);
	}

	.optional {
		font-weight: normal;
		opacity: 0.7;
	}

	.required {
		font-weight: normal;
		font-size: 0.82rem;
		color: var(--accent);
	}

	.hint {
		font-style: italic;
	}

	.attempts input {
		max-width: 120px;
	}

	.signing select {
		align-self: flex-start;
		min-width: 300px;
	}

	.unattended-note {
		margin: 0;
		padding: 8px 10px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-secondary);
		font-size: 0.82rem;
		color: var(--text-secondary);
	}

	.verify-examples {
		margin-top: 6px;
		font-size: 0.8rem;
	}

	.verify-examples summary {
		cursor: pointer;
		color: var(--text-secondary);
		user-select: none;
	}

	.verify-examples ul {
		margin: 6px 0 0;
		padding-left: 18px;
		display: flex;
		flex-direction: column;
		gap: 4px;
		color: var(--text-secondary);
	}

	.verify-examples code {
		font-size: 0.78rem;
	}
</style>
