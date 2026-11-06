import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import type { JobTypeDefinition } from '#lib/agent/jobs/types/types.ts';
import JobCardForm from './JobCardForm.svelte';
import FakeEditor from './JobCardForm.fixture.svelte';

const jobType = {
	id: 'email_digest',
	label: 'Email digest',
	configDefaults: () => ({}),
	validate: () => null,
	Editor: FakeEditor
} as unknown as JobTypeDefinition;

function props(over: Record<string, unknown> = {}) {
	return {
		title: 'Important emails',
		jobType,
		open: true,
		defaultSchedule: { kind: 'interval' as const, minutes: 30 },
		onadd: vi.fn(async () => true),
		onuse: vi.fn(async () => true),
		ondone: vi.fn(),
		...over
	};
}

describe('JobCardForm', () => {
	it('offers no choice when there is no job to use', () => {
		render(JobCardForm, props());
		expect(screen.queryByRole('button', { name: 'Use a job' })).toBeNull();
		expect(screen.getByTestId('fake-editor')).toBeTruthy();
	});

	it('adds the card for a picked job instead of making one', async () => {
		const p = props({
			existingJobs: [
				{ id: 9, name: 'Work mail' },
				{ id: 12, name: 'Home mail' }
			]
		});
		render(JobCardForm, p);
		await fireEvent.click(screen.getByRole('button', { name: 'Use a job' }));
		expect(screen.queryByTestId('fake-editor')).toBeNull();
		await fireEvent.change(screen.getByRole('combobox'), { target: { value: '12' } });
		await fireEvent.click(screen.getByRole('button', { name: 'Add card' }));
		expect(p.onuse).toHaveBeenCalledWith(12);
		expect(p.onadd).not.toHaveBeenCalled();
		expect(p.ondone).toHaveBeenCalled();
	});
});
