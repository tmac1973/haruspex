import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';

vi.mock('#lib/slash/slash.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/slash/slash.ts')>()),
	slashItems: vi.fn(async () => [
		{ name: 'new', description: 'Start over', builtin: true },
		{ name: 'skills', description: 'List skills', builtin: true },
		{ name: 'deploy', description: 'Ship it', builtin: false }
	])
}));

import SlashMenu from './SlashMenu.svelte';

function key(k: string, extra: KeyboardEventInit = {}) {
	return new KeyboardEvent('keydown', { key: k, cancelable: true, ...extra });
}

async function open(text: string) {
	const onPick = vi.fn();
	const { component, rerender } = render(SlashMenu, { text, onPick });
	await waitFor(() => screen.getByRole('listbox'));
	return {
		menu: component as unknown as { handleKey(e: KeyboardEvent): boolean },
		onPick,
		rerender
	};
}

describe('SlashMenu', () => {
	it('lists what matches the name being typed', async () => {
		await open('/');
		expect(screen.getAllByRole('option')).toHaveLength(3);
	});

	it('moves with the arrows and picks with Enter or Tab', async () => {
		const { menu, onPick } = await open('/');
		expect(menu.handleKey(key('ArrowDown'))).toBe(true);
		expect(menu.handleKey(key('ArrowDown'))).toBe(true);
		const enter = key('Enter');
		expect(menu.handleKey(enter)).toBe(true);
		expect(enter.defaultPrevented).toBe(true);
		expect(onPick).toHaveBeenLastCalledWith('/deploy ');

		// Up from the top wraps to the bottom.
		menu.handleKey(key('ArrowUp'));
		menu.handleKey(key('Tab'));
		expect(onPick).toHaveBeenLastCalledWith('/skills ');
	});

	it('closes on Escape and leaves other keys to the input', async () => {
		const { menu } = await open('/de');
		expect(menu.handleKey(key('a'))).toBe(false);
		expect(menu.handleKey(key('Enter', { shiftKey: true }))).toBe(false);
		expect(menu.handleKey(key('Escape'))).toBe(true);
		await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
		expect(menu.handleKey(key('Enter'))).toBe(false);
	});

	it('stays shut once the name is followed by a space, or nothing matches', async () => {
		const { rerender } = await open('/');
		await rerender({ text: '/deploy ', onPick: vi.fn() });
		expect(screen.queryByRole('listbox')).toBeNull();
		await rerender({ text: '/zzz', onPick: vi.fn() });
		expect(screen.queryByRole('listbox')).toBeNull();
	});

	it('picks on click', async () => {
		const { onPick } = await open('/');
		await fireEvent.click(screen.getByText('/new'));
		expect(onPick).toHaveBeenCalledWith('/new ');
	});
});
