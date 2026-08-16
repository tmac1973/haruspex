<script lang="ts">
	import PromptCatalog from '$lib/components/jobs/PromptCatalog.svelte';
	import Tooltip from '$lib/components/Tooltip.svelte';
	import type { JobStepInput } from '$lib/stores/jobs.svelte';
	import { DEFAULT_SAMPLE_INSTRUCTIONS, DEFAULT_VERIFY_INSTRUCTIONS } from './auditPipeline';
	import type { AuditEditorState } from './definition';

	// The audit-specific section of the job editor (see JobTypeEditorProps).
	// The audit prompt reuses steps[0].prompt so the persistence path stays
	// shared with research. `config` is JobEditor's deeply-reactive state for
	// this type; the alias below narrows it (stable identity — JobEditor
	// remounts this component whenever it swaps the object).
	let {
		config = $bindable(),
		steps = $bindable()
	}: {
		config: Record<string, unknown>;
		steps: JobStepInput[];
	} = $props();

	const cfg = config as unknown as AuditEditorState;

	function updatePrompt(value: string) {
		const next = [...steps];
		next[0] = { ...(next[0] ?? { deep_research: false }), prompt: value };
		steps = next;
	}
</script>

<div class="field">
	<div class="field-head">
		<span class="label">
			Audit prompt
			<Tooltip
				label="About the audit prompt"
				text="The instruction each sample run executes, independently. Ask for findings anchored to files and line ranges — the verification phase re-checks each one against the source, and an unanchored finding cannot be checked."
			/>
		</span>
		<PromptCatalog jobType="audit" current={steps[0]?.prompt ?? ''} oninsert={updatePrompt} />
	</div>
	<span class="hint">Run {cfg.num_runs}× independently.</span>
	<textarea
		value={steps[0]?.prompt ?? ''}
		oninput={(e) => updatePrompt((e.currentTarget as HTMLTextAreaElement).value)}
		placeholder="e.g. Find every instance of duplicated logic in this codebase. Anchor each finding to a file and line range, with a short explanation."
		rows="4"
	></textarea>
</div>

<div class="audit-grid">
	<div class="field">
		<span class="label">
			Number of runs
			<Tooltip
				label="About the number of runs"
				text="How many independent sample runs to execute (1–20). Findings that several runs agree on are the ones worth trusting, so more runs buy confidence at a proportional cost in time."
			/>
		</span>
		<input type="number" min="1" max="20" bind:value={cfg.num_runs} aria-label="Number of runs" />
	</div>
	<div class="field">
		<span class="label">
			Max turns per run
			<Tooltip
				label="About the turn budget"
				text="Agent-loop turn budget per run — how many read/grep steps each sample may take before it must report. A thorough audit of a large codebase can need 100+. Default 200, max 400."
			/>
		</span>
		<input
			type="number"
			min="1"
			max="400"
			step="10"
			bind:value={cfg.max_iterations}
			aria-label="Max turns per run"
		/>
	</div>
	<div class="field span2">
		<span class="label">
			Output file <span class="optional">(optional)</span>
			<Tooltip
				label="About the output file"
				text="File, relative to the working directory, that the final meta-report is written to. Leave blank to keep it only in the run record."
			/>
		</span>
		<input
			type="text"
			bind:value={cfg.output_file}
			placeholder="AUDIT.md"
			aria-label="Output file"
		/>
	</div>
</div>

<div class="field checkbox">
	<label class="check">
		<input type="checkbox" bind:checked={cfg.read_only} />
		<span>Read-only runs</span>
	</label>
	<Tooltip
		label="About read-only runs"
		text="When on (recommended), sample and verification runs may read and grep the code but cannot modify files. An audit that can edit is no longer an audit."
	/>
	<span class="hint inline">(recommended)</span>
</div>

<details class="advanced-prompts">
	<summary>Advanced: edit the exact prompts sent to the model</summary>
	<p class="hint">
		Both are sent verbatim to the model. A poor prompt can hurt result quality; use
		<strong>Reset</strong> to restore the default.
	</p>

	<div class="field">
		<span class="label-row">
			<span class="label">
				Per-run addendum
				<Tooltip
					label="About the per-run addendum"
					text="Appended after your audit prompt on every sample run (phase 1) — investigation guidance plus how to report findings. The submit_findings call is enforced automatically, so editing this cannot break capture."
				/>
			</span>
			<button
				type="button"
				class="reset-btn"
				disabled={cfg.sample_instructions === DEFAULT_SAMPLE_INSTRUCTIONS}
				onclick={() => (cfg.sample_instructions = DEFAULT_SAMPLE_INSTRUCTIONS)}
			>
				Reset
			</button>
		</span>
		<textarea bind:value={cfg.sample_instructions} rows="6"></textarea>
	</div>

	<div class="field">
		<span class="label-row">
			<span class="label">
				Verification instructions
				<Tooltip
					label="About verification instructions"
					text="Sent to the model that re-checks each finding against the source (phase 3) before it is kept. The finding's location and claim are prepended automatically, and the submit_verdict call is enforced."
				/>
			</span>
			<button
				type="button"
				class="reset-btn"
				disabled={cfg.verify_instructions === DEFAULT_VERIFY_INSTRUCTIONS}
				onclick={() => (cfg.verify_instructions = DEFAULT_VERIFY_INSTRUCTIONS)}
			>
				Reset
			</button>
		</span>
		<textarea bind:value={cfg.verify_instructions} rows="8"></textarea>
	</div>
</details>

<style>
	.label {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		font-size: 0.82rem;
		color: var(--text-secondary);
	}

	.optional {
		font-weight: normal;
		opacity: 0.7;
	}

	.hint {
		font-style: italic;
	}

	.hint.inline {
		font-style: normal;
		margin-left: 4px;
	}

	.field.checkbox {
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

	.audit-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 12px;
	}

	.audit-grid .span2 {
		grid-column: 1 / -1;
	}

	.field-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.advanced-prompts {
		border: 1px solid var(--border);
		border-radius: 4px;
		padding: 8px 10px;
	}

	.advanced-prompts > summary {
		cursor: pointer;
		font-size: 0.82rem;
		color: var(--text-secondary);
		user-select: none;
	}

	.advanced-prompts .field {
		margin-top: 10px;
	}

	.label-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.reset-btn {
		padding: 2px 8px;
		font-size: 0.72rem;
		border: 1px solid var(--border);
		background: var(--bg-primary);
		color: var(--text-secondary);
		border-radius: 4px;
		cursor: pointer;
	}

	.reset-btn:hover:not(:disabled) {
		border-color: var(--text-secondary);
		color: var(--text-primary);
	}

	.reset-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
</style>
