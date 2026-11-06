import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import type { SpecialistEntry } from '#lib/specialists/types.ts';

const settings = vi.hoisted(() => ({
	specialists: [] as SpecialistEntry[],
	codeHelpers: {} as Record<string, boolean>
}));
vi.mock('#lib/stores/settings.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/stores/settings.ts')>()),
	getSettings: () => settings,
	getLiveSettings: () => settings
}));
const toasts = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('#lib/stores/toasts.svelte.ts', () => toasts);

import { registerSpecialistKind } from '#lib/specialists/kinds.ts';
import ExtrasMenu from './ExtrasMenu.svelte';

registerSpecialistKind({
	id: 'menu-writer',
	label: 'Writer',
	summary: '',
	defaultDescription: '',
	defaultSystemPrompt: '',
	defaultSampling: { max_tokens: 1 },
	writes: true,
	params: {},
	requestRequired: false,
	run: async () => ({ result: '' })
});

function entry(id: string, kind = 'text', onByDefault = false): SpecialistEntry {
	return {
		id,
		name: id,
		kind,
		url: 'http://s:1',
		keyId: null,
		model: 'm',
		description: null,
		systemPrompt: null,
		sampling: null,
		onByDefault,
		acceptsImages: false
	};
}

function session(over: Record<string, unknown> = {}) {
	return {
		specialists: null as string[] | null,
		helpers: null as string[] | null,
		readOnly: false,
		busy: false,
		setSessionSpecialists: vi.fn(async () => {}),
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
	settings.specialists = [
		entry('Regex', 'text', true),
		entry('SQL'),
		entry('Builder', 'menu-writer')
	];
	settings.codeHelpers = {};
	toasts.showToast.mockReset();
});

describe('the Extras menu', () => {
	it('still shows the helpers while there are no specialists', async () => {
		settings.specialists = [];
		await open(session());
		expect(screen.queryByText('Specialists')).toBeNull();
		expect(box('3D').checked).toBe(false);
	});

	it('shows the defaults for a session that never chose', async () => {
		await open(session());
		screen.getByRole('button', { name: /Extras: 1/ });
		expect(box('Regex').checked).toBe(true);
		expect(box('SQL').checked).toBe(false);
		expect((screen.getByText('Use defaults') as HTMLButtonElement).disabled).toBe(true);
	});

	it('stores the whole list when one is toggled', async () => {
		const s = session();
		await open(s);
		await fireEvent.click(box('SQL'));
		expect(s.setSessionSpecialists).toHaveBeenCalledWith(['Regex', 'SQL']);
	});

	it('goes back to the defaults', async () => {
		const s = session({ specialists: ['SQL'] });
		await open(s);
		expect(box('Regex').checked).toBe(false);
		await fireEvent.click(screen.getByText('Use defaults'));
		expect(s.setSessionSpecialists).toHaveBeenCalledWith(null);
	});

	it('lists helpers, on as Settings has them until the session chooses', async () => {
		settings.codeHelpers = { '3d': true };
		const s = session();
		await open(s);
		screen.getByRole('button', { name: /Extras: 2/ });
		expect(box('3D').checked).toBe(true);
		await fireEvent.click(box('3D'));
		expect(s.setSessionHelpers).toHaveBeenCalledWith([]);
		expect(s.setSessionSpecialists).not.toHaveBeenCalled();
	});

	it('puts both lists back on the defaults', async () => {
		const s = session({ specialists: ['SQL'], helpers: ['3d'] });
		await open(s);
		expect(box('3D').checked).toBe(true);
		await fireEvent.click(screen.getByText('Use defaults'));
		await vi.waitFor(() => expect(s.setSessionHelpers).toHaveBeenCalledWith(null));
		expect(s.setSessionSpecialists).toHaveBeenCalledWith(null);
	});

	it("can't turn on a writing specialist in a read-only session", async () => {
		await open(session({ readOnly: true }));
		expect(box('Builder').disabled).toBe(true);
		expect(box('SQL').disabled).toBe(false);
		expect(box('3D').disabled).toBe(true);
	});

	it('says so when the change could not be saved', async () => {
		const s = session({
			setSessionSpecialists: vi.fn(async () => Promise.reject(new Error('db')))
		});
		await open(s);
		await fireEvent.click(box('SQL'));
		await vi.waitFor(() => expect(toasts.showToast).toHaveBeenCalled());
		expect(toasts.showToast.mock.calls[0][0]).toMatch(/Couldn't change the specialists: db/);
	});
});
