<script lang="ts">
	/**
	 * Report issue, beside a failure: saves the diagnostics into Downloads,
	 * opens that folder and a pre-filled GitHub issue for this error (see
	 * `#lib/reportIssue.ts`). Styled for the red error bars it sits in.
	 */
	import { reportIssue } from '#lib/reportIssue.ts';
	import type { LogSource } from '#lib/reportLogs.ts';
	import { errMessage } from '#lib/utils/error.ts';

	interface Props {
		/** Where it failed, as the user knows it: "Chat", "Code tab". */
		where: string;
		error: string;
		/** The log nearest the failure, read when the button is pressed. */
		log?: LogSource;
		logTitle?: string;
		/** Sits after the error's text in the same line, so it needs a gap. */
		inline?: boolean;
	}

	let { where, error, log, logTitle, inline = false }: Props = $props();

	let phase = $state<'idle' | 'busy' | 'done' | 'failed'>('idle');
	let detail = $state('');

	async function report() {
		phase = 'busy';
		try {
			const path = await reportIssue({ where, error, log: await log?.(), logTitle });
			phase = 'done';
			detail = `Saved ${path}. Drag it onto the issue that opened in your browser.`;
		} catch (e) {
			console.warn('report issue failed', errMessage(e));
			phase = 'failed';
			detail = errMessage(e);
		}
	}
</script>

<button
	class="report-btn"
	class:inline
	onclick={report}
	disabled={phase === 'busy'}
	title={detail ||
		'Opens a pre-filled GitHub issue for this error, and saves the diagnostics in your Downloads folder to attach to it. Secrets, URL query strings and email addresses are removed.'}
>
	{#if phase === 'busy'}
		Preparing…
	{:else if phase === 'done'}
		Issue opened
	{:else if phase === 'failed'}
		Couldn't open issue
	{:else}
		Report issue
	{/if}
</button>

<style>
	.report-btn {
		background: transparent;
		color: var(--error-text);
		border: 1px solid var(--error-border);
		border-radius: 4px;
		padding: 3px 10px;
		font-size: 0.75rem;
		cursor: pointer;
	}

	.report-btn.inline {
		margin-left: 8px;
	}

	.report-btn:hover:not(:disabled) {
		background: color-mix(in srgb, var(--error-text) 10%, transparent);
	}

	.report-btn:disabled {
		opacity: 0.6;
		cursor: progress;
	}
</style>
