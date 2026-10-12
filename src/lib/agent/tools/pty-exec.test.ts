import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	sleep: vi.fn()
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('#lib/utils/async.ts', () => ({ sleep: mocks.sleep }));
vi.mock('#lib/stores/settings.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/stores/settings.ts')>()),
	getSettings: () => ({ codeCommandExec: 'pty' })
}));

import { invokeCalls, invokeRouter } from '#lib/testing/invoke.ts';

const HOOK_PATH = '/opt/haruspex/resources/shell-integration/haruspex.bash';

/**
 * A fake PTY driven by the marker counters run_command actually polls. The
 * hook write bumps `markerTotal` (a hooked shell redraws its prompt through
 * the hook, emitting markers); the command write bumps `completedTotal` (the
 * command ran to completion). `hookTakes: false` models a shell that swallowed
 * the source — the counter never moves.
 */
type PtyOpts = {
	pending: string | null;
	hookPath?: string | null;
	hookTakes?: boolean;
	output?: string;
};

function ptyRoutes(opts: PtyOpts) {
	const writes: string[] = [];
	const state = { markerTotal: 10, completedTotal: 0 };
	const hookTakes = opts.hookTakes ?? true;
	const routes = {
		shell_pending_command: () => opts.pending,
		shell_integration_hook: () => (opts.hookPath === undefined ? HOOK_PATH : opts.hookPath),
		shell_get_context: () => ({
			completed_total: state.completedTotal,
			marker_total: state.markerTotal,
			current_cwd: '/home/tim'
		}),
		shell_write: (args?: Record<string, unknown>) => {
			const data = String(args?.data ?? '');
			writes.push(data);
			if (data.includes('haruspex.bash')) {
				if (hookTakes) state.markerTotal += 2;
			} else {
				state.completedTotal += 1;
			}
			return null;
		},
		shell_get_recent_commands: () => [
			{
				commandLine: 'echo hi',
				output: opts.output ?? 'hi',
				exitCode: 0,
				cwd: '/home/tim',
				truncated: false
			}
		]
	};
	return { writes, routes };
}

function mockPty(opts: PtyOpts) {
	const { writes, routes } = ptyRoutes(opts);
	mocks.invoke.mockImplementation(invokeRouter(routes));
	return writes;
}

beforeEach(async () => {
	vi.useFakeTimers();
	vi.setSystemTime(0);
	mocks.invoke.mockReset();
	// Every poll interval advances the clock the caller thinks has passed, so a
	// hook that never takes hits its deadline without burning three real
	// seconds of spinning.
	mocks.sleep.mockImplementation(async () => {
		vi.setSystemTime(Date.now() + 100);
	});
	const { resetNestedShellHooks } = await import('./pty-exec');
	resetNestedShellHooks();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('run_command with a shell the user opened by hand', () => {
	it('sources the hook into it and then runs the command', async () => {
		const writes = mockPty({ pending: 'bash' });
		const { runInPty } = await import('./pty-exec');
		const out = await runInPty(1, 'echo hi', 30, undefined);

		// Hook first, command second.
		expect(writes[0]).toContain(HOOK_PATH);
		expect(writes[0]).toContain('. ');
		expect(writes[1]).toContain('echo hi');
		expect(out).toContain('Exit code: 0');
		expect(out).toContain('hi');
	});

	it('asks for the hook matching the nested shell', async () => {
		mockPty({ pending: '/usr/bin/zsh -l' });
		const { runInPty } = await import('./pty-exec');
		await runInPty(1, 'echo hi', 30, undefined);
		expect(mocks.invoke).toHaveBeenCalledWith('shell_integration_hook', { shell: 'zsh' });
	});

	it('single-quotes the hook path so a space in it survives', async () => {
		const writes = mockPty({ pending: 'bash' });
		const { runInPty } = await import('./pty-exec');
		await runInPty(1, 'echo hi', 30, undefined);
		expect(writes[0]).toContain(`'${HOOK_PATH}'`);
	});

	it('refuses with advice when the hook does not take, and does not run the command', async () => {
		const writes = mockPty({ pending: 'bash', hookTakes: false });
		const { runInPty } = await import('./pty-exec');
		const out = await runInPty(1, 'echo hi', 30, undefined);

		expect(out).toContain('`bash` open inside it');
		expect(out).toContain('shell_input');
		expect(writes.some((w) => w.includes('echo hi'))).toBe(false);
	});

	it('does not re-source a hook that already failed for this shell', async () => {
		mockPty({ pending: 'bash', hookTakes: false });
		const { runInPty } = await import('./pty-exec');
		await runInPty(1, 'echo hi', 30, undefined);
		const firstAttempts = invokeCalls(mocks.invoke, 'shell_integration_hook').length;
		await runInPty(1, 'echo there', 30, undefined);
		const totalAttempts = invokeCalls(mocks.invoke, 'shell_integration_hook').length;
		expect(firstAttempts).toBe(1);
		expect(totalAttempts).toBe(1);
	});

	it('does not try to hook a shell we ship no hook for', async () => {
		mockPty({ pending: 'fish' });
		const { runInPty } = await import('./pty-exec');
		const out = await runInPty(1, 'echo hi', 30, undefined);
		expect(mocks.invoke).not.toHaveBeenCalledWith('shell_integration_hook', expect.anything());
		expect(out).toContain('`fish` open inside it');
		expect(out).toContain('Settings → Shell');
	});

	it('still reports a remote session as a remote session, not a nested shell', async () => {
		mockPty({ pending: 'ssh box' });
		const { runInPty } = await import('./pty-exec');
		const out = await runInPty(1, 'echo hi', 30, undefined);
		expect(mocks.invoke).not.toHaveBeenCalledWith('shell_integration_hook', expect.anything());
		expect(out).toContain('a remote host (box)');
	});

	it('still reports a genuinely busy terminal as busy', async () => {
		mockPty({ pending: 'npm run dev' });
		const { runInPty } = await import('./pty-exec');
		const out = await runInPty(1, 'echo hi', 30, undefined);
		expect(out).toContain('busy running `npm run dev`');
		expect(out).toContain('shell_interrupt');
	});
});

describe('run_command in a terminal with a memory limit', () => {
	/** The fake PTY, plus a terminal ceiling whose kill count the command can bump. */
	function withMemory(killedByCommand: boolean | null) {
		const { writes, routes } = ptyRoutes({ pending: null });
		let kills = 0;
		mocks.invoke.mockImplementation(
			invokeRouter({
				...routes,
				shell_memory_status: () =>
					killedByCommand === null ? null : { limitMb: 8192, oomKills: kills },
				shell_write: (args) => {
					const out = routes.shell_write(args);
					if (killedByCommand) kills += 1;
					return out;
				}
			})
		);
		return writes;
	}

	it('tells the model when the system killed what the command ran', async () => {
		withMemory(true);
		const { runInPty } = await import('./pty-exec');
		const out = await runInPty(1, 'go test ./...', 30, undefined);
		expect(out).toContain('Killed: this command went over its 8.0 GB memory limit');
	});

	it('says nothing more when nothing was killed, or there is no limit', async () => {
		const { runInPty } = await import('./pty-exec');
		for (const killed of [false, null]) {
			withMemory(killed);
			const out = await runInPty(1, 'echo hi', 30, undefined);
			expect(out).not.toContain('Killed');
			expect(out).toContain('Exit code: 0');
		}
	});
});
