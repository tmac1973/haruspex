import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';

const listing = vi.hoisted(() => ({ files: [] as string[], truncated: false }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => listing) }));

import ViewerList from './ViewerList.svelte';

beforeEach(() => {
	listing.files = [];
});

describe('ViewerList', () => {
	it('lists the files of the showing kind and steps through them with the arrow keys', async () => {
		listing.files = ['a.glb', 'b/attempts/create-01/b.glb', 'b/b.glb', 'b/sheet.png'];
		const onpick = vi.fn();
		render(ViewerList, { workdir: '/proj', relPath: 'b/b.glb', onpick });
		await screen.findByText('b.glb');
		expect(screen.queryByText('sheet.png')).toBeNull();

		await fireEvent.keyDown(window, { key: 'ArrowRight' });
		expect(onpick).toHaveBeenLastCalledWith('a.glb');
		await fireEvent.click(screen.getByText('a.glb'));
		expect(onpick).toHaveBeenLastCalledWith('a.glb');

		await fireEvent.click(screen.getByLabelText('Attempts'));
		await screen.findByText('3D 3');
		await fireEvent.keyDown(window, { key: 'ArrowLeft' });
		expect(onpick).toHaveBeenLastCalledWith('b/attempts/create-01/b.glb');
	});

	it('switches to the first file of another kind', async () => {
		listing.files = ['a.glb', 'p.png', 'q.png'];
		const onpick = vi.fn();
		render(ViewerList, { workdir: '/proj', relPath: 'a.glb', onpick });
		await fireEvent.click(await screen.findByText('Images 2'));
		expect(onpick).toHaveBeenLastCalledWith('p.png');
	});

	it('hides itself when the file is alone in its folder', async () => {
		listing.files = ['crate.glb', 'notes.txt'];
		render(ViewerList, { workdir: '/proj', relPath: 'crate.glb', onpick: vi.fn() });
		await vi.waitFor(() => expect(listing.files).toHaveLength(2));
		expect(screen.queryByLabelText('Files in this folder')).toBeNull();
	});
});
