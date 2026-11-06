import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';

const listing = vi.hoisted(() => ({ files: [] as string[], truncated: false }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => listing) }));

import FileTree from './FileTree.svelte';

beforeEach(() => {
	listing.files = [];
});

describe('FileTree', () => {
	it('lists the files of the showing kind and steps through them with the arrow keys', async () => {
		listing.files = ['a.glb', 'b/attempts/create-01/b.glb', 'b/b.glb', 'b/sheet.png'];
		const onpick = vi.fn();
		render(FileTree, { workdir: '/proj', relPath: 'b/b.glb', onpick });
		await screen.findByText('b.glb');
		expect(screen.queryByText('sheet.png')).toBeNull();

		await fireEvent.keyDown(window, { key: 'ArrowRight' });
		expect(onpick).toHaveBeenLastCalledWith('a.glb');
		await fireEvent.keyDown(window, { key: 'ArrowUp' });
		expect(onpick).toHaveBeenLastCalledWith('a.glb');
		await fireEvent.click(screen.getByText('a.glb'));
		expect(onpick).toHaveBeenLastCalledWith('a.glb');

		await fireEvent.click(screen.getByLabelText('Attempts'));
		await screen.findByText('3D 3');
		await fireEvent.keyDown(window, { key: 'ArrowDown' });
		expect(onpick).toHaveBeenLastCalledWith('a.glb');
		await fireEvent.keyDown(window, { key: 'ArrowLeft' });
		expect(onpick).toHaveBeenLastCalledWith('b/attempts/create-01/b.glb');
	});

	it('lists text files in a tree, and folds a folder away', async () => {
		listing.files = ['README.md', 'src/main.ts', 'src/util/a.ts', 'logo.png'];
		const onpick = vi.fn();
		render(FileTree, { workdir: '/proj', relPath: 'src/main.ts', onpick });
		await screen.findByText('Text 3');
		expect(screen.getByText('a.ts')).toBeTruthy();
		expect(screen.queryByText('logo.png')).toBeNull();

		await fireEvent.click(screen.getByText('util'));
		expect(screen.queryByText('a.ts')).toBeNull();
		await fireEvent.keyDown(window, { key: 'ArrowUp' });
		expect(onpick).toHaveBeenLastCalledWith('src/util/a.ts');
	});

	it('leaves the arrow keys to the text while typing', async () => {
		listing.files = ['a.md', 'b.md'];
		const onpick = vi.fn();
		render(FileTree, { workdir: '/proj', relPath: 'a.md', onpick });
		await screen.findByText('b.md');
		const typing = document.createElement('div');
		typing.setAttribute('contenteditable', 'true');
		document.body.append(typing);
		await fireEvent.keyDown(typing, { key: 'ArrowDown' });
		expect(onpick).not.toHaveBeenCalled();
		typing.remove();
	});

	it('switches to the first file of another kind', async () => {
		listing.files = ['a.glb', 'hit.wav', 'p.png', 'q.png'];
		const onpick = vi.fn();
		render(FileTree, { workdir: '/proj', relPath: 'a.glb', onpick });
		await fireEvent.click(await screen.findByText('Images 2'));
		expect(onpick).toHaveBeenLastCalledWith('p.png');
		await fireEvent.click(screen.getByText('Audio 1'));
		expect(onpick).toHaveBeenLastCalledWith('hit.wav');
	});

	it('hides itself when the file is alone in its folder', async () => {
		listing.files = ['crate.glb'];
		render(FileTree, { workdir: '/proj', relPath: 'crate.glb', onpick: vi.fn() });
		await vi.waitFor(() => expect(listing.files).toHaveLength(1));
		expect(screen.queryByLabelText('Files in this folder')).toBeNull();
	});
});
