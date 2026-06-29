<script lang="ts">
	/**
	 * Modal for the reusable ask_user_question primitive. Mounted once in the
	 * root layout — subscribes to the userQuestion store and opens whenever a
	 * question is pending.
	 *
	 * Supports single- or multi-select options (each with an optional description
	 * and a "recommended" highlight) plus an always-present "Write your own
	 * answer" choice. That choice is a member of the same selection group (the
	 * "Other (please specify)" pattern), so exactly one thing is ever active and
	 * submission is unambiguous: choosing it deselects the options and reveals a
	 * text box; choosing an option hides it.
	 *
	 * Backdrop/Esc do NOT dismiss: a pending question must be answered.
	 * Cancellation is the run's concern (job-cancel), not the modal's.
	 */
	import Modal from './Modal.svelte';
	import { getPendingQuestion, resolveUserQuestion } from '$lib/stores/userQuestion.svelte';

	const pending = $derived(getPendingQuestion());

	let selected = $state<string[]>([]);
	// True when the "Write your own answer" option is chosen — mutually exclusive
	// with the prefilled options.
	let useFreeText = $state(false);
	let freeText = $state('');
	let textareaEl = $state<HTMLTextAreaElement | undefined>();
	// Identity of the question the local form state belongs to; used to reset the
	// form when a different question becomes pending (the modal instance is reused).
	let formFor = $state<unknown>(null);

	$effect(() => {
		if (pending !== formFor) {
			formFor = pending;
			selected = [];
			freeText = '';
			useFreeText = false;
		}
	});

	// Focus the text box the moment "Write your own answer" is chosen.
	$effect(() => {
		if (useFreeText) textareaEl?.focus();
	});

	function toggleOption(label: string) {
		const p = pending;
		if (!p) return;
		useFreeText = false;
		if (p.allowMultiple) {
			selected = selected.includes(label)
				? selected.filter((l) => l !== label)
				: [...selected, label];
		} else {
			selected = [label];
		}
	}

	function chooseFreeText() {
		useFreeText = true;
		selected = [];
	}

	const canSubmit = $derived(useFreeText ? freeText.trim().length > 0 : selected.length > 0);

	function submit() {
		if (!pending || !canSubmit) return;
		if (useFreeText) {
			resolveUserQuestion({ kind: 'freeText', text: freeText.trim() });
		} else {
			resolveUserQuestion({ kind: 'selected', labels: selected });
		}
	}
</script>

<Modal open={pending != null} maxWidth={580} labelledBy="user-question-title">
	{#if pending}
		<h2 id="user-question-title">{pending.question}</h2>
		{#if pending.allowMultiple}
			<p class="hint">Select one or more, or write your own answer.</p>
		{/if}

		<div class="options">
			{#each pending.options as opt (opt.label)}
				<button
					type="button"
					class="option"
					class:selected={!useFreeText && selected.includes(opt.label)}
					onclick={() => toggleOption(opt.label)}
				>
					<span class="marker" class:multi={pending.allowMultiple} aria-hidden="true"></span>
					<span class="body">
						<span class="label">
							{opt.label}
							{#if opt.recommended}<span class="badge">Recommended</span>{/if}
						</span>
						{#if opt.description}<span class="desc">{opt.description}</span>{/if}
					</span>
				</button>
			{/each}

			<!-- "Other" — a member of the same group so selection stays unambiguous.
			     Always a radio (round) marker: it's an exclusive alternative even when
			     the prefilled options are multi-select checkboxes. -->
			<button type="button" class="option" class:selected={useFreeText} onclick={chooseFreeText}>
				<span class="marker" aria-hidden="true"></span>
				<span class="body">
					<span class="label">Write your own answer</span>
					<span class="desc">Type a different answer instead of picking above.</span>
				</span>
			</button>
		</div>

		{#if useFreeText}
			<textarea
				bind:this={textareaEl}
				class="free-input"
				rows="3"
				placeholder="Type your answer…"
				bind:value={freeText}
			></textarea>
		{/if}

		<div class="actions">
			<button type="button" class="submit" disabled={!canSubmit} onclick={submit}>Submit</button>
		</div>
	{/if}
</Modal>

<style>
	h2 {
		margin: 0 0 4px;
		font-size: 1.05rem;
		line-height: 1.35;
	}

	.hint {
		margin: 0 0 8px;
		font-size: 0.78rem;
		color: var(--text-secondary);
	}

	.options {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin-top: 12px;
	}

	.option {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		text-align: left;
		padding: 10px 12px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-primary);
		color: var(--text-primary);
		cursor: pointer;
		transition:
			border-color 0.15s,
			background 0.15s;
	}

	.option:hover {
		border-color: var(--accent);
	}

	.option.selected {
		border-color: var(--accent);
		background: var(--bg-secondary);
	}

	.marker {
		flex: 0 0 auto;
		width: 16px;
		height: 16px;
		margin-top: 2px;
		border: 1px solid var(--border);
		border-radius: 50%;
		transition:
			border-color 0.15s,
			background 0.15s;
	}

	.marker.multi {
		border-radius: 4px;
	}

	.option.selected .marker {
		border-color: var(--accent);
		background: var(--accent);
		box-shadow: inset 0 0 0 3px var(--bg-primary);
	}

	.body {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.label {
		font-size: 0.92rem;
		font-weight: 500;
	}

	.badge {
		margin-left: 6px;
		padding: 1px 6px;
		border-radius: 999px;
		font-size: 0.68rem;
		font-weight: 600;
		vertical-align: middle;
		color: var(--accent);
		background: var(--bg-secondary);
		border: 1px solid var(--accent);
	}

	.desc {
		font-size: 0.78rem;
		color: var(--text-secondary);
	}

	.free-input {
		width: 100%;
		box-sizing: border-box;
		resize: vertical;
		margin-top: 8px;
		padding: 8px 10px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-primary);
		color: var(--text-primary);
		font: inherit;
		font-size: 0.86rem;
	}

	.free-input:focus {
		outline: none;
		border-color: var(--accent);
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		margin-top: 16px;
	}

	.submit {
		padding: 8px 18px;
		border: 1px solid var(--accent);
		border-radius: 8px;
		background: var(--accent);
		color: var(--bg-primary);
		font-size: 0.88rem;
		font-weight: 500;
		cursor: pointer;
	}

	.submit:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
