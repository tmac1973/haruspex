import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RunCommandResult } from '$lib/ipc/gen/RunCommandResult';

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	askCommandApproval: vi.fn(),
	isSessionApproved: vi.fn(() => false),
	approveSession: vi.fn()
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('$lib/stores/codeCommandApproval.svelte', () => ({
	askCommandApproval: mocks.askCommandApproval,
	isSessionApproved: mocks.isSessionApproved,
	approveSession: mocks.approveSession
}));

const codeCtx = {
	workingDir: '/work',
	pendingImages: [],
	deepResearch: false,
	shellMode: false,
	shellAllowWrite: false,
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
		// Abort while the command is "running".
		controller.abort();
		expect(mocks.invoke).toHaveBeenCalledWith('run_command_cancel', expect.anything());
		resolveRun(runResultDefaults({ killed: true, exit_code: null }));
		await p;
	});
});

describe('code_grep / code_glob formatting', () => {
	it('formats grep matches as file:line: text', async () => {
		mocks.invoke.mockResolvedValueOnce({
			matches: [{ path: 'src/a.rs', line: 12, text: 'fn needle()' }],
			truncated: false
		});
		const { executeTool } = await import('$lib/agent/tools');
		const out = await executeTool('code_grep', { pattern: 'needle' }, codeCtx);
		expect(out.result).toBe('src/a.rs:12: fn needle()');
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
