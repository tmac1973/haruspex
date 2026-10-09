import { describe, it, expect, vi } from 'vitest';
import { EditorWorkspace } from './workspace.svelte.ts';
import type { EditorIO } from './document.svelte.ts';

function setup() {
	const disk: Record<string, string> = { 'a.ts': 'A', 'b.ts': 'B', 'c.ts': 'C' };
	const io: EditorIO = {
		read: vi.fn(async (_w, rel) => ({ path: `/p/${rel}`, content: disk[rel], hash: disk[rel] })),
		write: vi.fn(async (_w, rel, content) => {
			disk[rel] = content;
			return { status: 'saved' as const, hash: content };
		}),
		release: vi.fn()
	};
	const closeWindow = vi.fn();
	const ws = new EditorWorkspace('/p', io, { closeWindow });
	return { ws, io, disk, closeWindow };
}

describe('EditorWorkspace', () => {
	it('adds a tab per new file and focuses one that is already open', async () => {
		const { ws, io } = setup();
		await ws.open(['a.ts', 'b.ts']);
		expect(ws.tabs.map((t) => t.relPath)).toEqual(['a.ts', 'b.ts']);
		expect(ws.activePath).toBe('a.ts');

		await ws.open(['b.ts']);
		expect(ws.tabs).toHaveLength(2);
		expect(ws.activePath).toBe('b.ts');
		expect(io.read).toHaveBeenCalledTimes(2);
	});

	it('routes a change on disk to the tab showing that file', async () => {
		const { ws, disk } = setup();
		await ws.open(['a.ts', 'b.ts']);
		disk['b.ts'] = 'B2';
		ws.diskChanged('/p/b.ts', 'B2');
		await vi.waitFor(() => expect(ws.tab('b.ts')?.draft).toBe('B2'));
		expect(ws.tab('a.ts')?.draft).toBe('A');
	});

	it('closes a clean tab at once, and asks about a dirty one', async () => {
		const { ws, io, disk } = setup();
		await ws.open(['a.ts', 'b.ts']);
		ws.requestCloseTab('a.ts');
		expect(ws.tabs.map((t) => t.relPath)).toEqual(['b.ts']);
		expect(io.release).toHaveBeenCalledWith('/p/a.ts');

		ws.tab('b.ts')!.edit('B, edited');
		ws.requestCloseTab();
		expect(ws.question).toEqual({ kind: 'tab', relPath: 'b.ts' });
		expect(ws.tabs).toHaveLength(1);
		await ws.saveAndCloseTab('b.ts');
		expect(disk['b.ts']).toBe('B, edited');
	});

	it('closes the window with its last tab', async () => {
		const { ws, closeWindow } = setup();
		await ws.open(['a.ts']);
		ws.requestCloseTab();
		expect(closeWindow).toHaveBeenCalled();
	});

	it('asks before closing a window with unsaved tabs', async () => {
		const { ws, closeWindow, disk } = setup();
		await ws.open(['a.ts', 'b.ts', 'c.ts']);
		expect(ws.requestCloseWindow()).toBe(true);

		ws.tab('a.ts')!.edit('A2');
		ws.tab('c.ts')!.edit('C2');
		expect(ws.requestCloseWindow()).toBe(false);
		expect(ws.question).toEqual({ kind: 'window' });
		expect(ws.dirtyTabs.map((t) => t.relPath)).toEqual(['a.ts', 'c.ts']);

		await ws.saveAllAndCloseWindow();
		expect([disk['a.ts'], disk['c.ts']]).toEqual(['A2', 'C2']);
		expect(closeWindow).toHaveBeenCalledTimes(1);
	});

	it('stays open when a save in Save all is refused', async () => {
		const { ws, io, closeWindow } = setup();
		await ws.open(['a.ts']);
		ws.tab('a.ts')!.edit('A2');
		vi.mocked(io.write).mockResolvedValueOnce({ status: 'conflict', hash: 'other' });
		await ws.saveAllAndCloseWindow();
		expect(closeWindow).not.toHaveBeenCalled();
		expect(ws.tab('a.ts')!.conflict).toBe(true);
	});
});
