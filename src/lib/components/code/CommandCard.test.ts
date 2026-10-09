import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import CommandCard from './CommandCard.svelte';
import type { SearchStep } from '#lib/agent/loop.ts';

function step(result: string, overrides: Partial<SearchStep> = {}): SearchStep {
	return {
		id: 'c1',
		toolName: 'run_command',
		query: 'npm test',
		status: 'done',
		args: { command: 'npm test' },
		result,
		...overrides
	};
}

describe('CommandCard', () => {
	it('shows the last 20 lines of long output until expanded', async () => {
		const out = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
		const { container } = render(CommandCard, { step: step(`Exit code: 1 (2400ms)\n${out}`) });
		const pre = () => container.querySelector('pre')!.textContent!;
		expect(pre().split('\n')).toHaveLength(20);
		expect(pre()).toContain('line 30');
		expect(pre()).not.toContain('line 10\n');
		expect(screen.getByText('exit 1')).toBeTruthy();
		expect(screen.getByText('2.4 s')).toBeTruthy();
		await fireEvent.click(screen.getByRole('button', { name: 'Show all 30 lines' }));
		expect(pre().split('\n')).toHaveLength(30);
	});

	it('shows short output whole, with no expand button', () => {
		render(CommandCard, { step: step('Exit code: 0 (3ms)\nok') });
		expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull();
		expect(screen.getByText('ok')).toBeTruthy();
	});

	it('shows a refusal instead of output', () => {
		render(CommandCard, { step: step('{"error":"Denied by the user."}') });
		expect(screen.getByText('Denied by the user.')).toBeTruthy();
		expect(screen.getByText('not run')).toBeTruthy();
	});
});
