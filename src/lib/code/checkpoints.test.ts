import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import type { RewindFile } from '#lib/ipc/gen/RewindFile.ts';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);
vi.mock('#lib/debugLog.ts', async (importOriginal) =>
	(await import('#lib/testing/debugLog.ts')).mockDebugLog(importOriginal)
);

import {
	changedFiles,
	describeRewindReport,
	readyFiles,
	rewindFiles,
	turnCheckpoints
} from './checkpoints';

beforeEach(() => vi.mocked(invoke).mockReset());

const file = (shown: string, status: string): RewindFile => ({
	path: `/proj/${shown}`,
	shown,
	status,
	reason: null,
	created: false
});

describe('turn checkpoints', () => {
	it('saves before and notes after, under the turn', async () => {
		vi.mocked(invoke).mockResolvedValue(undefined);
		const c = turnCheckpoints('s1', 4, '/proj');
		await c.beforeWrite(['a.ts']);
		await c.afterWrite(['a.ts']);
		expect(invoke).toHaveBeenNthCalledWith(1, 'code_checkpoint_before', {
			sessionId: 's1',
			turnAt: 4,
			workdir: '/proj',
			paths: ['a.ts']
		});
		expect(invoke).toHaveBeenNthCalledWith(2, 'code_checkpoint_after', expect.anything());
	});

	it('never stops a write: a failure is logged, and no paths makes no call', async () => {
		vi.mocked(invoke).mockRejectedValueOnce('db locked');
		const c = turnCheckpoints('s1', 0, '/proj');
		await expect(c.beforeWrite(['a.ts'])).resolves.toBeUndefined();
		vi.mocked(invoke).mockClear();
		await c.afterWrite([]);
		expect(invoke).not.toHaveBeenCalled();
	});
});

describe('rewinding files', () => {
	it('asks Rust to put files back, naming the changed ones to overwrite', async () => {
		vi.mocked(invoke).mockResolvedValue({ restored: [], skipped: [] });
		await rewindFiles('s1', 2, '/proj', true, ['/proj/b.ts']);
		expect(invoke).toHaveBeenCalledWith('code_checkpoint_rewind', {
			sessionId: 's1',
			at: 2,
			workdir: '/proj',
			restore: true,
			overwrite: ['/proj/b.ts']
		});
	});

	it('sorts the plan: ready ones go back, changed ones wait to be asked', () => {
		const plan = [file('a.ts', 'ready'), file('b.ts', 'changed'), file('c.ts', 'same')];
		expect(readyFiles(plan).map((f) => f.shown)).toEqual(['a.ts']);
		expect(changedFiles(plan).map((f) => f.shown)).toEqual(['b.ts']);
	});

	it('says what it put back and what it left, and why', () => {
		expect(describeRewindReport({ restored: [], skipped: [] })).toBe('');
		expect(
			describeRewindReport({
				restored: ['a.ts', 'b.ts'],
				skipped: [
					{ shown: 'c.ts', reason: 'changed' },
					{ shown: 'big.bin', reason: 'large' }
				]
			})
		).toBe(
			'Put back 2 files. Left c.ts (changed since the agent wrote it), big.bin (too large to keep).'
		);
	});
});
