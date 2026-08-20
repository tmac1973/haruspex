import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import JobRunStats from './JobRunStats.svelte';
import type { StepThinkingStats } from '$lib/agent/jobs/runner.svelte';

function stats(over: Partial<StepThinkingStats> = {}): StepThinkingStats {
	return {
		reasoningMs: 600,
		totalMs: 1000,
		reasoningTokens: 60,
		totalTokens: 100,
		promptTokens: 4000,
		peakPromptTokens: 4000,
		reasoningExact: true,
		calls: 1,
		...over
	};
}

describe('JobRunStats', () => {
	/**
	 * An old run is not a free run. Rendering a table of dashes for a run that
	 * predates token accounting would read as "this cost nothing", which is
	 * the one thing the card must never imply.
	 */
	it('says not recorded rather than showing an empty table', () => {
		render(JobRunStats, {
			rows: [
				{ label: 'Overview', stats: null },
				{ label: 'Planning', stats: null }
			],
			contextSize: 32768
		});
		expect(screen.getByText('Not recorded for this run.')).toBeTruthy();
		expect(screen.queryByText('Run total')).toBeNull();
	});

	it('sums tokens across phases and takes the max of the peaks', () => {
		render(JobRunStats, {
			rows: [
				{ label: 'Overview', stats: stats({ promptTokens: 4000, peakPromptTokens: 4000 }) },
				{ label: 'Planning', stats: stats({ promptTokens: 8000, peakPromptTokens: 9000 }) }
			],
			contextSize: 32768
		});
		const footer = screen.getByText('Run total').closest('tr')!;
		// In: 4000 + 8000 summed — every call re-sends its prompt.
		expect(footer.textContent).toContain('12K');
		// Peak: 9000, NOT 13000. The run's peak is the largest single prompt
		// anywhere in it; adding peaks together would be meaningless.
		expect(footer.textContent).toContain('9K (27%)');
	});

	it('marks the total estimated when any phase estimated', () => {
		render(JobRunStats, {
			rows: [
				{ label: 'Overview', stats: stats({ reasoningExact: true }) },
				{ label: 'Planning', stats: stats({ reasoningExact: false }) }
			],
			contextSize: 32768
		});
		const footer = screen.getByText('Run total').closest('tr')!;
		expect(footer.textContent).toContain('~');
		expect(screen.getByText(/apportioned by character count/)).toBeTruthy();
	});

	it('drops the estimate mark when every phase reported an exact split', () => {
		render(JobRunStats, {
			rows: [{ label: 'Overview', stats: stats({ reasoningExact: true }) }],
			contextSize: 32768
		});
		const footer = screen.getByText('Run total').closest('tr')!;
		expect(footer.textContent).not.toContain('~');
		expect(screen.queryByText(/apportioned by character count/)).toBeNull();
	});

	it('renders a phase with no model calls as a dash and excludes it from totals', () => {
		render(JobRunStats, {
			rows: [
				{ label: 'Planning', stats: stats({ promptTokens: 5000, calls: 3 }) },
				// A checkpoint stage waiting on the user.
				{ label: 'Approval', stats: null }
			],
			contextSize: 32768
		});
		const approval = screen.getByText('Approval').closest('tr')!;
		expect(approval.textContent).toContain('—');
		const footer = screen.getByText('Run total').closest('tr')!;
		expect(footer.textContent).toContain('5K');
		// Only the phase that ran counts toward calls.
		expect(footer.textContent).toContain('3');
		expect(screen.getByText(/1 of 2 phases recorded/)).toBeTruthy();
	});

	/**
	 * Generation throughput per phase — the figure that makes a slow phase
	 * visible next to a fast one. Out / model time, so it is comparable
	 * between phases rather than being the model's peak decode rate.
	 */
	it('reports average tg/s per phase and for the run', () => {
		render(JobRunStats, {
			rows: [
				// 100 tokens in 1s → 100 tg/s.
				{ label: 'Overview', stats: stats({ totalTokens: 100, totalMs: 1000 }) },
				// 300 tokens in 60s → 5 tg/s.
				{ label: 'Planning', stats: stats({ totalTokens: 300, totalMs: 60000 }) }
			],
			contextSize: 32768
		});
		// Assert on the tg/s cell itself: Out carries the same digits, so a
		// whole-row check would pass without the column existing at all.
		const rate = (label: string) =>
			screen.getByText(label).closest('tr')!.querySelector('td:nth-child(7)')!.textContent;
		expect(rate('Overview')).toBe('100');
		expect(rate('Planning')).toBe('5.0');
		// Run total is the aggregate rate (400 tokens / 61s), not the mean of
		// the two rates — which would read 52.5 and mean nothing.
		expect(rate('Run total')).toBe('6.6');
	});

	it('shows a dash rather than dividing by zero when no time was recorded', () => {
		render(JobRunStats, {
			rows: [{ label: 'Overview', stats: stats({ totalTokens: 100, totalMs: 0 }) }],
			contextSize: 32768
		});
		const cell = screen.getByText('Overview').closest('tr')!.querySelector('td:nth-child(7)')!;
		expect(cell.textContent).toBe('—');
	});

	/**
	 * A run's numbers only mean something next to what produced them, and the
	 * job's model/reasoning settings can be edited after a run finishes — so
	 * the card shows what was recorded WITH the run, or nothing.
	 */
	it('shows the model, thinking state and effort the run used', () => {
		render(JobRunStats, {
			rows: [{ label: 'Overview', stats: stats() }],
			contextSize: 32768,
			environment: {
				modelId: 'Qwen3.6-35B-A3B',
				modelThinking: true,
				modelEffort: 'high',
				contextSize: 32768
			}
		});
		expect(screen.getByText('Qwen3.6-35B-A3B')).toBeTruthy();
		expect(screen.getByText('thinking on')).toBeTruthy();
		expect(screen.getByText('effort high')).toBeTruthy();
	});

	it('says thinking off rather than dropping the line', () => {
		render(JobRunStats, {
			rows: [{ label: 'Overview', stats: stats() }],
			contextSize: null,
			environment: {
				modelId: 'gpt-oss-120b',
				modelThinking: false,
				modelEffort: null,
				contextSize: null
			}
		});
		expect(screen.getByText('thinking off')).toBeTruthy();
		expect(screen.queryByText(/^effort/)).toBeNull();
	});

	it('omits the environment line for a run that predates the recording', () => {
		render(JobRunStats, {
			rows: [{ label: 'Overview', stats: stats() }],
			contextSize: 32768,
			environment: null
		});
		expect(screen.queryByText(/thinking/)).toBeNull();
	});

	it('offers the export only when there is something to export', () => {
		const meta = {
			jobName: 'Hangman',
			jobType: 'guided_planning',
			runId: 3,
			startedAt: null,
			finishedAt: null
		};
		render(JobRunStats, { rows: [{ label: 'Overview', stats: stats() }], contextSize: null, meta });
		expect(screen.getByText('Export JSON')).toBeTruthy();
	});

	it('hides the export when no phase recorded anything', () => {
		render(JobRunStats, {
			rows: [{ label: 'Overview', stats: null }],
			contextSize: null,
			meta: {
				jobName: 'Hangman',
				jobType: 'guided_planning',
				runId: 3,
				startedAt: null,
				finishedAt: null
			}
		});
		expect(screen.queryByText('Export JSON')).toBeNull();
	});

	it('omits the context percentage when no window is known', () => {
		// The past-run view has no stored context size; showing a percentage
		// there would be a percentage of a guess.
		render(JobRunStats, {
			rows: [{ label: 'Step 1', stats: stats({ peakPromptTokens: 9000 }) }],
			contextSize: null
		});
		// Assert on the peak cell itself: the Thinking column carries a
		// percentage of its own, so a whole-row check would always match.
		const peakCell = screen.getByText('Run total').closest('tr')!.querySelector('td:last-child')!;
		expect(peakCell.textContent).toBe('9K');
	});
});
