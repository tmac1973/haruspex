import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import type { SpecialistEntry } from '#lib/specialists/types.ts';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);

const settings = vi.hoisted(() => ({
	specialists: [] as SpecialistEntry[],
	apiKeys: [] as unknown[]
}));
const saved = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings: () => settings,
		getApiKeys: () => [],
		setSpecialistEntries: vi.fn((list: SpecialistEntry[]) => {
			saved.calls.push(list);
			// What commit() does: keep a plain copy.
			settings.specialists = structuredClone(list);
		})
	})
);
const call = vi.hoisted(() => ({
	callSpecialist: vi.fn(),
	listSpecialistModels: vi.fn()
}));
vi.mock('#lib/specialists/call.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/specialists/call.ts')>()),
	...call
}));

import SpecialistsSection from './SpecialistsSection.svelte';

function entry(over: Partial<SpecialistEntry> = {}): SpecialistEntry {
	return {
		id: 'e1',
		name: 'Regex',
		kind: 'text',
		url: 'http://compute:3000',
		keyId: null,
		model: 'small',
		description: null,
		systemPrompt: null,
		sampling: null,
		onByDefault: false,
		acceptsImages: false,
		...over
	};
}

function addKind(kind = 'text') {
	const select = screen.getByLabelText('Add a specialist') as HTMLSelectElement;
	return fireEvent.change(select, { target: { value: kind } });
}

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const last = () => saved.calls.at(-1) as SpecialistEntry[];

beforeEach(() => {
	settings.specialists = [];
	saved.calls = [];
	call.callSpecialist.mockReset();
	call.listSpecialistModels.mockReset();
});

describe('Settings → Code → Specialists', () => {
	it('offers every registered kind under Add', () => {
		render(SpecialistsSection);
		const select = screen.getByLabelText('Add a specialist');
		const kinds = within(select)
			.getAllByRole('option')
			.map((o) => o.textContent);
		expect(kinds).toEqual(['Add specialist…', 'Text', '3D asset (GLB)', 'Three.js scene']);
		screen.getByText('None yet.');
	});

	it('adds an entry only when its editor is saved', async () => {
		render(SpecialistsSection);
		await addKind();
		expect(saved.calls).toHaveLength(0);
		await fireEvent.input(field('Server'), { target: { value: 'http://box:8080/v1' } });
		await fireEvent.input(field('Model'), { target: { value: 'qwen' } });
		await fireEvent.click(screen.getByText('Save'));
		expect(last()).toHaveLength(1);
		expect(last()[0]).toMatchObject({
			name: 'Text',
			kind: 'text',
			url: 'http://box:8080/v1',
			model: 'qwen',
			systemPrompt: null,
			sampling: null,
			description: null,
			acceptsImages: false
		});
		// The saved list is plain JSON.
		expect(() => structuredClone(settings)).not.toThrow();
	});

	it('drops a new entry whose editor is cancelled', async () => {
		render(SpecialistsSection);
		await addKind();
		await fireEvent.click(screen.getByText('Cancel'));
		expect(saved.calls).toHaveLength(0);
		expect(screen.queryAllByRole('listitem')).toHaveLength(0);
	});

	it('refuses an empty or taken name', async () => {
		settings.specialists = [entry()];
		render(SpecialistsSection);
		await addKind();
		const name = field('Name');
		await fireEvent.input(name, { target: { value: 'regex' } });
		screen.getByText('Another specialist has this name.');
		expect((screen.getByText('Save') as HTMLButtonElement).disabled).toBe(true);
		await fireEvent.input(name, { target: { value: '  ' } });
		screen.getByText('Give it a name.');
	});

	it('saves overrides, and null where a field is left to the kind', async () => {
		settings.specialists = [entry()];
		render(SpecialistsSection);
		await fireEvent.click(screen.getByText('Regex'));
		await fireEvent.input(field('Temperature'), { target: { value: '0.2' } });
		await fireEvent.change(field('Thinking'), { target: { value: 'off' } });
		await fireEvent.input(field('Description'), { target: { value: 'Writes regexes.' } });
		await fireEvent.click(field('Accepts images'));
		await fireEvent.click(screen.getByText('Save'));
		expect(last()[0]).toMatchObject({
			sampling: { temperature: 0.2, thinking: false },
			description: 'Writes regexes.',
			acceptsImages: true,
			systemPrompt: null
		});
	});

	it("stores the system prompt only when it differs from the kind's", async () => {
		settings.specialists = [entry()];
		render(SpecialistsSection);
		await fireEvent.click(screen.getByText('Regex'));
		await fireEvent.input(field('System prompt'), {
			target: { value: 'Answer with a regex only.' }
		});
		await fireEvent.click(screen.getByText('Save'));
		expect(last()[0].systemPrompt).toBe('Answer with a regex only.');

		await fireEvent.click(screen.getByText('Regex'));
		await fireEvent.input(field('System prompt'), { target: { value: '' } });
		await fireEvent.click(screen.getByText('Save'));
		expect(last()[0].systemPrompt).toBeNull();

		await fireEvent.click(screen.getByText('Regex'));
		await fireEvent.click(field('Send no system prompt'));
		await fireEvent.click(screen.getByText('Save'));
		expect(last()[0].systemPrompt).toBe('');
	});

	it('sets On by default and removes from the row', async () => {
		settings.specialists = [entry(), entry({ id: 'e2', name: 'SQL' })];
		render(SpecialistsSection);
		await fireEvent.click(screen.getAllByLabelText('On by default')[1]);
		expect(last().map((e) => e.onByDefault)).toEqual([false, true]);
		await fireEvent.click(screen.getByLabelText('Remove Regex'));
		expect(last().map((e) => e.name)).toEqual(['SQL']);
	});

	it('tests the draft and shows the answer or the error', async () => {
		settings.specialists = [entry()];
		render(SpecialistsSection);
		await fireEvent.click(screen.getByText('Regex'));
		call.callSpecialist.mockResolvedValueOnce({ content: 'OK\nmore' });
		await fireEvent.click(screen.getByText('Test'));
		await screen.findByText('Answered: OK');
		expect(call.callSpecialist.mock.calls[0][2]).toEqual({ maxTokens: 64 });

		call.callSpecialist.mockResolvedValueOnce({ content: '' });
		await fireEvent.click(screen.getByText('Test'));
		await screen.findByText(/set Thinking to Off/);

		call.callSpecialist.mockRejectedValueOnce(new Error('refused'));
		await fireEvent.click(screen.getByText('Test'));
		await screen.findByText('Failed: refused');
		expect(saved.calls).toHaveLength(0);
	});

	it("fills the model list from the server's", async () => {
		settings.specialists = [entry()];
		render(SpecialistsSection);
		await fireEvent.click(screen.getByText('Regex'));
		call.listSpecialistModels.mockResolvedValueOnce(['a', 'b']);
		await fireEvent.click(screen.getByText('Fetch'));
		await screen.findByText('2 models');
		call.listSpecialistModels.mockRejectedValueOnce(new Error('The server answered 401.'));
		await fireEvent.click(screen.getByText('Fetch'));
		await screen.findByText(/Couldn't list models: The server answered 401/);
	});
});
