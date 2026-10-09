import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RunCommandResult } from '#lib/ipc/gen/RunCommandResult.ts';

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	askCommandApproval: vi.fn(),
	isSessionApproved: vi.fn(() => false),
	approveSession: vi.fn(),
	registerWatch: vi.fn(() => 'watch-1'),
	registerCodeBgWatch: vi.fn(() => 'watch-2')
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('#lib/stores/codeCommandApproval.svelte.ts', () => ({
	askCommandApproval: mocks.askCommandApproval,
	isSessionApproved: mocks.isSessionApproved,
	approveSession: mocks.approveSession,
	codeApprovalKey: (id: string) => `code:${id}`,
	SHELL_APPROVAL_KEY: 'shell'
}));
vi.mock('#lib/shell/backgroundWatch.ts', () => ({
	registerWatch: mocks.registerWatch,
	registerCodeBgWatch: mocks.registerCodeBgWatch
}));

const codeCtx = {
	workingDir: '/work',
	pendingImages: [],
	deepResearch: false,
	shellMode: false,
	codeMode: true,
	codeAutoApprove: false,
	filesWrittenThisTurn: new Set<string>()
};

const okResult: RunCommandResult = {
	stdout: 'hello\n',
	stderr: '',
	exit_code: 0,
	killed: false,
	duration_ms: 5,
	out_of_memory: false,
	memory_limit_mb: 32768
};

function runResultDefaults(over: Partial<RunCommandResult> = {}): RunCommandResult {
	return { ...okResult, ...over };
}

beforeEach(() => {
	mocks.invoke.mockReset();
	mocks.askCommandApproval.mockReset();
	mocks.isSessionApproved.mockReset().mockReturnValue(false);
	mocks.approveSession.mockReset();
	mocks.registerWatch.mockReset().mockReturnValue('watch-1');
	mocks.registerCodeBgWatch.mockReset().mockReturnValue('watch-2');
	mocks.invoke.mockImplementation((cmd: string) => {
		if (cmd === 'run_command_capture') return Promise.resolve(runResultDefaults());
		if (cmd === 'code_write_overflow') return Promise.resolve('/tmp/overflow.txt');
		return Promise.resolve();
	});
});

describe('run_command risk gate', () => {
	it('runs a safe command without prompting', async () => {
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const out = await executeTool('run_command', { command: 'ls -la' }, codeCtx);
		expect(mocks.askCommandApproval).not.toHaveBeenCalled();
		expect(mocks.invoke).toHaveBeenCalledWith(
			'run_command_capture',
			expect.objectContaining({ command: 'ls -la', cwd: '/work' })
		);
		expect(out.result).toContain('Exit code: 0');
		expect(out.result).toContain('hello');
	});

	it('passes the memory limit, and tells the model when a command outgrew it', async () => {
		// A coding run's go test hit a loop that never ended, filled RAM and
		// swap, and took the app down with it. Killed under a ceiling, the
		// model has to hear why, or it re-runs the same command.
		mocks.invoke.mockImplementation((cmd: string) =>
			cmd === 'run_command_capture'
				? Promise.resolve(
						runResultDefaults({ exit_code: 1, stdout: 'signal: killed', out_of_memory: true })
					)
				: Promise.resolve()
		);
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const out = await executeTool('run_command', { command: 'go test ./...' }, codeCtx);
		expect(mocks.invoke).toHaveBeenCalledWith(
			'run_command_capture',
			expect.objectContaining({ memoryLimitPercent: 50 })
		);
		expect(out.result).toContain('went over its 32.0 GB memory limit');
		expect(out.result).toContain('do not re-run it unchanged');
		expect(out.result).toContain('signal: killed');
	});

	it('denies a risky command WITHOUT prompting during an unattended run', async () => {
		// A real unattended run parked ~15 minutes on the rm approval modal.
		// Under runWithAutoApprove (how every job turn executes) the gate must
		// deny-with-guidance, never open a modal — and never auto-run: shell
		// commands are not sandboxed to the working dir the way fs writes are.
		const { runWithAutoApprove } = await import('#lib/stores/approvalOverride.ts');
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const out = await runWithAutoApprove(() =>
			executeTool('run_command', { command: 'rm -rf build' }, codeCtx)
		);
		expect(mocks.askCommandApproval).not.toHaveBeenCalled();
		expect(mocks.invoke).not.toHaveBeenCalledWith('run_command_capture', expect.anything());
		expect(out.result).toContain('unattended');
		expect(out.result).toContain('Do not retry');
	});

	it('still runs SAFE commands in an unattended run', async () => {
		const { runWithAutoApprove } = await import('#lib/stores/approvalOverride.ts');
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const out = await runWithAutoApprove(() =>
			executeTool('run_command', { command: 'ls -la' }, codeCtx)
		);
		expect(out.result).toContain('Exit code: 0');
	});

	it('prompts (not denies) during an ATTENDED job turn — the preflight case', async () => {
		// Preflight runs inside runWithAutoApprove like every job turn, but with
		// the user present (interactive) and instructed to trial-run candidate
		// commands. A real preflight was denied with "nobody is present to
		// approve" while the user sat at the keyboard.
		mocks.askCommandApproval.mockResolvedValue('deny');
		const { runWithAutoApprove } = await import('#lib/stores/approvalOverride.ts');
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		await runWithAutoApprove(() =>
			executeTool('run_command', { command: 'rm -rf build' }, { ...codeCtx, interactive: true })
		);
		expect(mocks.askCommandApproval).toHaveBeenCalled();
	});

	it('prompts on a risky command and aborts on deny', async () => {
		mocks.askCommandApproval.mockResolvedValue('deny');
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const out = await executeTool('run_command', { command: 'rm -rf /' }, codeCtx);
		expect(mocks.askCommandApproval).toHaveBeenCalled();
		expect(mocks.invoke).not.toHaveBeenCalledWith('run_command_capture', expect.anything());
		expect(out.result).toContain('denied');
	});

	it('runs after allow_once without flipping session approval', async () => {
		mocks.askCommandApproval.mockResolvedValue('allow_once');
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		await executeTool('run_command', { command: 'sudo reboot' }, codeCtx);
		expect(mocks.invoke).toHaveBeenCalledWith('run_command_capture', expect.anything());
		expect(mocks.approveSession).not.toHaveBeenCalled();
	});

	it('flips session approval on allow_session', async () => {
		mocks.askCommandApproval.mockResolvedValue('allow_session');
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		await executeTool('run_command', { command: 'sudo reboot' }, codeCtx);
		expect(mocks.approveSession).toHaveBeenCalledWith('shell');
	});

	it("keys a Code session's approval by its id", async () => {
		mocks.askCommandApproval.mockResolvedValue('allow_session');
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		await executeTool(
			'run_command',
			{ command: 'sudo reboot' },
			{ ...codeCtx, codeSessionId: 's1' }
		);
		expect(mocks.isSessionApproved).toHaveBeenCalledWith('code:s1');
		expect(mocks.approveSession).toHaveBeenCalledWith('code:s1');
	});

	it('skips the prompt when codeAutoApprove is on', async () => {
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		await executeTool(
			'run_command',
			{ command: 'rm -rf /' },
			{ ...codeCtx, codeAutoApprove: true }
		);
		expect(mocks.askCommandApproval).not.toHaveBeenCalled();
		expect(mocks.invoke).toHaveBeenCalledWith('run_command_capture', expect.anything());
	});

	it('skips the prompt when the session is already approved', async () => {
		mocks.isSessionApproved.mockReturnValue(true);
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		await executeTool('run_command', { command: 'rm -rf /' }, codeCtx);
		expect(mocks.askCommandApproval).not.toHaveBeenCalled();
		expect(mocks.invoke).toHaveBeenCalledWith('run_command_capture', expect.anything());
	});
});

describe('run_command output handling', () => {
	it('states success explicitly when exit 0 produces no output', async () => {
		mocks.invoke.mockImplementation((cmd: string) => {
			if (cmd === 'run_command_capture')
				return Promise.resolve(runResultDefaults({ stdout: '', stderr: '', exit_code: 0 }));
			return Promise.resolve();
		});
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const out = await executeTool('run_command', { command: './my-gui' }, codeCtx);
		expect(out.result).toContain('succeeded with no output');
	});

	it('leads with the exit code and reports a killed command', async () => {
		mocks.invoke.mockImplementation((cmd: string) => {
			if (cmd === 'run_command_capture')
				return Promise.resolve(runResultDefaults({ killed: true, exit_code: null }));
			return Promise.resolve();
		});
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const out = await executeTool('run_command', { command: 'sleep 99' }, codeCtx);
		expect(out.result).toContain('killed');
	});

	it('spills oversized output to a temp file', async () => {
		const big = 'x'.repeat(40 * 1024);
		mocks.invoke.mockImplementation((cmd: string) => {
			if (cmd === 'run_command_capture') return Promise.resolve(runResultDefaults({ stdout: big }));
			if (cmd === 'code_write_overflow') return Promise.resolve('/tmp/overflow.txt');
			return Promise.resolve();
		});
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const out = await executeTool('run_command', { command: 'cat big' }, codeCtx);
		expect(mocks.invoke).toHaveBeenCalledWith('code_write_overflow', expect.anything());
		expect(out.result).toContain('/tmp/overflow.txt');
		expect(out.result).toContain('fs_read_text');
	});

	it('cancels the host process when the signal aborts mid-run', async () => {
		const controller = new AbortController();
		let resolveRun: (v: unknown) => void = () => {};
		mocks.invoke.mockImplementation((cmd: string) => {
			if (cmd === 'run_command_capture') return new Promise((r) => (resolveRun = r));
			return Promise.resolve();
		});
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const p = executeTool(
			'run_command',
			{ command: 'sleep 99' },
			{ ...codeCtx, signal: controller.signal }
		);
		// Let the approval gate resolve and runHostCommand register its abort
		// listener, then abort while the command is "running".
		await new Promise((r) => setTimeout(r, 0));
		controller.abort();
		expect(mocks.invoke).toHaveBeenCalledWith('run_command_cancel', expect.anything());
		resolveRun(runResultDefaults({ killed: true, exit_code: null }));
		await p;
	});
});

describe('code_grep / code_glob formatting', () => {
	it('formats grep matches as file:line: text', async () => {
		mocks.invoke.mockResolvedValueOnce({
			matches: [{ path: 'src/a.rs', line: 12, text: 'fn needle()', is_match: true }],
			truncated: false,
			counts: [],
			total: 0,
			files: []
		});
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const out = await executeTool('code_grep', { pattern: 'needle' }, codeCtx);
		expect(out.result).toBe('src/a.rs:12: fn needle()');
	});

	it('formats count mode as per-file totals + grand total', async () => {
		mocks.invoke.mockResolvedValueOnce({
			matches: [],
			truncated: false,
			counts: [
				{ path: 'src/a.rs', count: 2 },
				{ path: 'src/b.rs', count: 1 }
			],
			total: 3,
			files: []
		});
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const out = await executeTool('code_grep', { pattern: 'x', count: true }, codeCtx);
		expect(out.result).toBe('src/a.rs: 2\nsrc/b.rs: 1\nTotal: 3 in 2 files');
	});

	it('formats files_only mode as a bare file list', async () => {
		mocks.invoke.mockResolvedValueOnce({
			matches: [],
			truncated: false,
			counts: [],
			total: 0,
			files: ['src/a.rs', 'src/b.rs']
		});
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const out = await executeTool('code_grep', { pattern: 'x', files_only: true }, codeCtx);
		expect(out.result).toBe('src/a.rs\nsrc/b.rs');
	});

	it('marks context lines with a "-" separator (grep -C style)', async () => {
		mocks.invoke.mockResolvedValueOnce({
			matches: [
				{ path: 'a.rs', line: 1, text: 'fn main() {', is_match: false },
				{ path: 'a.rs', line: 2, text: 'needle();', is_match: true },
				{ path: 'a.rs', line: 3, text: '}', is_match: false }
			],
			truncated: false,
			counts: [],
			total: 0,
			files: []
		});
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const out = await executeTool('code_grep', { pattern: 'needle', context: 1 }, codeCtx);
		expect(out.result).toBe('a.rs-1: fn main() {\na.rs:2: needle();\na.rs-3: }');
	});

	it('reports no grep matches', async () => {
		mocks.invoke.mockResolvedValueOnce({ matches: [], truncated: false });
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const out = await executeTool('code_grep', { pattern: 'zzz' }, codeCtx);
		expect(out.result).toBe('No matches.');
	});

	it('surfaces the grep overflow note', async () => {
		mocks.invoke.mockResolvedValueOnce({
			matches: [{ path: 'a', line: 1, text: 'x' }],
			truncated: true
		});
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const out = await executeTool('code_grep', { pattern: 'x' }, codeCtx);
		expect(out.result).toContain('truncated');
	});

	it('formats glob paths and the empty case', async () => {
		mocks.invoke.mockResolvedValueOnce({ paths: ['src/a.ts', 'src/b.ts'], truncated: false });
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const out = await executeTool('code_glob', { pattern: '**/*.ts' }, codeCtx);
		expect(out.result).toBe('src/a.ts\nsrc/b.ts');

		mocks.invoke.mockResolvedValueOnce({ paths: [], truncated: false });
		const empty = await executeTool('code_glob', { pattern: '**/*.zzz' }, codeCtx);
		expect(empty.result).toBe('No files match.');
	});
});

describe('Shell + Code combined mode', () => {
	const shellCodeCtx = {
		workingDir: null,
		shellCwd: '/proj',
		pendingImages: [],
		deepResearch: false,
		shellMode: true,
		codeMode: true,
		codeAutoApprove: false,
		filesWrittenThisTurn: new Set<string>()
	};

	it('code_grep roots at the live shell CWD', async () => {
		mocks.invoke.mockResolvedValueOnce({ matches: [], truncated: false });
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		await executeTool('code_grep', { pattern: 'x' }, shellCodeCtx);
		expect(mocks.invoke).toHaveBeenCalledWith(
			'code_grep',
			expect.objectContaining({ root: '/proj', pattern: 'x' })
		);
	});

	it('code_grep / code_glob pass the WSL distro only for a shell-cwd root', async () => {
		const { updateSettings } = await import('#lib/stores/settings.ts');
		updateSettings({ shellSelection: { kind: 'wsl', distro: 'Ubuntu-24.04' } });
		try {
			const { executeTool } = await import('#lib/agent/tools/index.ts');
			mocks.invoke.mockResolvedValue({ matches: [], truncated: false });
			await executeTool('code_grep', { pattern: 'x' }, shellCodeCtx);
			expect(mocks.invoke).toHaveBeenCalledWith(
				'code_grep',
				expect.objectContaining({ root: '/proj', wslDistro: 'Ubuntu-24.04' })
			);
			mocks.invoke.mockResolvedValue({ paths: [], truncated: false });
			await executeTool('code_glob', { pattern: '**/*.rs' }, shellCodeCtx);
			expect(mocks.invoke).toHaveBeenCalledWith(
				'code_glob',
				expect.objectContaining({ root: '/proj', wslDistro: 'Ubuntu-24.04' })
			);
			// The Code tab's working directory is a host path — no distro.
			mocks.invoke.mockClear();
			await executeTool('code_glob', { pattern: '**/*.rs' }, codeCtx);
			expect(mocks.invoke.mock.calls[0][1]).not.toHaveProperty('wslDistro');
		} finally {
			updateSettings({ shellSelection: null });
		}
	});

	it('fs_edit_text dispatches absolute (shell CWD) in Code mode', async () => {
		mocks.invoke.mockResolvedValueOnce({
			first_changed_line: 1,
			line_before: 'a',
			line_after: 'b',
			used_fuzzy: false
		});
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		await executeTool('fs_edit_text', { path: 'foo.ts', old_str: 'a', new_str: 'b' }, shellCodeCtx);
		expect(mocks.invoke).toHaveBeenCalledWith('fs_edit_text_absolute', {
			path: '/proj/foo.ts',
			oldStr: 'a',
			newStr: 'b'
		});
	});
});

describe('the Code tab root (codeMode without shellMode)', () => {
	// A stale shell cwd must not leak in: outside shell mode the tools root
	// at the session's working directory, whatever else the context carries.
	const tabCtx = { ...codeCtx, shellCwd: '/elsewhere' };

	it('code_grep and code_glob root at the working directory, not the shell cwd', async () => {
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		mocks.invoke.mockResolvedValueOnce({ matches: [], truncated: false });
		await executeTool('code_grep', { pattern: 'x' }, tabCtx);
		expect(mocks.invoke).toHaveBeenCalledWith(
			'code_grep',
			expect.objectContaining({ root: '/work' })
		);
		mocks.invoke.mockResolvedValueOnce({ paths: [], truncated: false });
		await executeTool('code_glob', { pattern: '*' }, tabCtx);
		expect(mocks.invoke).toHaveBeenCalledWith(
			'code_glob',
			expect.objectContaining({ root: '/work' })
		);
	});

	it('run_command runs in the working directory', async () => {
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		await executeTool('run_command', { command: 'pwd' }, tabCtx);
		expect(mocks.invoke).toHaveBeenCalledWith(
			'run_command_capture',
			expect.objectContaining({ cwd: '/work' })
		);
	});
});

describe('run_command PTY driving', () => {
	const ptyCtx = {
		workingDir: null,
		shellCwd: '/proj',
		shellSessionId: 1,
		pendingImages: [],
		deepResearch: false,
		shellMode: true,
		codeMode: true,
		codeAutoApprove: true, // skip the approval prompt in these tests
		filesWrittenThisTurn: new Set<string>()
	};

	it('drives the live PTY and reports the captured exit code', async () => {
		// The command completes once it has been written to the terminal.
		let written = false;
		mocks.invoke.mockImplementation((cmd: string) => {
			if (cmd === 'shell_write') written = true;
			if (cmd === 'shell_platform_supported') return Promise.resolve(true);
			if (cmd === 'shell_get_context') {
				return Promise.resolve({
					completed_total: written ? 1 : 0,
					marker_count: 2,
					current_cwd: '/proj'
				});
			}
			if (cmd === 'shell_get_recent_commands')
				return Promise.resolve([
					{ commandLine: 'ls', output: 'a.txt\n', exitCode: 0, cwd: '/proj', truncated: false }
				]);
			return Promise.resolve();
		});
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const out = await executeTool('run_command', { command: 'ls' }, ptyCtx);
		expect(mocks.invoke).toHaveBeenCalledWith(
			'shell_write',
			expect.objectContaining({ sessionId: 1 })
		);
		expect(out.result).toContain('Exit code: 0');
		expect(out.result).toContain('a.txt');
		expect(mocks.invoke).not.toHaveBeenCalledWith('run_command_capture', expect.anything());
	});

	it('falls back to one-shot when codeCommandExec is "oneshot"', async () => {
		const { updateSettings } = await import('#lib/stores/settings.ts');
		updateSettings({ codeCommandExec: 'oneshot' });
		mocks.invoke.mockImplementation((cmd: string) => {
			if (cmd === 'run_command_capture') return Promise.resolve(runResultDefaults());
			return Promise.resolve();
		});
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		await executeTool('run_command', { command: 'ls' }, ptyCtx);
		expect(mocks.invoke).toHaveBeenCalledWith(
			'run_command_capture',
			expect.objectContaining({ cwd: '/proj' })
		);
		updateSettings({ codeCommandExec: 'auto' });
	});

	it('refuses to inject when the terminal is already busy', async () => {
		mocks.invoke.mockImplementation((cmd: string) => {
			if (cmd === 'shell_platform_supported') return Promise.resolve(true);
			// The busy check reads just the command line — asking for the recent
			// commands would serialize the in-flight command's whole output.
			if (cmd === 'shell_pending_command') return Promise.resolve('go run main.go');
			if (cmd === 'shell_get_context') return Promise.resolve({ marker_count: 2 });
			return Promise.resolve();
		});
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const out = await executeTool('run_command', { command: 'kill %1' }, ptyCtx);
		expect(out.result).toContain('busy running');
		expect(out.result).toContain('go run main.go');
		// Refused: never wrote the new command into the PTY.
		expect(mocks.invoke).not.toHaveBeenCalledWith('shell_write', expect.anything());
	});

	it('falls back to one-shot when the platform is unsupported', async () => {
		mocks.invoke.mockImplementation((cmd: string) => {
			if (cmd === 'shell_platform_supported') return Promise.resolve(false);
			if (cmd === 'run_command_capture') return Promise.resolve(runResultDefaults());
			return Promise.resolve();
		});
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		await executeTool('run_command', { command: 'ls' }, ptyCtx);
		expect(mocks.invoke).toHaveBeenCalledWith('run_command_capture', expect.anything());
	});

	it('sends Ctrl-C to the PTY on abort', async () => {
		const controller = new AbortController();
		mocks.invoke.mockImplementation((cmd: string) => {
			if (cmd === 'shell_platform_supported') return Promise.resolve(true);
			if (cmd === 'shell_get_context')
				return Promise.resolve({ completed_total: 0, marker_count: 2, current_cwd: '/proj' });
			// Idle terminal (no pending command) so the busy-guard lets us inject.
			if (cmd === 'shell_get_recent_commands') return Promise.resolve([]);
			return Promise.resolve();
		});
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const p = executeTool(
			'run_command',
			{ command: 'sleep 99', timeout_secs: 2 },
			{ ...ptyCtx, signal: controller.signal }
		);
		await new Promise((r) => setTimeout(r, 50));
		controller.abort();
		await p;
		expect(mocks.invoke).toHaveBeenCalledWith(
			'shell_write',
			expect.objectContaining({ data: '\x03' })
		);
	});
});

describe('run_command background / watch', () => {
	const ptyCtx = {
		workingDir: null,
		shellCwd: '/proj',
		shellSessionId: 1,
		pendingImages: [],
		deepResearch: false,
		shellMode: true,
		codeMode: true,
		codeAutoApprove: true,
		filesWrittenThisTurn: new Set<string>()
	};

	// Mock the PTY so runInPtyBackground's wrapper "runs" and the captured
	// output carries the HSP_BG marker line it parses for pid/log/done.
	function mockBackgroundPty(context?: { shellPath: string; shellName: string }) {
		// The command completes once it has been written to the terminal.
		let written = false;
		mocks.invoke.mockImplementation((cmd: string) => {
			if (cmd === 'shell_write') written = true;
			if (cmd === 'shell_platform_supported') return Promise.resolve(true);
			if (cmd === 'shell_get_context') {
				return Promise.resolve({
					completed_total: written ? 1 : 0,
					marker_count: 2,
					current_cwd: '/proj',
					context
				});
			}
			if (cmd === 'shell_get_recent_commands')
				return Promise.resolve([
					{
						commandLine: 'bg',
						output: 'HSP_BG pid=12345 log=/tmp/hsp-bg-AAA done=/tmp/hsp-bg-AAA.done\n',
						exitCode: 0,
						cwd: '/proj',
						truncated: false
					}
				]);
			return Promise.resolve();
		});
	}

	it('background:true detaches and returns the pid + log path, without watching', async () => {
		mockBackgroundPty();
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const out = await executeTool(
			'run_command',
			{ command: 'npm run dev', background: true },
			ptyCtx
		);
		expect(out.result).toContain('Started in the background');
		expect(out.result).toContain('12345');
		expect(out.result).toContain('/tmp/hsp-bg-AAA');
		expect(mocks.registerWatch).not.toHaveBeenCalled();
		// The detaching wrapper is what got injected (not a plain foreground run).
		expect(mocks.invoke).toHaveBeenCalledWith(
			'shell_write',
			expect.objectContaining({ sessionId: 1 })
		);
	});

	it('watch:true also registers a watch for the owning session', async () => {
		mockBackgroundPty();
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const out = await executeTool('run_command', { command: 'pytest -q', watch: true }, ptyCtx);
		expect(out.result).toContain('watch on');
		expect(out.result).toContain('12345');
		expect(mocks.registerWatch).toHaveBeenCalledTimes(1);
		expect(mocks.registerWatch).toHaveBeenCalledWith(
			expect.objectContaining({
				ptySessionId: 1,
				command: 'pytest -q',
				logPath: '/tmp/hsp-bg-AAA',
				donePath: '/tmp/hsp-bg-AAA.done'
			})
		);
	});

	it('reports a line the shell rejected instead of waiting out the timeout', async () => {
		// Fish refusing bash syntax: the prompt is redrawn (new markers) but
		// nothing starts and nothing finishes.
		let written = false;
		mocks.invoke.mockImplementation((cmd: string) => {
			if (cmd === 'shell_write') written = true;
			if (cmd === 'shell_platform_supported') return Promise.resolve(true);
			if (cmd === 'shell_pending_command') return Promise.resolve(null);
			if (cmd === 'shell_get_context') {
				return Promise.resolve({
					completed_total: 0,
					marker_count: 2,
					marker_total: written ? 4 : 2,
					output_total: 100,
					current_cwd: '/proj',
					context: { shellPath: '/usr/bin/fish', shellName: 'fish' }
				});
			}
			if (cmd === 'shell_output_since')
				return Promise.resolve("fish: Unsupported use of '='. In fish, please use 'set x 1'.");
			return Promise.resolve();
		});
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const started = Date.now();
		const out = await executeTool('run_command', { command: 'x=1', timeout_secs: 30 }, ptyCtx);
		expect(Date.now() - started).toBeLessThan(5000);
		expect(out.result).toContain('did not run this command');
		expect(out.result).toContain("Unsupported use of '='");
		expect(out.result).toContain('runs fish');
		expect(mocks.invoke).toHaveBeenCalledWith('shell_output_since', { sessionId: 1, from: 100 });
	});

	it('does not read a running command as rejected', async () => {
		// New markers while the command is still pending are its own start
		// marker, not a refusal.
		let written = false;
		let polls = 0;
		mocks.invoke.mockImplementation((cmd: string) => {
			if (cmd === 'shell_write') written = true;
			if (cmd === 'shell_platform_supported') return Promise.resolve(true);
			if (cmd === 'shell_pending_command') return Promise.resolve(written ? 'sleep 1' : null);
			if (cmd === 'shell_get_context') {
				polls++;
				return Promise.resolve({
					completed_total: polls >= 6 ? 1 : 0,
					marker_count: 2,
					marker_total: polls > 1 ? 3 : 2,
					output_total: 0,
					current_cwd: '/proj'
				});
			}
			if (cmd === 'shell_get_recent_commands')
				return Promise.resolve([
					{ commandLine: 'sleep 1', output: '', exitCode: 0, cwd: '/proj', truncated: false }
				]);
			return Promise.resolve();
		});
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const out = await executeTool('run_command', { command: 'sleep 1' }, ptyCtx);
		expect(out.result).toContain('Exit code: 0');
		expect(mocks.invoke).not.toHaveBeenCalledWith('shell_output_since', expect.anything());
	});

	it('falls back to one-shot in auto mode when the shell never sent a marker', async () => {
		mocks.invoke.mockImplementation((cmd: string) => {
			if (cmd === 'shell_platform_supported') return Promise.resolve(true);
			if (cmd === 'shell_get_context')
				return Promise.resolve({ completed_total: 0, marker_count: 0, marker_total: 0 });
			if (cmd === 'run_command_capture') return Promise.resolve(runResultDefaults());
			return Promise.resolve();
		});
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		await executeTool('run_command', { command: 'ls' }, ptyCtx);
		expect(mocks.invoke).toHaveBeenCalledWith('run_command_capture', expect.anything());
		expect(mocks.invoke).not.toHaveBeenCalledWith('shell_write', expect.anything());
	});

	it('hands the background wrapper to bash under fish', async () => {
		mockBackgroundPty({ shellPath: '/usr/bin/fish', shellName: 'fish' });
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const out = await executeTool(
			'run_command',
			{ command: 'npm run dev', background: true },
			ptyCtx
		);
		expect(out.result).toContain('Started in the background');
		const writes = mocks.invoke.mock.calls.filter((c) => c[0] === 'shell_write');
		const data = String((writes[0][1] as { data: string }).data);
		expect(data).toMatch(/echo [A-Za-z0-9+/=]+ \| base64 -d \| bash/);
		const encoded = data.match(/echo ([A-Za-z0-9+/=]+)/)![1];
		expect(Buffer.from(encoded, 'base64').toString('utf8')).toContain('npm run dev');
	});

	it('rejects background without a live terminal session', async () => {
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const out = await executeTool(
			'run_command',
			{ command: 'npm run dev', background: true },
			codeCtx // no shellSessionId
		);
		expect(out.result).toContain('live terminal session');
		expect(mocks.registerWatch).not.toHaveBeenCalled();
		expect(mocks.invoke).not.toHaveBeenCalledWith('shell_write', expect.anything());
	});
});

describe('Code-mode tool filtering', () => {
	const CODE_TOOLS = [
		'fs_read_text',
		'fs_list_dir',
		'fs_edit_text',
		'fs_write_text',
		'code_grep',
		'code_glob',
		'run_command',
		'web_search',
		'research_url'
	].sort();

	it('the Code tab exposes the CODE_TOOLS allowlist plus its own tools', async () => {
		const { getToolSchemas } = await import('#lib/agent/tools/index.ts');
		const names = getToolSchemas({ hasWorkingDir: true, codeMode: true })
			.map((s) => s.function.name)
			.sort();
		expect(names).toEqual(
			[...CODE_TOOLS, 'command_output', 'command_stop', 'open_in_shell', 'open_in_editor'].sort()
		);
	});

	it('codeMode wins over shellMode and exposes the code toolset plus interactive PTY tools', async () => {
		const { getToolSchemas } = await import('#lib/agent/tools/index.ts');
		const names = getToolSchemas({ hasWorkingDir: false, shellMode: true, codeMode: true }).map(
			(s) => s.function.name
		);
		// Code toolset, plus the interactive terminal tools that only appear when
		// Code mode is driving a live shell session (vision defaults on, so
		// shell_snapshot is included too).
		const expected = [
			...CODE_TOOLS,
			'shell_read',
			'shell_input',
			'shell_interrupt',
			'shell_snapshot'
		].sort();
		expect(names.sort()).toEqual(expected);
	});

	it('run_command (exec) never leaks into Chat or Shell schemas', async () => {
		const { getToolSchemas } = await import('#lib/agent/tools/index.ts');
		const chat = getToolSchemas({ hasWorkingDir: true }).map((s) => s.function.name);
		const shell = getToolSchemas({ hasWorkingDir: false, shellMode: true }).map(
			(s) => s.function.name
		);
		expect(chat).not.toContain('run_command');
		expect(shell).not.toContain('run_command');
		// Chat/Shell also never see code_grep/code_glob (Code-only fs tools).
		expect(chat).not.toContain('code_grep');
		expect(shell).not.toContain('code_glob');
	});
});

describe('run_command boundary', () => {
	const targets = {
		home: '/home/tim',
		paths: [{ path: '/home/tim/.local/share/com.haruspex.app/', label: 'data directory' }],
		ports: [{ port: 8767, label: 'image engine' }]
	};
	const DB = 'sqlite3 ~/.local/share/com.haruspex.app/haruspex.db .tables';

	beforeEach(async () => {
		(await import('#lib/shell/boundary.ts'))._resetBoundary();
		mocks.invoke.mockImplementation((cmd: string) => {
			if (cmd === 'app_protected_targets') return Promise.resolve(targets);
			if (cmd === 'run_command_capture') return Promise.resolve(runResultDefaults());
			return Promise.resolve();
		});
	});

	it('refuses an unattended command that reaches Haruspex, even with auto-approve on', async () => {
		const { runWithAutoApprove } = await import('#lib/stores/approvalOverride.ts');
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const { onBoundaryRefusal } = await import('#lib/shell/boundary.ts');
		const refused: string[] = [];
		const stop = onBoundaryRefusal((r) => refused.push(r.command));
		const out = await runWithAutoApprove(() =>
			executeTool('run_command', { command: DB }, { ...codeCtx, codeAutoApprove: true })
		);
		stop();
		expect(mocks.askCommandApproval).not.toHaveBeenCalled();
		expect(mocks.invoke).not.toHaveBeenCalledWith('run_command_capture', expect.anything());
		expect(out.result).toContain("touches Haruspex's data directory");
		expect(out.result).toContain('Do not retry');
		// Heard by whoever is listening: the coding run puts it in its report.
		expect(refused).toEqual([DB]);
	});

	it('asks when someone is there, and "allow for this session" does not cover it', async () => {
		mocks.isSessionApproved.mockReturnValue(true);
		mocks.askCommandApproval.mockResolvedValue('allow_session');
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		await executeTool(
			'run_command',
			{ command: 'curl localhost:8767/sdapi/v1/sd-models' },
			codeCtx
		);
		expect(mocks.askCommandApproval).toHaveBeenCalledWith(
			expect.objectContaining({
				reasons: [
					{ label: 'outside the project', description: "calls Haruspex's image engine (port 8767)" }
				]
			})
		);
		expect(mocks.approveSession).not.toHaveBeenCalled();
	});

	it('leaves the project’s own commands to the usual rules', async () => {
		const { runWithAutoApprove } = await import('#lib/stores/approvalOverride.ts');
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const out = await runWithAutoApprove(() =>
			executeTool('run_command', { command: 'npm test' }, codeCtx)
		);
		expect(out.result).toContain('Exit code: 0');
	});

	it('names the risk in words, not "[object Object]"', async () => {
		const { runWithAutoApprove } = await import('#lib/stores/approvalOverride.ts');
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const out = await runWithAutoApprove(() =>
			executeTool('run_command', { command: 'rm -rf build' }, codeCtx)
		);
		expect(out.result).not.toContain('[object Object]');
	});
});

describe('run_command without a terminal (Code session)', () => {
	const sessionCtx = { ...codeCtx, codeSessionId: 'sess-1' };
	const bgProc = {
		id: 'bg-1',
		owner: 'sess-1',
		command: 'npm run dev',
		cwd: '/work',
		pid: 4242,
		started_at: Date.now(),
		running: true,
		exit_code: null,
		log_path: '/cache/code-bg/bg-1.log'
	};

	beforeEach(() => {
		mocks.invoke.mockImplementation((cmd: string) => {
			if (cmd === 'code_bg_start')
				return Promise.resolve({ id: 'bg-1', pid: 4242, log_path: '/cache/code-bg/bg-1.log' });
			if (cmd === 'code_bg_status') return Promise.resolve([bgProc]);
			if (cmd === 'code_bg_tail') return Promise.resolve('listening on :5173\n');
			if (cmd === 'run_command_capture') return Promise.resolve(runResultDefaults());
			return Promise.resolve();
		});
	});

	it('background:true starts a code_bg process owned by the session', async () => {
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const out = await executeTool(
			'run_command',
			{ command: 'npm run dev', background: true },
			sessionCtx
		);
		expect(mocks.invoke).toHaveBeenCalledWith(
			'code_bg_start',
			expect.objectContaining({ owner: 'sess-1', cwd: '/work', command: 'npm run dev' })
		);
		expect(out.result).toContain('id bg-1');
		expect(out.result).toContain('command_output');
		expect(mocks.registerCodeBgWatch).not.toHaveBeenCalled();
		expect(mocks.registerWatch).not.toHaveBeenCalled();
	});

	it('watch:true also registers a code_bg watch for the session', async () => {
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const out = await executeTool('run_command', { command: 'npm test', watch: true }, sessionCtx);
		expect(mocks.registerCodeBgWatch).toHaveBeenCalledWith(
			expect.objectContaining({ owner: 'sess-1', processId: 'bg-1', command: 'npm test' })
		);
		expect(out.result).toContain('do NOT poll');
	});

	it('still refuses background with neither a terminal nor a session', async () => {
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const out = await executeTool(
			'run_command',
			{ command: 'npm run dev', background: true },
			codeCtx
		);
		expect(out.result).toContain('live terminal session');
		expect(mocks.invoke).not.toHaveBeenCalledWith('code_bg_start', expect.anything());
	});

	it('appends the terminal hint when a one-shot sudo fails for want of a TTY', async () => {
		mocks.invoke.mockImplementation((cmd: string) =>
			cmd === 'run_command_capture'
				? Promise.resolve(
						runResultDefaults({
							stdout: '',
							stderr:
								'sudo: a terminal is required to read the password; either use the -S option to read from standard input or configure an askpass helper\nsudo: a password is required\n',
							exit_code: 1
						})
					)
				: Promise.resolve()
		);
		mocks.askCommandApproval.mockResolvedValue('allow_once');
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const out = await executeTool('run_command', { command: 'sudo dnf install foo' }, sessionCtx);
		expect(out.result).toContain('Exit code: 1');
		expect(out.result).toContain('Shell tab');
	});

	it('adds no terminal hint for an ordinary failure', async () => {
		mocks.invoke.mockImplementation((cmd: string) =>
			cmd === 'run_command_capture'
				? Promise.resolve(runResultDefaults({ stderr: 'boom\n', exit_code: 2 }))
				: Promise.resolve()
		);
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const out = await executeTool('run_command', { command: 'make' }, sessionCtx);
		expect(out.result).not.toContain('Shell tab');
	});

	it('command_output tails the log with a status line', async () => {
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const out = await executeTool('command_output', { id: 'bg-1' }, sessionCtx);
		expect(mocks.invoke).toHaveBeenCalledWith('code_bg_status', { owner: 'sess-1' });
		expect(mocks.invoke).toHaveBeenCalledWith('code_bg_tail', { id: 'bg-1', bytes: 8192 });
		expect(out.result).toContain('Running for');
		expect(out.result).toContain('PID 4242');
		expect(out.result).toContain('listening on :5173');
	});

	it('command_output reports how a finished process ended', async () => {
		mocks.invoke.mockImplementation((cmd: string) => {
			if (cmd === 'code_bg_status')
				return Promise.resolve([{ ...bgProc, running: false, exit_code: 3 }]);
			if (cmd === 'code_bg_tail') return Promise.resolve('');
			return Promise.resolve();
		});
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const out = await executeTool('command_output', { id: 'bg-1' }, sessionCtx);
		expect(out.result).toContain('exit code 3');
		expect(out.result).toContain('(no output yet)');
	});

	it('command_output refuses another session’s process', async () => {
		mocks.invoke.mockImplementation((cmd: string) =>
			cmd === 'code_bg_status' ? Promise.resolve([]) : Promise.resolve()
		);
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const out = await executeTool('command_output', { id: 'bg-9' }, sessionCtx);
		expect(out.result).toContain('No background command with id bg-9');
		expect(mocks.invoke).not.toHaveBeenCalledWith('code_bg_tail', expect.anything());
	});

	it('command_stop stops the process', async () => {
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const out = await executeTool('command_stop', { id: 'bg-1' }, sessionCtx);
		expect(mocks.invoke).toHaveBeenCalledWith('code_bg_stop', { id: 'bg-1' });
		expect(out.result).toContain('Stopped bg-1');
	});

	it('command_stop needs a Code session', async () => {
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const out = await executeTool('command_stop', { id: 'bg-1' }, codeCtx);
		expect(out.result).toContain('Code session');
		expect(mocks.invoke).not.toHaveBeenCalledWith('code_bg_stop', expect.anything());
	});
});
