import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';

const settings = vi.hoisted(() => ({
	codeHelpers: {} as Record<string, boolean>,
	codeHelperConfig: {} as Record<string, unknown>
}));
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		overDefaults: true,
		settings: () => settings,
		getLiveSettings: () => settings
	})
);
const toasts = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock('#lib/stores/toasts.svelte.ts', () => toasts);

import { helpers } from '#lib/helpers/registry.ts';
import ExtrasMenu from './ExtrasMenu.svelte';

function session<T extends Record<string, unknown>>(over: T = {} as T) {
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
	settings.codeHelperConfig = {};
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

describe('the Extras menu’s 3D delegate', () => {
	const settingsModel = { baseUrl: 'https://openrouter.ai/api', modelId: 'vendor/big' };
	const own = { baseUrl: 'http://gpu-box:8080', modelId: 'qwen-big' };

	function delegateSession(over: Record<string, unknown> = {}) {
		return session({
			helpers: ['3d'],
			helperConfig: null,
			setSessionHelperConfig: vi.fn<(config: unknown) => Promise<void>>(async () => {}),
			...over
		});
	}

	it('is shown only while the session has the 3D helper on', async () => {
		await open(delegateSession({ helpers: ['preview'] }));
		expect(screen.queryByText('3D delegate')).toBeNull();
	});

	it('shows the Settings model, then the session’s own', async () => {
		settings.codeHelperConfig = { '3d': { backend: settingsModel } };
		await open(delegateSession());
		screen.getByText('3D delegate');
		screen.getByText('vendor/big · OpenRouter');
	});

	it('marks a model set for this session only', async () => {
		settings.codeHelperConfig = { '3d': { backend: settingsModel } };
		await open(delegateSession({ helperConfig: { '3d': { backend: own } } }));
		screen.getByText('qwen-big · gpu-box:8080 · this session');
	});

	it('sets none for this session, keeping the other helpers’ settings', async () => {
		settings.codeHelperConfig = { '3d': { backend: settingsModel } };
		const s = delegateSession({ helperConfig: { search: { a: 1 } } });
		await open(s);
		await fireEvent.click(screen.getByRole('button', { name: 'Change…' }));
		// It follows Settings, so the picker opens there.
		expect((screen.getByRole('radio', { name: 'Settings' }) as HTMLInputElement).checked).toBe(
			true
		);
		await fireEvent.click(screen.getByRole('radio', { name: 'None' }));
		expect(screen.queryByRole('button', { name: 'None' })).toBeNull();
		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await vi.waitFor(() =>
			expect(s.setSessionHelperConfig).toHaveBeenCalledWith({
				search: { a: 1 },
				'3d': { backend: null }
			})
		);
	});

	it('goes back to the Settings model', async () => {
		const s = delegateSession({ helperConfig: { '3d': { backend: own } } });
		await open(s);
		await fireEvent.click(screen.getByRole('button', { name: 'Change…' }));
		await fireEvent.click(screen.getByRole('radio', { name: 'Settings' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await vi.waitFor(() => expect(s.setSessionHelperConfig).toHaveBeenCalledWith(null));
	});

	it('opens on None when the session has none', async () => {
		const s = delegateSession({ helperConfig: { '3d': { backend: null } } });
		await open(s);
		await fireEvent.click(screen.getByRole('button', { name: 'Change…' }));
		expect((screen.getByRole('radio', { name: 'None' }) as HTMLInputElement).checked).toBe(true);
		await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(s.setSessionHelperConfig).not.toHaveBeenCalled();
	});

	it('saves the picked model for this session', async () => {
		const s = delegateSession({ helperConfig: { '3d': { backend: own } } });
		await open(s);
		await fireEvent.click(screen.getByRole('button', { name: 'Change…' }));
		// The picker opens on the session's own model.
		await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		await vi.waitFor(() =>
			expect(s.setSessionHelperConfig).toHaveBeenCalledWith({
				'3d': { backend: expect.objectContaining(own) }
			})
		);
		const saved = s.setSessionHelperConfig.mock.calls[0][0];
		expect(() => structuredClone(saved)).not.toThrow();
	});
});
