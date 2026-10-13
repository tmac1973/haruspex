import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import WindowPickerModal from './WindowPickerModal.svelte';
import type { CaptureWindow } from '#lib/ipc/gen/CaptureWindow.ts';

const WINDOWS: CaptureWindow[] = [
	{ id: 1, title: 'My Game (DEBUG)', app: 'Godot' },
	{ id: 2, title: 'GitHub', app: 'Safari' },
	{ id: 3, title: '', app: 'Terminal' }
];

function open(windows: CaptureWindow[] | null = WINDOWS) {
	const onPick = vi.fn();
	const onCancel = vi.fn();
	const view = render(WindowPickerModal, { windows, onPick, onCancel });
	return { onPick, onCancel, view, filter: () => screen.getByRole('combobox') };
}

const highlighted = () =>
	screen
		.getAllByRole('option')
		.filter((o) => o.getAttribute('aria-selected') === 'true')
		.map((o) => o.getAttribute('aria-label'));

// jsdom does no layout, so it has no scrollIntoView.
const scrollIntoView = vi.fn();
beforeEach(() => {
	scrollIntoView.mockClear();
	Element.prototype.scrollIntoView = scrollIntoView;
});

describe('WindowPickerModal', () => {
	it('renders nothing while closed', () => {
		open(null);
		expect(screen.queryByRole('dialog')).toBeNull();
	});

	it('lists every window, named the way the list always has, with the full name as a tooltip', () => {
		open();
		const options = screen.getAllByRole('option');
		expect(options.map((o) => o.getAttribute('aria-label'))).toEqual([
			'My Game (DEBUG) — Godot',
			'GitHub — Safari',
			'Terminal'
		]);
		expect(options[0].getAttribute('title')).toBe('My Game (DEBUG) — Godot');
	});

	it('starts with focus in the filter box', async () => {
		const { filter } = open();
		await vi.waitFor(() => expect(document.activeElement).toBe(filter()));
	});

	it('picks a window on click', async () => {
		const { onPick } = open();
		await fireEvent.click(screen.getByRole('option', { name: 'GitHub — Safari' }));
		expect(onPick).toHaveBeenCalledWith(2);
	});

	it('filters by title or app as you type', async () => {
		const { filter } = open();
		await fireEvent.input(filter(), { target: { value: 'safari' } });
		expect(screen.getAllByRole('option').map((o) => o.getAttribute('aria-label'))).toEqual([
			'GitHub — Safari'
		]);
		await fireEvent.input(filter(), { target: { value: 'debug' } });
		expect(screen.getAllByRole('option')).toHaveLength(1);
	});

	it('says so when nothing matches', async () => {
		const { filter } = open();
		await fireEvent.input(filter(), { target: { value: 'nope' } });
		expect(screen.queryAllByRole('option')).toHaveLength(0);
		expect(screen.getByText('No window matches.')).toBeTruthy();
	});

	it('moves the highlight with the arrows, Home and End, and picks it with Enter', async () => {
		const { onPick, filter } = open();
		expect(highlighted()).toEqual(['My Game (DEBUG) — Godot']);
		await fireEvent.keyDown(filter(), { key: 'ArrowDown' });
		expect(highlighted()).toEqual(['GitHub — Safari']);
		await vi.waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' }));
		await fireEvent.keyDown(filter(), { key: 'End' });
		await fireEvent.keyDown(filter(), { key: 'ArrowDown' });
		expect(highlighted()).toEqual(['Terminal']);
		await fireEvent.keyDown(filter(), { key: 'Home' });
		await fireEvent.keyDown(filter(), { key: 'ArrowUp' });
		expect(highlighted()).toEqual(['My Game (DEBUG) — Godot']);
		await fireEvent.keyDown(filter(), { key: 'Enter' });
		expect(onPick).toHaveBeenCalledWith(1);
	});

	it('goes back to the first match when the filter changes', async () => {
		const { onPick, filter } = open();
		await fireEvent.keyDown(filter(), { key: 'End' });
		await fireEvent.input(filter(), { target: { value: 'g' } });
		await fireEvent.keyDown(filter(), { key: 'Enter' });
		expect(onPick).toHaveBeenCalledWith(1);
	});

	it('points the filter box at the highlighted row', async () => {
		const { filter } = open();
		await fireEvent.keyDown(filter(), { key: 'ArrowDown' });
		const active = filter().getAttribute('aria-activedescendant');
		expect(document.getElementById(active!)?.getAttribute('aria-label')).toBe('GitHub — Safari');
	});

	it('cancels on Escape and on the close button', async () => {
		const { onCancel } = open();
		await fireEvent.keyDown(window, { key: 'Escape' });
		await fireEvent.click(screen.getByLabelText('Close'));
		expect(onCancel).toHaveBeenCalledTimes(2);
	});
});
