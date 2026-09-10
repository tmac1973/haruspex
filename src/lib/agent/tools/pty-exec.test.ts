import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	sleep: vi.fn()
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('$lib/utils/async', () => ({ sleep: mocks.sleep }));
vi.mock('$lib/stores/settings', () => ({ getSettings: () => ({ codeCommandExec: 'pty' }) }));

const HOOK_PATH = '/opt/haruspex/resources/shell-integration/haruspex.bash';

/**
 * A fake PTY driven by the marker counters run_command actually polls. The
 * hook write bumps `markerTotal` (a hooked shell redraws its prompt through
 * the hook, emitting markers); the command write bumps `completedTotal` (the
 * command ran to completion). `hookTakes: false` models a shell that swallowed
 * the source — the counter never moves.
 */
function mockPty(opts: {
	pending: string | null;
	hookPath?: string | null;
	hookTakes?: boolean;
	output?: string;
}) {
	const writes: string[] = [];
	const state = { markerTotal: 10, completedTotal: 0 };
	const hookTakes = opts.hookTakes ?? true;
	mocks.invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
		switch (cmd) {
			case 'shell_pending_command':
				return opts.pending;
			case 'shell_integration_hook':
				return opts.hookPath === undefined ? HOOK_PATH : opts.hookPath;
			case 'shell_get_context':
				return {
					completed_total: state.completedTotal,
					marker_total: state.markerTotal,
					current_cwd: '/home/tim'
				};
			case 'shell_write': {
				const data = String(args?.data ?? '');
				writes.push(data);
				if (data.includes('haruspex.bash')) {
					if (hookTakes) state.markerTotal += 2;
				} else {
					state.completedTotal += 1;
				}
				return null;
			}
			case 'shell_get_recent_commands':
				return [
					{
						commandLine: 'echo hi',
						output: opts.output ?? 'hi',
						exitCode: 0,
						cwd: '/home/tim',
						truncated: false
					}
				];
			default:
				return null;
		}
	});
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
		const firstAttempts = mocks.invoke.mock.calls.filter(
			(c) => c[0] === 'shell_integration_hook'
		).length;
		await runInPty(1, 'echo there', 30, undefined);
		const totalAttempts = mocks.invoke.mock.calls.filter(
			(c) => c[0] === 'shell_integration_hook'
		).length;
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
