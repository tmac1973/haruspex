<script lang="ts">
	import { onMount } from 'svelte';
	import { open } from '@tauri-apps/plugin-dialog';
	import Tooltip from '$lib/components/Tooltip.svelte';
	import { getJob, getJobs } from '$lib/stores/jobs.svelte';
	import { parseGuidedPlanningConfig } from '../guided-planning/config';
	import { planDirFromPicked } from './config';
	import type { AutonomousCodingEditorState } from './definition';

	// The autonomous-coding section of the job editor (see JobTypeEditorProps).
	// The job's working dir is the project being built; `plan_dir` points at a
	// folder of .md plans — commonly a guided-planning job's output dir, so we
	// offer those as suggestions, but any folder of plans works.
	let {
		config = $bindable(),
		steps = $bindable([]),
		workingDir = ''
	}: {
		config: Record<string, unknown>;
		steps?: import('$lib/stores/jobs.svelte').JobStepInput[];
		workingDir?: string;
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

	let planDirError = $state<string | null>(null);

	/**
	 * Pick the plan dir with the system dialog, rooted at the working dir. The
	 * dialog returns an absolute path but `plan_dir` is stored relative, so the
	 * conversion (and the outside-the-tree rejection) happens here rather than
	 * failing in preflight hours into an unattended run.
	 */
	async function pickPlanDir() {
		planDirError = null;
		if (!workingDir.trim()) {
			planDirError = 'Set the job’s working directory first.';
			return;
		}
		const selected = await open({
			directory: true,
			multiple: false,
			defaultPath: workingDir.trim(),
			title: 'Select the plan directory'
		});
		if (typeof selected !== 'string') return;
		const result = planDirFromPicked(workingDir, selected);
		if (!result.ok) {
			planDirError = result.error;
			return;
		}
		cfg.plan_dir = result.relative;
	}
</script>

<div class="field">
	<span class="label">
		Plan directory <span class="required">(required)</span>
		<Tooltip
			label="About the plan directory"
			text="A folder of markdown plan files, stored relative to the working directory — typically a guided-planning job's output folder, but hand-written plans work too. The preflight interview reads every .md file in it, and any verification commands the plan declares are offered below."
		/>
	</span>
	<div class="dir-row">
		<input
			type="text"
			bind:value={cfg.plan_dir}
			placeholder="plan/my-feature/"
			list="plan-dir-suggestions"
			aria-label="Plan directory"
		/>
		<button type="button" class="browse" onclick={pickPlanDir}>Browse…</button>
	</div>
	<datalist id="plan-dir-suggestions">
		{#each planDirSuggestions as dir (dir)}
			<option value={dir}></option>
		{/each}
	</datalist>
	{#if planDirError}
		<span class="field-error">{planDirError}</span>
	{/if}
</div>

<div class="field context">
	<span class="label">
		Context
		<Tooltip
			label="About context mode"
			text="How much conversation context each unit of work gets. Continuous per phase keeps everything the model just learned in view, avoiding per-step re-reading, at the cost of a growing context. Fresh per step gives every checklist item a clean context that re-reads what it needs. Commits, step checks and phase verification are identical in both modes."
		/>
	</span>
	<select bind:value={cfg.context_mode} aria-label="Context mode">
		<option value="phase">Continuous per phase — one context per plan phase (default)</option>
		<option value="step">Fresh per step — clean context per checklist item</option>
	</select>
</div>

<div class="field use-git">
	<label class="check">
		<input type="checkbox" bind:checked={cfg.use_git} />
		<span>Use git</span>
	</label>
	<Tooltip
		label="About using git"
		text="Off means the run creates no branch, makes no commits and never touches git — for a machine without git installed, or a project you do not want versioned. The work still lands in the working directory and the report is still written; you simply have no per-phase history to roll back to."
	/>
</div>

{#if cfg.use_git}
	<div class="field signing">
		<span class="label">
			If commit signing becomes unavailable mid-run
			<Tooltip
				label="About the signing fallback"
				text="Commit signing agents (e.g. 1Password) need authorization. The run primes it with the baseline commit right after your preflight interview, but that authorization can expire overnight. Choose “Don't commit” for repos that reject unsigned commits — the loop keeps working and the report notes what went uncommitted."
			/>
		</span>
		<select bind:value={cfg.signing_fallback} aria-label="Signing fallback">
			<option value="unsigned">Commit unsigned — re-sign before pushing</option>
			<option value="skip">Don't commit — leave work uncommitted</option>
		</select>
	</div>
{/if}

<div class="field attempts">
	<span class="label">
		Max attempts per step
		<Tooltip
			label="About max attempts"
			text="How many failed attempts a single step gets before it is marked BLOCKED and the loop moves on to steps that don't depend on it. You wake up to maximum progress plus a list of what needs you."
		/>
	</span>
	<input
		type="number"
		min="1"
		max="10"
		bind:value={cfg.max_attempts}
		aria-label="Max attempts per step"
	/>
</div>

<div class="field attempts">
	<span class="label">
		Max model steps per turn
		<Tooltip
			label="About max model steps"
			text="Tool and model steps one coding turn may spend before its result is forced. Settings → Shell's 'Max steps per task' covers the chat shell only and never applies to a job. Raise it for phases that need many read/edit/test round-trips. Default 200. 50–600."
		/>
	</span>
	<input
		type="number"
		min="50"
		max="600"
		step="50"
		bind:value={cfg.max_turns}
		aria-label="Max model steps per turn"
	/>
</div>

{#if cfg.use_git}
	<div class="field branch">
		<label class="check">
			<input type="checkbox" bind:checked={cfg.create_branch} />
			<span>Create a working branch for this run</span>
		</label>
		<Tooltip
			label="About the working branch"
			text="Creates haruspex/autonomous-coding/<timestamp> before any work starts, so the baseline, every step commit and the report land on their own branch instead of your current one. A brand-new repo with no commits stays on its default branch, and a resumed run stays on the branch it already made."
		/>
		<span class="hint inline">(recommended)</span>
	</div>
{/if}

<div class="field web-research">
	<label class="check">
		<input type="checkbox" bind:checked={cfg.web_research} />
		<span>Web research during preflight</span>
	</label>
	<Tooltip
		label="About web research"
		text="Lets the preflight interview search the web to check versions and APIs newer than the model's training, and to compare options when the plan or your answers ask for research. The coding loop can always search. Searches go to the provider in Settings → Search."
	/>
</div>

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

	.label {
		display: inline-flex;
		align-items: center;
		gap: 2px;
	}

	.branch,
	.web-research {
		flex-direction: row;
		align-items: center;
		gap: 4px;
		font-size: 0.88rem;
	}

	.check {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}

	.hint.inline {
		font-style: normal;
		margin-left: 4px;
		color: var(--text-secondary);
	}

	.signing select,
	.context select {
		align-self: flex-start;
		min-width: 300px;
	}

	/* Text box + affordance on one line: the box stays authoritative, so a
	   bespoke path or command is always still typeable. */
	.dir-row,
	.dir-row input,
	.browse {
		flex-shrink: 0;
		white-space: nowrap;
		padding: 6px 12px;
		border: 1px solid var(--border-strong);
		border-radius: 7px;
		background: var(--bg-primary);
		color: var(--text-primary);
		font-size: 0.85rem;
		cursor: pointer;
	}

	.browse:hover {
		border-color: var(--text-secondary);
	}

	.field-error {
		font-size: 0.78rem;
		color: var(--error-text);
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
</style>
