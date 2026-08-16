<script lang="ts">
	import { onMount } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import { open } from '@tauri-apps/plugin-dialog';
	import Tooltip from '$lib/components/Tooltip.svelte';
	import { getJob, getJobs } from '$lib/stores/jobs.svelte';
	import { parseGuidedPlanningConfig } from '../guided-planning/config';
	import { normalizePlanDir, planDirFromPicked } from './config';
	import { buildCommandSuggestions, type CommandSuggestion } from './commandSuggestions';
	import { PHASE_FILE_RE, type PlanFile } from './planParse';
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

	// --- Command suggestions -------------------------------------------------
	// Read once per (working dir, plan dir) pair, then fed to the pure builder.
	// Failures are silent: suggestions are a convenience, and the fields stay
	// free text.
	let planFiles = $state<PlanFile[]>([]);
	let markers = $state<string[]>([]);
	let packageScripts = $state<string[]>([]);

	const MARKER_FILES = ['package.json', 'Cargo.toml', 'pyproject.toml', 'go.mod'];

	async function readPlanFiles(dir: string): Promise<PlanFile[]> {
		if (!workingDir.trim() || !dir.trim()) return [];
		try {
			const listing = await invoke<{ entries: { name: string; is_dir: boolean }[] }>(
				'fs_list_dir',
				{ workdir: workingDir, relPath: normalizePlanDir(dir) }
			);
			const names = listing.entries
				.filter((e) => !e.is_dir && e.name.toLowerCase().endsWith('.md'))
				.map((e) => e.name)
				// Phase files first: their declared commands are the ones the
				// runner will actually execute.
				.sort((a, b) => Number(PHASE_FILE_RE.test(b)) - Number(PHASE_FILE_RE.test(a)));
			const files: PlanFile[] = [];
			for (const name of names) {
				const content = await invoke<string>('fs_read_text_full', {
					workdir: workingDir,
					relPath: `${normalizePlanDir(dir)}${name}`
				});
				files.push({ name, content });
			}
			return files;
		} catch {
			return [];
		}
	}

	async function detectProject(): Promise<{ markers: string[]; scripts: string[] }> {
		if (!workingDir.trim()) return { markers: [], scripts: [] };
		const found: string[] = [];
		for (const marker of MARKER_FILES) {
			try {
				if (await invoke<boolean>('fs_path_exists', { workdir: workingDir, relPath: marker })) {
					found.push(marker);
				}
			} catch {
				// Unreadable working dir — no detection, catalog tier still applies.
			}
		}
		let scripts: string[] = [];
		if (found.includes('package.json')) {
			try {
				const raw = await invoke<string>('fs_read_text_full', {
					workdir: workingDir,
					relPath: 'package.json'
				});
				const parsed: unknown = JSON.parse(raw);
				const s = (parsed as { scripts?: Record<string, unknown> })?.scripts;
				if (s && typeof s === 'object') scripts = Object.keys(s);
			} catch {
				// A malformed package.json just means no script suggestions.
			}
		}
		return { markers: found, scripts };
	}

	// Re-read whenever either input changes — a plan dir typed after the
	// working dir is the normal order, and stale suggestions would be worse
	// than none.
	//
	// Debounced because both inputs are text fields: without it, typing
	// "plan/my-feature/" would fire a directory listing, a read per plan file
	// and four existence probes on every keystroke. The cancelled flag then
	// discards any in-flight result whose inputs have already moved on, so a
	// slow read can't overwrite newer suggestions.
	const SUGGEST_DEBOUNCE_MS = 300;
	$effect(() => {
		const dir = cfg.plan_dir;
		const wd = workingDir;
		void wd;
		let cancelled = false;
		const timer = setTimeout(async () => {
			const [files, project] = await Promise.all([readPlanFiles(dir), detectProject()]);
			if (cancelled) return;
			planFiles = files;
			markers = project.markers;
			packageScripts = project.scripts;
		}, SUGGEST_DEBOUNCE_MS);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	});

	const verifySuggestions = $derived(
		buildCommandSuggestions({ field: 'verify', planFiles, markers, packageScripts })
	);
	const stepCheckSuggestions = $derived(
		buildCommandSuggestions({ field: 'step-check', planFiles, markers, packageScripts })
	);

	const SOURCE_LABEL: Record<CommandSuggestion['source'], string> = {
		plan: 'From your plan',
		project: 'Detected in this project',
		catalog: 'Common commands'
	};

	/** Suggestions grouped for <optgroup>, preserving tier order. */
	function grouped(list: CommandSuggestion[]) {
		const order: CommandSuggestion['source'][] = ['plan', 'project', 'catalog'];
		return order
			.map((source) => ({ source, items: list.filter((s) => s.source === source) }))
			.filter((g) => g.items.length > 0);
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

{#if cfg.context_mode !== 'phase'}
	<div class="field">
		<span class="label">
			Step check — shell command run before every commit
			<span class="optional">(optional)</span>
			<Tooltip
				label="About the step check"
				text="A cheap static check — lint, typecheck, syntax — that the runner executes before every commit, so a broken file never lands. Its cost is paid on every step, so keep it fast. Chain several with && if the project spans languages."
			/>
		</span>
		{@render commandField(
			'step_check_command',
			stepCheckSuggestions,
			'Step check command',
			'step-check-suggestions'
		)}
		<span class="hint"
			><strong>Not sure? Leave it blank</strong> and preflight will settle it with you.</span
		>
	</div>
{/if}

<div class="field">
	<span class="label">
		Phase verification — shell command run when a phase completes
		<span class="optional">(optional)</span>
		<Tooltip
			label="About phase verification"
			text="The real proof, typically your test suite. The runner executes it when each phase of the plan completes — not after every step. If it fails, the run injects bounded repair steps until it passes or the phase is marked blocked. Exit code 0 counts as a pass."
		/>
	</span>
	{@render commandField(
		'verify_command',
		verifySuggestions,
		'Phase verification command',
		'verify-suggestions'
	)}
	<span class="hint">
		<strong>Not sure? Leave it blank.</strong> Preflight reads your repo, proposes both commands, runs
		them once to check they work, and asks you to confirm.
	</span>
</div>

{#snippet commandField(
	key: 'verify_command' | 'step_check_command',
	suggestions: CommandSuggestion[],
	ariaLabel: string,
	listId: string
)}
	<div class="cmd-row">
		<input
			type="text"
			bind:value={cfg[key]}
			placeholder="Leave blank and preflight will work it out with you"
			aria-label={ariaLabel}
			list={listId}
			spellcheck="false"
		/>
		{#if suggestions.length > 0}
			<!-- Writes into the text box rather than replacing it: the box stays
			     authoritative so bespoke commands remain possible, and the reset
			     to "" keeps the picker reusable. -->
			<select
				class="cmd-pick"
				aria-label={`${ariaLabel} suggestions`}
				value=""
				onchange={(e) => {
					const picked = e.currentTarget.value;
					if (picked) cfg[key] = picked;
					e.currentTarget.value = '';
				}}
			>
				<option value="">Suggestions…</option>
				{#each grouped(suggestions) as group (group.source)}
					<optgroup label={SOURCE_LABEL[group.source]}>
						{#each group.items as s (s.command + s.note)}
							<option value={s.command}>{s.command} — {s.note}</option>
						{/each}
					</optgroup>
				{/each}
			</select>
		{/if}
	</div>
	<datalist id={listId}>
		{#each suggestions as s (s.command + s.note)}
			<option value={s.command}></option>
		{/each}
	</datalist>
{/snippet}

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

	.label {
		display: inline-flex;
		align-items: center;
		gap: 2px;
	}

	.branch {
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
	.cmd-row {
		display: flex;
		gap: 6px;
		align-items: stretch;
	}

	.dir-row input,
	.cmd-row input {
		flex: 1;
		min-width: 0;
	}

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

	.cmd-pick {
		flex-shrink: 0;
		max-width: 170px;
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
