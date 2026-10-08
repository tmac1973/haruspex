import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	isAutoApproveActive: vi.fn(() => true),
	askFileConflict: vi.fn()
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('#lib/stores/approvalOverride.ts', () => ({
	isAutoApproveActive: mocks.isAutoApproveActive
}));

vi.mock('#lib/stores/fileConflict.svelte.ts', () => ({
	askFileConflict: mocks.askFileConflict
}));

import { resolveWritePathInteractive } from './fs-write';

beforeEach(() => {
	mocks.invoke.mockReset();
	mocks.isAutoApproveActive.mockReturnValue(true);
});

/** Pretend every path already exists on disk unless told otherwise. */
function existsReturns(exists: boolean) {
	mocks.invoke.mockImplementation(async (cmd: string) => {
		if (cmd === 'fs_path_exists') return exists;
		throw new Error(`unexpected invoke: ${cmd}`);
	});
}

describe('repeat-write guard', () => {
	it('allows the first write to a path', async () => {
		existsReturns(false);
		const written = new Set<string>();
		const r = await resolveWritePathInteractive('/w', 'plan/phase-02.md', written);
		expect(r.kind).toBe('ok');
	});

	it('refuses a second write to the same path in one turn', async () => {
		// The prefix-loss route: chunked writes used to short-circuit to
		// overwrite:true and each report "Wrote:", leaving only the last chunk.
		existsReturns(false);
		const written = new Set<string>(['plan/phase-02.md']);
		const r = await resolveWritePathInteractive('/w', 'plan/phase-02.md', written);
		expect(r.kind).toBe('rejected');
		if (r.kind === 'rejected') {
			// The model has to be told what to do instead, or it just retries.
			expect(r.message).toContain('fs_edit_text');
			expect(r.message).toContain('complete content');
			expect(r.message).toContain('plan/phase-02.md');
		}
	});

	it('refuses without consulting the filesystem', async () => {
		// The guard must not depend on disk state — the point is that the file
		// DOES exist, because we just wrote it.
		existsReturns(true);
		const written = new Set<string>(['a.md']);
		await resolveWritePathInteractive('/w', 'a.md', written);
		expect(mocks.invoke).not.toHaveBeenCalled();
	});

	it('allows writes to two different paths in the same turn', async () => {
		existsReturns(false);
		const written = new Set<string>(['plan/phase-01.md']);
		const r = await resolveWritePathInteractive('/w', 'plan/phase-02.md', written);
		expect(r.kind).toBe('ok');
	});

	it('allows a repeat write in a later turn', async () => {
		// filesWrittenThisTurn is per-turn state; a fresh set is a fresh turn.
		existsReturns(true);
		const r = await resolveWritePathInteractive('/w', 'plan/phase-02.md', new Set<string>());
		expect(r.kind).toBe('ok');
		if (r.kind === 'ok') expect(r.overwrite).toBe(true);
	});

	it('still overwrites a pre-existing file not written this turn', async () => {
		// Auto-approve behaviour for ordinary job writes must be unchanged: the
		// defect was the silent REPEAT, not overwriting as such.
		existsReturns(true);
		const r = await resolveWritePathInteractive('/w', 'existing.md', new Set<string>());
		expect(r.kind).toBe('ok');
		if (r.kind === 'ok') {
			expect(r.overwrite).toBe(true);
			expect(r.finalPath).toBe('existing.md');
		}
	});
});

describe('an existing file, with someone at the keyboard', () => {
	beforeEach(() => {
		mocks.isAutoApproveActive.mockReturnValue(false);
		mocks.askFileConflict.mockReset();
	});

	function disk(opts: { available?: string | Error }) {
		mocks.invoke.mockImplementation(async (cmd: string) => {
			if (cmd === 'fs_path_exists') return true;
			if (cmd === 'fs_find_available_path') {
				if (opts.available instanceof Error) throw opts.available;
				return opts.available;
			}
			throw new Error(`unexpected invoke: ${cmd}`);
		});
	}

	it('overwrites only when the user says so', async () => {
		disk({});
		mocks.askFileConflict.mockResolvedValue('overwrite');
		const r = await resolveWritePathInteractive('/w', 'a.md', new Set());
		expect(r).toEqual({ kind: 'ok', finalPath: 'a.md', overwrite: true });
	});

	it('stops when the user cancels', async () => {
		disk({});
		mocks.askFileConflict.mockResolvedValue('cancel');
		const r = await resolveWritePathInteractive('/w', 'a.md', new Set());
		expect(r.kind).toBe('canceled');
	});

	it('writes beside the existing file when the user keeps both', async () => {
		disk({ available: 'a (1).md' });
		mocks.askFileConflict.mockResolvedValue('counter');
		const r = await resolveWritePathInteractive('/w', 'a.md', new Set());
		expect(r).toEqual({ kind: 'ok', finalPath: 'a (1).md', overwrite: false });
	});

	it('never overwrites a file the user chose to keep, even when no free name is found', async () => {
		disk({ available: new Error('directory is read-only') });
		mocks.askFileConflict.mockResolvedValue('counter');
		const r = await resolveWritePathInteractive('/w', 'a.md', new Set());
		expect(r.kind).toBe('rejected');
		if (r.kind === 'rejected') expect(r.message).toContain('left alone');
	});

	it('does not ask when the file does not exist', async () => {
		mocks.invoke.mockResolvedValue(false);
		const r = await resolveWritePathInteractive('/w', 'new.md', new Set());
		expect(r).toEqual({ kind: 'ok', finalPath: 'new.md', overwrite: false });
		expect(mocks.askFileConflict).not.toHaveBeenCalled();
	});
});

describe('a Code session overwriting a file', () => {
	it('overwrites without asking, even with someone at the keyboard', async () => {
		mocks.isAutoApproveActive.mockReturnValue(false);
		mocks.askFileConflict.mockReset();
		existsReturns(true);
		const r = await resolveWritePathInteractive('/w', 'src/game.js', new Set<string>(), {
			askBeforeOverwrite: false
		});
		expect(r).toEqual({ kind: 'ok', finalPath: 'src/game.js', overwrite: true });
		expect(mocks.askFileConflict).not.toHaveBeenCalled();
	});

	it('still refuses a second write to the same file in one turn', async () => {
		mocks.isAutoApproveActive.mockReturnValue(false);
		existsReturns(true);
		const r = await resolveWritePathInteractive('/w', 'src/game.js', new Set(['src/game.js']), {
			askBeforeOverwrite: false
		});
		expect(r.kind).toBe('rejected');
	});
});
