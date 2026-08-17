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
