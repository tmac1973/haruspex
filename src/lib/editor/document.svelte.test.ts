import { describe, it, expect, vi } from 'vitest';
import { EditorDocument, type EditorIO } from './document.svelte.ts';

/** A disk of one file, hashed by its content. */
function fakeDisk(initial: string | null) {
	const disk = { content: initial };
	const hash = (c: string | null) => (c === null ? null : `h:${c}`);
	const io: EditorIO = {
		read: vi.fn(async () => ({
			path: '/proj/a.ts',
			content: disk.content,
			hash: hash(disk.content)
		})),
		write: vi.fn(async (_w, _r, content, expected, force) => {
			if (!force && hash(disk.content) !== expected) {
				return { status: 'conflict' as const, hash: hash(disk.content) };
			}
			disk.content = content;
			return { status: 'saved' as const, hash: hash(content)! };
		}),
		release: vi.fn()
	};
	return { disk, hash, io };
}

async function open(initial: string | null) {
	const f = fakeDisk(initial);
	const doc = new EditorDocument('/proj', 'a.ts', f.io);
	await doc.load();
	return { ...f, doc };
}

describe('EditorDocument', () => {
	it('loads, tracks edits and saves', async () => {
		const { doc, disk } = await open('one');
		expect(doc.draft).toBe('one');
		expect(doc.dirty).toBe(false);
		doc.edit('two');
		expect(doc.dirty).toBe(true);
		expect(await doc.save()).toBe(true);
		expect(disk.content).toBe('two');
		expect(doc.dirty).toBe(false);
	});

	it('reloads a clean file silently when it changes on disk', async () => {
		const { doc, disk, hash } = await open('one');
		disk.content = 'one, changed elsewhere';
		await doc.diskChanged(hash(disk.content));
		// The editor gets the new text through `draft`; CodeEditor applies it
		// as a minimal change, so the cursor stays (codemirror.test.ts).
		expect(doc.draft).toBe('one, changed elsewhere');
		expect(doc.dirty).toBe(false);
		expect(doc.disk).toBe('same');
	});

	it('ignores its own save coming back from the watcher', async () => {
		const { doc, io, hash } = await open('one');
		doc.edit('two');
		await doc.save();
		vi.mocked(io.read).mockClear();
		await doc.diskChanged(hash('two'));
		expect(io.read).not.toHaveBeenCalled();
		expect(doc.disk).toBe('same');
	});

	it('keeps unsaved edits and shows the bar when the file changes on disk', async () => {
		const { doc, disk, hash } = await open('one');
		doc.edit('mine');
		disk.content = 'theirs';
		await doc.diskChanged(hash('theirs'));
		expect(doc.draft).toBe('mine');
		expect(doc.disk).toBe('changed');

		await doc.reload();
		expect(doc.draft).toBe('theirs');
		expect(doc.disk).toBe('same');
	});

	it('Keep mine saves over the change without asking', async () => {
		const { doc, disk, hash } = await open('one');
		doc.edit('mine');
		disk.content = 'theirs';
		await doc.diskChanged(hash('theirs'));
		doc.keepMine();
		expect(doc.disk).toBe('same');
		expect(await doc.save()).toBe(true);
		expect(disk.content).toBe('mine');
	});

	it('asks before saving over a change it has not seen', async () => {
		const { doc, disk } = await open('one');
		doc.edit('mine');
		disk.content = 'theirs'; // no watcher event yet
		expect(await doc.save()).toBe(false);
		expect(doc.conflict).toBe(true);
		expect(disk.content).toBe('theirs');

		expect(await doc.overwrite()).toBe(true);
		expect(disk.content).toBe('mine');
		expect(doc.conflict).toBe(false);
	});

	it('Reload first drops the edits for what is on disk', async () => {
		const { doc, disk } = await open('one');
		doc.edit('mine');
		disk.content = 'theirs';
		await doc.save();
		await doc.reload();
		expect(doc.conflict).toBe(false);
		expect(doc.draft).toBe('theirs');
	});

	it('shows a deleted file and recreates it on save', async () => {
		const { doc, disk } = await open('keep me');
		disk.content = null;
		await doc.diskChanged(null);
		expect(doc.disk).toBe('deleted');
		expect(doc.draft).toBe('keep me');
		expect(doc.canSave).toBe(true);
		expect(await doc.save()).toBe(true);
		expect(disk.content).toBe('keep me');
		expect(doc.disk).toBe('same');
	});

	it('opens a file that does not exist yet, and saving creates it', async () => {
		const { doc, disk } = await open(null);
		expect(doc.disk).toBe('new');
		doc.edit('hello');
		expect(await doc.save()).toBe(true);
		expect(disk.content).toBe('hello');
	});

	it('reports a failed read and does not offer to save', async () => {
		const io: EditorIO = {
			read: () => Promise.reject('Not a text file.'),
			write: vi.fn()
		};
		const doc = new EditorDocument('/proj', 'x.bin', io);
		await doc.load();
		expect(doc.failed).toBe(true);
		expect(doc.error).toContain('Not a text file.');
		expect(doc.canSave).toBe(false);
	});

	it('stops watching when closed', async () => {
		const { doc, io } = await open('one');
		doc.close();
		expect(io.release).toHaveBeenCalledWith('/proj/a.ts');
	});
});
