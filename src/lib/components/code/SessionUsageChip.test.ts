import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import SessionUsageChip from './SessionUsageChip.svelte';
import { emptyUsage } from '#lib/code/usageTotals.ts';

describe('the session usage chip', () => {
	it('is hidden before the first model call', () => {
		render(SessionUsageChip, { props: { totals: emptyUsage() } });
		expect(screen.queryByTestId('session-usage')).toBeNull();
	});

	it('shows tokens alone for a model with no cost, the breakdown on hover', () => {
		render(SessionUsageChip, {
			props: { totals: { ...emptyUsage(), promptTokens: 12_000, completionTokens: 345, calls: 3 } }
		});
		const chip = screen.getByTestId('session-usage');
		expect(chip.textContent?.trim()).toBe('12k tok');
		expect(chip.title).toMatch(/12,345 tokens over 3 model calls/);
		expect(chip.title).not.toMatch(/Cost/);
		expect(chip.title).not.toMatch(/Sub-agents/);
	});

	it('gives the sub-agents’ share on hover', () => {
		render(SessionUsageChip, {
			props: {
				totals: {
					...emptyUsage(),
					promptTokens: 3000,
					calls: 3,
					subagentTokens: 1000,
					subagentCalls: 2
				}
			}
		});
		expect(screen.getByTestId('session-usage').title).toMatch(
			/Sub-agents: 1,000 tokens over 2 calls/
		);
	});

	it('adds the cost, marked when part of it is estimated', () => {
		render(SessionUsageChip, {
			props: {
				totals: {
					...emptyUsage(),
					promptTokens: 1000,
					completionTokens: 0,
					calls: 1,
					costUsd: 0.125,
					estimated: true
				}
			}
		});
		const chip = screen.getByTestId('session-usage');
		expect(chip.textContent).toMatch(/1\.0k tok · ~\$0\.13/);
		expect(chip.title).toMatch(/estimated/);
	});
});
