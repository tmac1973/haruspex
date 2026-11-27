import { invoke } from '@tauri-apps/api/core';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);

import {
	killedForMemory,
	trackUnwatched,
	unwatchedOomNote,
	forgetUnwatchedForSession,
	_resetForTests
} from '#lib/shell/backgroundMemory.ts';
import { invokeRouter } from '#lib/testing/invoke.ts';

/** A terminal at `kills` memory-cap kills whose command wrote `done` (null: still running). */
function terminal(state: { kills: number; done: string | null }) {
	vi.mocked(invoke).mockImplementation(
		invokeRouter({
			shell_memory_status: () => ({ limitMb: 4096, oomKills: state.kills }),
			fs_read_text_absolute: (args) => {
				if (args!.path === '/tmp/b.done' && state.done != null) return state.done;
				throw new Error('ENOENT');
			}
		})
	);
}

const bg = { ptySessionId: 1, logPath: '/tmp/b', donePath: '/tmp/b.done', killsAtStart: 0 };

beforeEach(() => {
	_resetForTests();
	vi.mocked(invoke).mockReset();
});

describe('killedForMemory', () => {
	it('gives the limit when a failed command saw the kill count rise', async () => {
		terminal({ kills: 1, done: null });
		expect(await killedForMemory(1, 0, 137)).toBe(4096);
		expect(await killedForMemory(1, 1, 137)).toBeNull();
	});

	it('is null for a success, or without a count at the start', async () => {
		terminal({ kills: 3, done: null });
		expect(await killedForMemory(1, 0, 0)).toBeNull();
		expect(await killedForMemory(1, undefined, 137)).toBeNull();
	});

	it('is null when the terminal has no ceiling', async () => {
		vi.mocked(invoke).mockImplementation(invokeRouter({ shell_memory_status: null }));
		expect(await killedForMemory(1, 0, 137)).toBeNull();
	});
});

describe('unwatchedOomNote', () => {
	it('reports a kill once, after the command has exited', async () => {
		const state = { kills: 1, done: null as string | null };
		terminal(state);
		trackUnwatched(bg);
		// Still running: nothing to say yet, and it stays tracked.
		expect(await unwatchedOomNote('/tmp/b')).toBeNull();
		state.done = '137';
		const note = await unwatchedOomNote('/tmp/b');
		expect(note).toContain('exit code 137');
		expect(note).toContain('4.0 GB memory limit');
		expect(await unwatchedOomNote('/tmp/b')).toBeNull();
	});

	it('says nothing for a command that ended another way, or a file it does not track', async () => {
		terminal({ kills: 0, done: '1' });
		trackUnwatched(bg);
		expect(await unwatchedOomNote('/tmp/b')).toBeNull();
		expect(await unwatchedOomNote('/tmp/other')).toBeNull();
	});

	it('forgets a closed session’s commands', async () => {
		terminal({ kills: 1, done: '137' });
		trackUnwatched(bg);
		forgetUnwatchedForSession(1);
		expect(await unwatchedOomNote('/tmp/b')).toBeNull();
	});
});
