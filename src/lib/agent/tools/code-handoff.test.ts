import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	askCommandApproval: vi.fn()
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('#lib/stores/codeCommandApproval.svelte.ts', () => ({
	askCommandApproval: mocks.askCommandApproval,
	isSessionApproved: () => false,
	approveSession: vi.fn(),
	codeApprovalKey: (id: string) => `code:${id}`,
	SHELL_APPROVAL_KEY: 'shell'
}));

import { executeTool } from '#lib/agent/tools/index.ts';
import {
	registerShellCommandOpener,
	setShellWaitListener,
	type ShellCommandRequest,
	type ShellCommandResult,
	type ShellWait
} from '#lib/code/shellBridge.ts';
import { getPendingEdit } from '#lib/stores/fileEditor.svelte.ts';
import { _resetBoundary } from '#lib/shell/boundary.ts';
import { resetShellPlatformSupported } from '#lib/shell/platformSupport.ts';

const ctx = {
	workingDir: '/proj',
	codeSessionId: 's1',
	pendingImages: [],
	deepResearch: false,
	shellMode: false,
	codeMode: true,
	codeAutoApprove: false,
	interactive: true,
	filesWrittenThisTurn: new Set<string>()
};

let unregister: () => void = () => {};

beforeEach(() => {
	mocks.invoke.mockReset();
	mocks.askCommandApproval.mockReset();
	mocks.invoke.mockImplementation(async (cmd: string) => {
		if (cmd === 'shell_platform_supported') return true;
		if (cmd === 'app_protected_targets') {
			return {
				home: '/home/u',
				paths: [{ path: '/home/u/.local/share/haruspex', label: 'data directory' }],
				ports: []
			};
		}
		if (cmd === 'code_write_overflow') return '/tmp/overflow.txt';
		return null;
	});
	_resetBoundary();
	resetShellPlatformSupported();
});

afterEach(() => {
	unregister();
	getPendingEdit()?.finish({ saved: [] });
});

/** A fake shell side that answers with `result`, after calling onOpened. */
function fakeShell(result: (req: ShellCommandRequest) => Promise<ShellCommandResult>) {
	const calls: ShellCommandRequest[] = [];
	unregister = registerShellCommandOpener(async (req) => {
		calls.push(req);
		req.onOpened?.({ name: 'Shell 2', focus: () => {} });
		return result(req);
	});
	return calls;
}

describe('open_in_shell', () => {
	it('opens at the session folder, waits, and returns the result', async () => {
		const calls = fakeShell(async () => ({
			kind: 'completed',
			shellName: 'Shell 2',
			command: 'sudo dnf install foo',
			exitCode: 0,
			output: 'Complete!\n',
			cwd: '/proj',
			durationMs: 4200
		}));
		const out = await executeTool('open_in_shell', { command: 'sudo dnf install foo' }, ctx);
		expect(calls[0]).toMatchObject({ command: 'sudo dnf install foo', cwd: '/proj', wait: true });
		expect(out.result).toContain('Exit code: 0 (4200ms), run by the user in Shell 2');
		expect(out.result).toContain('Complete!');
		expect(out.result).not.toContain('changed the command');
		// No risk prompt for sudo: the user's Enter is the approval.
		expect(mocks.askCommandApproval).not.toHaveBeenCalled();
	});

	it('reports the command that ran when the user changed it', async () => {
		fakeShell(async () => ({
			kind: 'completed',
			shellName: 'Shell 2',
			command: 'sudo dnf install -y foo',
			exitCode: 1,
			output: '',
			cwd: null,
			durationMs: 10
		}));
		const out = await executeTool('open_in_shell', { command: 'sudo dnf install foo' }, ctx);
		expect(out.result).toContain('What ran: sudo dnf install -y foo');
	});

	it('tells the model to ask when the shell gives no result', async () => {
		fakeShell(async () => ({ kind: 'opened', shellName: 'Shell 2', integration: false }));
		const out = await executeTool('open_in_shell', { command: 'ls' }, ctx);
		expect(out.result).toContain('Opened in Shell 2');
		expect(out.result).toContain('ask the user for the result');
	});

	it('reports a closed tab', async () => {
		fakeShell(async () => ({ kind: 'closed', shellName: 'Shell 2' }));
		const out = await executeTool('open_in_shell', { command: 'ls' }, ctx);
		expect(out.result).toContain('Shell 2 was closed');
	});

	it('shows the wait on the session, and Cancel ends only the wait', async () => {
		const waits: (ShellWait | null)[] = [];
		const unlisten = setShellWaitListener('s1', (w) => waits.push(w));
		fakeShell(
			(req) =>
				new Promise((resolve) => {
					req.signal!.addEventListener('abort', () =>
						resolve({ kind: 'aborted', shellName: 'Shell 2' })
					);
				})
		);
		const pending = executeTool('open_in_shell', { command: 'ls' }, ctx);
		await vi.waitFor(() => expect(waits[0]).toBeTruthy());
		expect(waits[0]).toMatchObject({ shellName: 'Shell 2', command: 'ls' });
		waits[0]!.cancel();
		const out = await pending;
		unlisten();
		expect(out.result).toContain('The user stopped waiting for Shell 2');
		expect(waits[waits.length - 1]).toBeNull();
	});

	it('stops waiting when the turn is stopped', async () => {
		const abort = new AbortController();
		const calls = fakeShell(
			(req) =>
				new Promise((resolve) => {
					req.signal!.addEventListener('abort', () =>
						resolve({ kind: 'aborted', shellName: 'Shell 2' })
					);
				})
		);
		const pending = executeTool(
			'open_in_shell',
			{ command: 'ls' },
			{ ...ctx, signal: abort.signal }
		);
		await vi.waitFor(() => expect(calls).toHaveLength(1));
		abort.abort();
		const out = await pending;
		expect(out.result).toBe('Stopped waiting for Shell 2.');
	});

	it('still checks the boundary', async () => {
		const calls = fakeShell(async () => ({ kind: 'closed', shellName: 'Shell 2' }));
		mocks.askCommandApproval.mockResolvedValue('deny');
		const out = await executeTool(
			'open_in_shell',
			{ command: 'sqlite3 ~/.local/share/haruspex/haruspex.db' },
			ctx
		);
		expect(mocks.askCommandApproval).toHaveBeenCalled();
		expect(out.result).toContain('denied');
		expect(calls).toHaveLength(0);
	});

	it('refuses where the Shell tab does not work', async () => {
		const calls = fakeShell(async () => ({ kind: 'closed', shellName: 'Shell 2' }));
		mocks.invoke.mockImplementation(async (cmd: string) =>
			cmd === 'shell_platform_supported' ? false : null
		);
		const out = await executeTool('open_in_shell', { command: 'ls' }, ctx);
		expect(out.result).toContain('not available');
		expect(calls).toHaveLength(0);
	});
});

describe('open_in_editor', () => {
	it('opens files inside the folder and returns without waiting', async () => {
		const out = await executeTool(
			'open_in_editor',
			{ paths: ['src/a.ts', '/proj/README.md'], reason: 'The new parser' },
			ctx
		);
		expect(out.result).toContain('Opened 2 files');
		// The editor is still open: the tool did not wait for it.
		expect(getPendingEdit()).toMatchObject({
			workdir: '/proj',
			files: ['src/a.ts', 'README.md'],
			title: 'The new parser'
		});
	});

	it('refuses paths outside the folder', async () => {
		const out = await executeTool('open_in_editor', { paths: ['src/a.ts', '/etc/passwd'] }, ctx);
		expect(out.result).toContain('/etc/passwd');
		expect(out.result).toContain('error');
		expect(getPendingEdit()).toBeNull();
		const up = await executeTool('open_in_editor', { paths: ['../other/x.ts'] }, ctx);
		expect(up.result).toContain('error');
	});

	it('says so when the editor is already open', async () => {
		await executeTool('open_in_editor', { paths: ['a.ts'] }, ctx);
		const out = await executeTool('open_in_editor', { paths: ['b.ts'] }, ctx);
		expect(out.result).toContain('already open');
	});
});
