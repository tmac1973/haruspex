import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';

const settings = vi.hoisted(() => ({
	codeHelpers: {} as Record<string, boolean>
}));
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings,
		getLiveSettings: () => settings
	})
);
const toasts = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('#lib/stores/toasts.svelte.ts', () => toasts);

import { helpers } from '#lib/helpers/registry.ts';
import ExtrasMenu from './ExtrasMenu.svelte';

function session(over: Record<string, unknown> = {}) {
	return {
		helpers: null as string[] | null,
		readOnly: false,
		busy: false,
		setSessionHelpers: vi.fn(async () => {}),
		...over
	};
}

function open(s: ReturnType<typeof session>) {
	render(ExtrasMenu, { props: { session: s as never } });
	return fireEvent.click(screen.getByRole('button', { name: /Extras/ }));
}

const box = (name: string) => screen.getByLabelText(name) as HTMLInputElement;

beforeEach(() => {
	settings.codeHelpers = {};
	toasts.showToast.mockReset();
});

describe('the Extras menu', () => {
	it('lists the helpers only, and counts the ones on', async () => {
		await open(session());
		// The Web preview helper is on by default; 3D is not.
		screen.getByRole('button', { name: /Extras: 1/ });
		screen.getByText('Helpers');
		// One heading, and a box for each helper and nothing else.
		expect(document.querySelectorAll('.heading')).toHaveLength(1);
		expect(screen.getAllByRole('checkbox')).toHaveLength(helpers().length);
		expect(box('Web preview').checked).toBe(true);
		expect(box('3D').checked).toBe(false);
		expect((screen.getByText('Use defaults') as HTMLButtonElement).disabled).toBe(true);
	});

	it('shows helpers on as Settings has them until the session chooses', async () => {
		settings.codeHelpers = { '3d': true };
		const s = session();
		await open(s);
		screen.getByRole('button', { name: /Extras: 2/ });
		expect(box('3D').checked).toBe(true);
		await fireEvent.click(box('3D'));
		expect(s.setSessionHelpers).toHaveBeenCalledWith(['preview']);
	});

	it("counts the session's own choice", async () => {
		await open(session({ helpers: ['3d', 'preview'] }));
		screen.getByRole('button', { name: /Extras: 2/ });
	});

	it('goes back to the defaults', async () => {
		const s = session({ helpers: ['3d'] });
		await open(s);
		expect(box('3D').checked).toBe(true);
		await fireEvent.click(screen.getByText('Use defaults'));
		await vi.waitFor(() => expect(s.setSessionHelpers).toHaveBeenCalledWith(null));
	});

	it("can't turn on a writing helper in a read-only session", async () => {
		await open(session({ readOnly: true }));
		expect(box('3D').disabled).toBe(true);
	});

	it('says so when the change could not be saved', async () => {
		const s = session({
			setSessionHelpers: vi.fn(async () => Promise.reject(new Error('db')))
		});
		await open(s);
		await fireEvent.click(box('3D'));
		await vi.waitFor(() => expect(toasts.showToast).toHaveBeenCalled());
		expect(toasts.showToast.mock.calls[0][0]).toMatch(/Couldn't change the helpers: db/);
	});
});
