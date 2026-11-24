import { describe, it, expect, vi, beforeEach } from 'vitest';

const dialog = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn() }));
const core = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => dialog);
vi.mock('@tauri-apps/api/core', () => core);

import {
	backUpNotebooks,
	backupFileName,
	describeCounts,
	describeRestore,
	pickBackup
} from './backup';

describe('notebook backup', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('names the file after the day', () => {
		expect(backupFileName(new Date(2026, 0, 5))).toBe('haruspex-notebooks-2026-01-05.zip');
	});

	it('does nothing when the save dialog is cancelled', async () => {
		dialog.save.mockResolvedValue(null);
		expect(await backUpNotebooks()).toBeNull();
		expect(core.invoke).not.toHaveBeenCalled();
	});

	it('writes to the chosen path', async () => {
		dialog.save.mockResolvedValue('/b.zip');
		core.invoke.mockResolvedValue({ notebooks: 1, cards: 2, files: 0 });
		expect(await backUpNotebooks()).toEqual({ notebooks: 1, cards: 2, files: 0 });
		expect(core.invoke).toHaveBeenCalledWith('notebook_backup_create', { path: '/b.zip' });
	});

	it('reads what a picked backup holds', async () => {
		dialog.open.mockResolvedValue('/b.zip');
		const info = { created_at: 1, counts: { notebooks: 1, cards: 1, files: 0 }, already_here: 0 };
		core.invoke.mockResolvedValue(info);
		expect(await pickBackup()).toEqual({ path: '/b.zip', info });
		dialog.open.mockResolvedValue(null);
		expect(await pickBackup()).toBeNull();
	});

	it('words counts and outcomes', () => {
		expect(describeCounts({ notebooks: 1, cards: 3, files: 0 })).toBe('1 notebook, 3 cards');
		expect(describeCounts({ notebooks: 2, cards: 1, files: 1 })).toBe(
			'2 notebooks, 1 card, 1 file'
		);
		expect(
			describeRestore({
				counts: { added: 2, replaced: 1, skipped: 0, trashed: 1 },
				missing_files: 1,
				saved_before: null
			})
		).toBe(
			"Restored: added 2 notebooks, replaced 1, moved 1 not in the backup to Trash. 1 file couldn't be restored."
		);
		expect(
			describeRestore({
				counts: { added: 0, replaced: 0, skipped: 3, trashed: 0 },
				missing_files: 0,
				saved_before: null
			})
		).toBe('Restored: left 3 already here as they were.');
	});
});
