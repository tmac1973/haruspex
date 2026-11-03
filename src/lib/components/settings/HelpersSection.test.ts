import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import type { HelperDef } from '#lib/helpers/registry.ts';

const state = vi.hoisted(() => ({
	helpers: [] as HelperDef[],
	codeHelpers: {} as Record<string, boolean>
}));
vi.mock('#lib/helpers/registry.ts', () => ({ helpers: () => state.helpers }));
vi.mock('#lib/helpers/index.ts', () => ({}));
const setCodeHelper = vi.hoisted(() =>
	vi.fn((id: string, on: boolean) => {
		state.codeHelpers = { ...state.codeHelpers, [id]: on };
	})
);
vi.mock('#lib/stores/settings.ts', () => ({
	getSettings: () => ({ codeHelpers: state.codeHelpers }),
	setCodeHelper
}));

import HelpersSection from './HelpersSection.svelte';
import FakeEditor from './HelpersSection.fixture.svelte';

const threeD: HelperDef = {
	id: '3d',
	label: '3D',
	summary: 'Builds and renders 3D models the agent writes.',
	tooltip: 'More detail.',
	tools: ['check_3d'],
	writes: true
};

beforeEach(() => {
	state.helpers = [];
	state.codeHelpers = {};
	setCodeHelper.mockClear();
});

describe('HelpersSection', () => {
	it('says so when there are no helpers', () => {
		render(HelpersSection);
		expect(screen.getByText('No helpers yet.')).toBeTruthy();
	});

	it('shows each helper off by default, and saves a switch', async () => {
		state.helpers = [threeD];
		render(HelpersSection);
		const box = screen.getByRole('checkbox') as HTMLInputElement;
		expect(box.checked).toBe(false);
		expect(box.closest('label')?.getAttribute('title')).toBe('More detail.');
		await fireEvent.click(box);
		expect(setCodeHelper).toHaveBeenCalledWith('3d', true);
		expect(box.checked).toBe(true);
	});

	it('shows a helper’s settings only while its switch is on', async () => {
		state.helpers = [
			{
				...threeD,
				settings: { parse: (raw) => raw, component: async () => ({ default: FakeEditor }) }
			}
		];
		render(HelpersSection);
		expect(screen.queryByTestId('fake-editor')).toBeNull();
		await fireEvent.click(screen.getByRole('checkbox'));
		expect((await screen.findByTestId('fake-editor')).textContent).toBe('editing 3d');
		await fireEvent.click(screen.getByRole('checkbox'));
		expect(screen.queryByTestId('fake-editor')).toBeNull();
	});

	it('reflects a helper already on', () => {
		state.helpers = [threeD];
		state.codeHelpers = { '3d': true };
		render(HelpersSection);
		expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
	});
});
