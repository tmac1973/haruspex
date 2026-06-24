import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RunCommandResult } from '$lib/ipc/gen/RunCommandResult';

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	askCommandApproval: vi.fn(),
	isSessionApproved: vi.fn(() => false),
	approveSession: vi.fn(),
	registerWatch: vi.fn(() => 'watch-1')
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('$lib/stores/codeCommandApproval.svelte', () => ({
	askCommandApproval: mocks.askCommandApproval,
	isSessionApproved: mocks.isSessionApproved,
	approveSession: mocks.approveSession
}));
vi.mock('$lib/shell/backgroundWatch', () => ({ registerWatch: mocks.registerWatch }));

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
	duration_ms: 5
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
	mocks.invoke.mockImplementation((cmd: string) => {
		if (cmd === 'run_command_capture') return Promise.resolve(runResultDefaults());
		if (cmd === 'code_write_overflow') return Promise.resolve('/tmp/overflow.txt');
		return Promise.resolve();
	});
});

describe('run_command risk gate', () => {
	it('runs a safe command without prompting', async () => {
		const { executeTool } = await import('$lib/agent/tools');
		const out = await executeTool('run_command', { command: 'ls -la' }, codeCtx);
		expect(mocks.askCommandApproval).not.toHaveBeenCalled();
		expect(mocks.invoke).toHaveBeenCalledWith(
			'run_command_capture',
			expect.objectContaining({ command: 'ls -la', cwd: '/work' })
		);
		expect(out.result).toContain('Exit code: 0');
		expect(out.result).toContain('hello');
	});

	it('prompts on a risky command and aborts on deny', async () => {
		mocks.askCommandApproval.mockResolvedValue('deny');
		const { executeTool } = await import('$lib/agent/tools');
		const out = await executeTool('run_command', { command: 'rm -rf /' }, codeCtx);
		expect(mocks.askCommandApproval).toHaveBeenCalled();
		expect(mocks.invoke).not.toHaveBeenCalledWith('run_command_capture', expect.anything());
		expect(out.result).toContain('denied');
	});

	it('runs after allow_once without flipping session approval', async () => {
		mocks.askCommandApproval.mockResolvedValue('allow_once');
		const { executeTool } = await import('$lib/agent/tools');
		await executeTool('run_command', { command: 'sudo reboot' }, codeCtx);
		expect(mocks.invoke).toHaveBeenCalledWith('run_command_capture', expect.anything());
		expect(mocks.approveSession).not.toHaveBeenCalled();
	});

	it('flips session approval on allow_session', async () => {
		mocks.askCommandApproval.mockResolvedValue('allow_session');
		const { executeTool } = await import('$lib/agent/tools');
		await executeTool('run_command', { command: 'sudo reboot' }, codeCtx);
		expect(mocks.approveSession).toHaveBeenCalled();
	});

	it('skips the prompt when codeAutoApprove is on', async () => {
		const { executeTool } = await import('$lib/agent/tools');
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
		const { executeTool } = await import('$lib/agent/tools');
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
		const { executeTool } = await import('$lib/agent/tools');
		const out = await executeTool('run_command', { command: './my-gui' }, codeCtx);
		expect(out.result).toContain('succeeded with no output');
	});

	it('leads with the exit code and reports a killed command', async () => {
		mocks.invoke.mockImplementation((cmd: string) => {
			if (cmd === 'run_command_capture')
				return Promise.resolve(runResultDefaults({ killed: true, exit_code: null }));
			return Promise.resolve();
		});
		const { executeTool } = await import('$lib/agent/tools');
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
		const { executeTool } = await import('$lib/agent/tools');
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
		const { executeTool } = await import('$lib/agent/tools');
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
		const { executeTool } = await import('$lib/agent/tools');
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
		const { executeTool } = await import('$lib/agent/tools');
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
		const { executeTool } = await import('$lib/agent/tools');
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
		const { executeTool } = await import('$lib/agent/tools');
		const out = await executeTool('code_grep', { pattern: 'needle', context: 1 }, codeCtx);
		expect(out.result).toBe('a.rs-1: fn main() {\na.rs:2: needle();\na.rs-3: }');
	});

	it('reports no grep matches', async () => {
		mocks.invoke.mockResolvedValueOnce({ matches: [], truncated: false });
		const { executeTool } = await import('$lib/agent/tools');
		const out = await executeTool('code_grep', { pattern: 'zzz' }, codeCtx);
		expect(out.result).toBe('No matches.');
	});

	it('surfaces the grep overflow note', async () => {
		mocks.invoke.mockResolvedValueOnce({
			matches: [{ path: 'a', line: 1, text: 'x' }],
			truncated: true
		});
		const { executeTool } = await import('$lib/agent/tools');
		const out = await executeTool('code_grep', { pattern: 'x' }, codeCtx);
		expect(out.result).toContain('truncated');
	});

	it('formats glob paths and the empty case', async () => {
		mocks.invoke.mockResolvedValueOnce({ paths: ['src/a.ts', 'src/b.ts'], truncated: false });
		const { executeTool } = await import('$lib/agent/tools');
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
		const { executeTool } = await import('$lib/agent/tools');
		await executeTool('code_grep', { pattern: 'x' }, shellCodeCtx);
		expect(mocks.invoke).toHaveBeenCalledWith(
			'code_grep',
			expect.objectContaining({ root: '/proj', pattern: 'x' })
		);
	});

	it('fs_edit_text dispatches absolute (shell CWD) in Code mode', async () => {
		mocks.invoke.mockResolvedValueOnce({
			first_changed_line: 1,
			line_before: 'a',
			line_after: 'b',
			used_fuzzy: false
		});
		const { executeTool } = await import('$lib/agent/tools');
		await executeTool('fs_edit_text', { path: 'foo.ts', old_str: 'a', new_str: 'b' }, shellCodeCtx);
		expect(mocks.invoke).toHaveBeenCalledWith('fs_edit_text_absolute', {
			path: '/proj/foo.ts',
			oldStr: 'a',
			newStr: 'b'
		});
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
		let ctxCalls = 0;
		mocks.invoke.mockImplementation((cmd: string) => {
			if (cmd === 'shell_platform_supported') return Promise.resolve(true);
			if (cmd === 'shell_get_context') {
				ctxCalls++;
				return Promise.resolve({ completed_total: ctxCalls >= 2 ? 1 : 0, current_cwd: '/proj' });
			}
			if (cmd === 'shell_get_recent_commands')
				return Promise.resolve([
					{ commandLine: 'ls', output: 'a.txt\n', exitCode: 0, cwd: '/proj', truncated: false }
				]);
			return Promise.resolve();
		});
		const { executeTool } = await import('$lib/agent/tools');
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
		const { updateSettings } = await import('$lib/stores/settings');
		updateSettings({ codeCommandExec: 'oneshot' });
		mocks.invoke.mockImplementation((cmd: string) => {
			if (cmd === 'run_command_capture') return Promise.resolve(runResultDefaults());
			return Promise.resolve();
		});
		const { executeTool } = await import('$lib/agent/tools');
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
			if (cmd === 'shell_get_recent_commands')
				return Promise.resolve([
					{
						commandLine: 'go run main.go',
						output: '',
						exitCode: null,
						cwd: '/proj',
						truncated: false,
						pending: true
					}
				]);
			return Promise.resolve();
		});
		const { executeTool } = await import('$lib/agent/tools');
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
		const { executeTool } = await import('$lib/agent/tools');
		await executeTool('run_command', { command: 'ls' }, ptyCtx);
		expect(mocks.invoke).toHaveBeenCalledWith('run_command_capture', expect.anything());
	});

	it('sends Ctrl-C to the PTY on abort', async () => {
		const controller = new AbortController();
		mocks.invoke.mockImplementation((cmd: string) => {
			if (cmd === 'shell_platform_supported') return Promise.resolve(true);
			if (cmd === 'shell_get_context')
				return Promise.resolve({ completed_total: 0, current_cwd: '/proj' });
			// Idle terminal (no pending command) so the busy-guard lets us inject.
			if (cmd === 'shell_get_recent_commands') return Promise.resolve([]);
			return Promise.resolve();
		});
		const { executeTool } = await import('$lib/agent/tools');
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
	function mockBackgroundPty() {
		let ctxCalls = 0;
		mocks.invoke.mockImplementation((cmd: string) => {
			if (cmd === 'shell_platform_supported') return Promise.resolve(true);
			if (cmd === 'shell_get_context') {
				ctxCalls++;
				return Promise.resolve({ completed_total: ctxCalls >= 2 ? 1 : 0, current_cwd: '/proj' });
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
		const { executeTool } = await import('$lib/agent/tools');
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
		const { executeTool } = await import('$lib/agent/tools');
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

	it('rejects background without a live terminal session', async () => {
		const { executeTool } = await import('$lib/agent/tools');
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

	it('codeMode exposes exactly the CODE_TOOLS allowlist', async () => {
		const { getToolSchemas } = await import('$lib/agent/tools');
		const names = getToolSchemas({ hasWorkingDir: true, codeMode: true })
			.map((s) => s.function.name)
			.sort();
		expect(names).toEqual(CODE_TOOLS);
	});

	it('codeMode wins over shellMode and exposes the code toolset plus interactive PTY tools', async () => {
		const { getToolSchemas } = await import('$lib/agent/tools');
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
		const { getToolSchemas } = await import('$lib/agent/tools');
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
