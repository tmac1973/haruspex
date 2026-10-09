import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ emitTo: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({ WebviewWindow: class {} }));

import {
	EditorRouter,
	describeOpens,
	editorTitle,
	folderLabel,
	loadGeometry,
	saveGeometry,
	type WindowApi
} from './windows.ts';

/** Windows in memory: which exist, which files each has open. */
function fakeWindows() {
	const open = new Map<string, Set<string>>();
	let ready: (label: string) => void = () => {};
	const api = {
		findOpen: vi.fn(async (_root: string, files: string[]) =>
			files.map((f) => [...open].find(([, fs]) => fs.has(f))?.[0] ?? null)
		),
		exists: vi.fn(async (label: string) => open.has(label)),
		create: vi.fn(async (label: string) => {
			open.set(label, new Set());
		}),
		send: vi.fn(async (label: string, _root: string, files: string[]) => {
			for (const f of files) open.get(label)?.add(f);
		}),
		raise: vi.fn(async () => {}),
		onReady: vi.fn((cb: (label: string) => void) => (ready = cb))
	} satisfies WindowApi;
	return { api, open, ready: (label: string) => ready(label) };
}

const ROOT = '/home/me/app';
const HOME = folderLabel(ROOT);

describe('EditorRouter', () => {
	let w: ReturnType<typeof fakeWindows>;
	let router: EditorRouter;
	beforeEach(() => {
		w = fakeWindows();
		router = new EditorRouter(w.api);
	});

	it("opens the folder's window, then hands it the files once it is ready", async () => {
		const res = await router.open(ROOT, ['a.ts', 'b.ts']);
		expect(res).toEqual([{ label: HOME, created: true, focused: [], added: ['a.ts', 'b.ts'] }]);
		expect(w.api.create).toHaveBeenCalledWith(HOME, ROOT);
		// Not yet: the window can't hear events until it has loaded.
		expect(w.api.send).not.toHaveBeenCalled();

		// More files while it loads join the queue rather than opening another.
		await router.open(ROOT, ['c.ts']);
		expect(w.api.create).toHaveBeenCalledTimes(1);

		w.ready(HOME);
		await vi.waitFor(() =>
			expect(w.api.send).toHaveBeenCalledWith(HOME, ROOT, ['a.ts', 'b.ts', 'c.ts'])
		);
	});

	it('reuses the window for the folder and raises it', async () => {
		await router.open(ROOT, ['a.ts']);
		w.ready(HOME);
		await vi.waitFor(() => expect(w.open.get(HOME)?.has('a.ts')).toBe(true));

		const res = await router.open(ROOT, ['b.ts']);
		expect(res).toEqual([{ label: HOME, created: false, focused: [], added: ['b.ts'] }]);
		expect(w.api.create).toHaveBeenCalledTimes(1);
		expect(w.api.send).toHaveBeenLastCalledWith(HOME, ROOT, ['b.ts']);
		expect(w.api.raise).toHaveBeenCalledWith(HOME);
	});

	it('focuses the tab of a file that is already open, in whichever window has it', async () => {
		w.open.set(HOME, new Set(['a.ts']));
		w.open.set(`${HOME}-split`, new Set(['b.ts']));
		const res = await router.open(ROOT, ['a.ts', 'b.ts']);
		expect(res).toEqual([
			{ label: HOME, created: false, focused: ['a.ts'], added: [] },
			{ label: `${HOME}-split`, created: false, focused: ['b.ts'], added: [] }
		]);
		expect(w.api.raise).toHaveBeenCalledWith(`${HOME}-split`);
		expect(w.api.create).not.toHaveBeenCalled();
	});

	it('gives another folder a window of its own', async () => {
		w.open.set(HOME, new Set());
		const res = await router.open('/home/me/other', ['x.ts']);
		expect(res[0].label).toBe(folderLabel('/home/me/other'));
		expect(res[0].label).not.toBe(HOME);
		expect(res[0].created).toBe(true);
	});

	it('splits a file into a new window on request', async () => {
		w.open.set(HOME, new Set(['a.ts']));
		const res = await router.open(ROOT, ['a.ts'], true);
		expect(res[0].created).toBe(true);
		expect(res[0].label.startsWith(`${HOME}-`)).toBe(true);
		w.ready(res[0].label);
		await vi.waitFor(() => expect(w.api.send).toHaveBeenCalledWith(res[0].label, ROOT, ['a.ts']));
	});

	it('forgets the queue when the window fails to open', async () => {
		w.api.create.mockRejectedValueOnce(new Error('denied'));
		await expect(router.open(ROOT, ['a.ts'])).rejects.toThrow('denied');
		await router.open(ROOT, ['a.ts']);
		expect(w.api.create).toHaveBeenCalledTimes(2);
	});
});

describe('editor windows', () => {
	it('titles the window by file and folder', () => {
		expect(editorTitle('src/lib/a.ts', '/home/me/app/')).toBe('a.ts — app — Haruspex Editor');
		expect(editorTitle(null, '/home/me/app')).toBe('app — Haruspex Editor');
	});

	it('describes where files went', () => {
		expect(
			describeOpens(ROOT, [{ label: HOME, created: true, focused: [], added: ['a.ts'] }])
		).toBe('Opened a.ts in a new editor window for app.');
	});

	it('remembers a window size per folder', () => {
		expect(loadGeometry(ROOT)).toBeNull();
		saveGeometry(ROOT, { x: 10, y: 20, width: 800, height: 600 });
		expect(loadGeometry(ROOT)).toEqual({ x: 10, y: 20, width: 800, height: 600 });
		expect(loadGeometry('/elsewhere')).toBeNull();
	});
});
