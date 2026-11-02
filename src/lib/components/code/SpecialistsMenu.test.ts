import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import type { SpecialistEntry } from '#lib/specialists/types.ts';

const settings = vi.hoisted(() => ({ specialists: [] as SpecialistEntry[] }));
vi.mock('#lib/stores/settings.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/stores/settings.ts')>()),
	getSettings: () => settings,
	getLiveSettings: () => settings
}));
const toasts = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('#lib/stores/toasts.svelte.ts', () => toasts);

import { registerSpecialistKind } from '#lib/specialists/kinds.ts';
import SpecialistsMenu from './SpecialistsMenu.svelte';

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
		readOnly: false,
		busy: false,
		setSessionSpecialists: vi.fn(async () => {}),
		...over
	};
}

function open(s: ReturnType<typeof session>) {
	render(SpecialistsMenu, { props: { session: s as never } });
	return fireEvent.click(screen.getByRole('button', { name: /Specialists/ }));
}

const box = (name: string) => screen.getByLabelText(name) as HTMLInputElement;

beforeEach(() => {
	settings.specialists = [
		entry('Regex', 'text', true),
		entry('SQL'),
		entry('Builder', 'menu-writer')
	];
	toasts.showToast.mockReset();
});

describe('the Specialists menu', () => {
	it('is hidden while there are no specialists', () => {
		settings.specialists = [];
		render(SpecialistsMenu, { props: { session: session() as never } });
		expect(screen.queryByRole('button', { name: /Specialists/ })).toBeNull();
	});

	it('shows the defaults for a session that never chose', async () => {
		await open(session());
		expect(screen.getByRole('button', { name: /Specialists: 1/ })).toBeTruthy();
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

	it("can't turn on a writing specialist in a read-only session", async () => {
		await open(session({ readOnly: true }));
		expect(box('Builder').disabled).toBe(true);
		expect(box('SQL').disabled).toBe(false);
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
