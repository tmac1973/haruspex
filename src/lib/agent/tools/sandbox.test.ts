import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ToolResult } from '#lib/sandbox/sandbox.ts';
import { updateSettings } from '#lib/stores/settings.ts';
import { makeToolContext } from '#lib/testing/toolContext.ts';
import { setActiveConversationId } from '#lib/stores/session.svelte.ts';

const mocks = vi.hoisted(() => ({
	runPython: vi.fn(),
	installPackage: vi.fn(),
	resetSandbox: vi.fn(),
	askApproval: vi.fn().mockResolvedValue('allow_chat' as const)
}));

vi.mock('#lib/sandbox/sandbox.ts', () => ({
	runPython: mocks.runPython,
	installPackage: mocks.installPackage,
	resetSandbox: mocks.resetSandbox,
	jobSandboxId: (runId: number) => `job:${runId}`
}));

vi.mock('#lib/stores/sandboxApproval.svelte.ts', () => ({
	askApproval: mocks.askApproval,
	// No chat is approved by default, so once-per-chat mode prompts.
	isChatSandboxApproved: () => false,
	approveChatSandbox: vi.fn()
}));

const ctx = makeToolContext({ conversationId: 'c1' });

function ok(overrides: Partial<ToolResult> = {}): ToolResult {
	return {
		stdout: '',
		stderr: '',
		result: '',
		error: null,
		artifacts: 0,
		artifactsList: [],
		notes: [],
		duration_ms: 5,
		...overrides
	};
}

describe('sandbox tools', () => {
	beforeEach(() => {
		mocks.runPython.mockReset();
		mocks.installPackage.mockReset();
		mocks.resetSandbox.mockReset();
		mocks.askApproval.mockReset();
		mocks.askApproval.mockResolvedValue('allow_chat');
		// executeTool hard-gates sandbox tools on this switch (see registry.ts),
		// so the execution/formatting cases below need it on. The schema-filter
		// cases at the bottom toggle it themselves.
		updateSettings({ sandboxEnabled: true });
	});

	afterEach(() => {
		updateSettings({ sandboxEnabled: false });
	});

	it('refuses run_python and skips runPython when the sandbox is disabled', async () => {
		updateSettings({ sandboxEnabled: false });
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const out = await executeTool('run_python', { code: '1+1' }, ctx);
		expect(JSON.parse(out.result).error).toMatch(/sandbox is disabled/i);
		expect(mocks.runPython).not.toHaveBeenCalled();
	});

	it('routes run_python to runPython and formats stdout + result', async () => {
		mocks.runPython.mockResolvedValue(ok({ stdout: 'hello\n', result: '4' }));
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const out = await executeTool('run_python', { code: 'print("hello"); 2+2' }, ctx);
		expect(mocks.runPython).toHaveBeenCalledWith(
			'c1',
			'print("hello"); 2+2',
			expect.objectContaining({ timeoutMs: expect.any(Number) })
		);
		expect(out.result).toContain('Stdout:');
		expect(out.result).toContain('hello');
		expect(out.result).toContain('Result: 4');
		expect(out.result).toContain('took 5ms');
	});

	it('formats Python errors with traceback in stderr', async () => {
		mocks.runPython.mockResolvedValue(
			ok({ error: 'NameError: name "x" is not defined', stderr: 'Traceback...' })
		);
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const out = await executeTool('run_python', { code: 'print(x)' }, ctx);
		expect(out.result).toContain('Error:');
		expect(out.result).toContain('NameError');
		expect(out.result).toContain('Stderr:');
	});

	it('rejects empty code with a structured error', async () => {
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const out = await executeTool('run_python', { code: '   ' }, ctx);
		expect(JSON.parse(out.result)).toHaveProperty('error');
		expect(mocks.runPython).not.toHaveBeenCalled();
	});

	it('reports artifact count and notes when present', async () => {
		mocks.runPython.mockResolvedValue(
			ok({
				artifacts: 2,
				notes: ['DataFrame truncated to 200 of 5000 rows']
			})
		);
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const out = await executeTool('run_python', { code: 'df' }, ctx);
		expect(out.result).toContain('2 figures/artifacts');
		expect(out.result).toContain('do NOT embed');
		expect(out.result).toContain('DataFrame truncated');
	});

	it('routes reset_python to resetSandbox', async () => {
		mocks.resetSandbox.mockResolvedValue(undefined);
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const out = await executeTool('reset_python', {}, ctx);
		expect(mocks.resetSandbox).toHaveBeenCalled();
		expect(out.result).toMatch(/reset/i);
	});

	it('routes install_package to installPackage', async () => {
		mocks.installPackage.mockResolvedValue(ok({ result: 'installed numpy' }));
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const out = await executeTool('install_package', { package: 'numpy' }, ctx);
		expect(mocks.installPackage).toHaveBeenCalledWith(
			'c1',
			'numpy',
			expect.objectContaining({ timeoutMs: expect.any(Number) })
		);
		expect(out.result).toContain('installed numpy');
	});

	it('rejects empty package name', async () => {
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const out = await executeTool('install_package', { package: '' }, ctx);
		expect(JSON.parse(out.result)).toHaveProperty('error');
		expect(mocks.installPackage).not.toHaveBeenCalled();
	});

	it('returns "User denied code execution" and skips runPython on deny', async () => {
		mocks.askApproval.mockResolvedValueOnce('deny');
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const out = await executeTool('run_python', { code: '1+1' }, ctx);
		expect(JSON.parse(out.result)).toEqual({ error: 'User denied code execution.' });
		expect(mocks.runPython).not.toHaveBeenCalled();
	});

	it("still asks in a chat while a job's auto-approve scope is active", async () => {
		// A job running beside the chat must not approve the chat's Python.
		mocks.runPython.mockResolvedValue(ok({ result: 'chat ok' }));
		const { runWithAutoApprove } = await import('#lib/stores/approvalOverride.ts');
		const { executeTool } = await import('#lib/agent/tools/index.ts');
		const { updateSettings } = await import('#lib/stores/settings.ts');
		updateSettings({ sandboxApproval: 'every-run' });
		try {
			const out = await runWithAutoApprove(() =>
				executeTool('run_python', { code: 'print("hi")' }, ctx)
			);
			expect(mocks.askApproval).toHaveBeenCalled();
			expect(out.result).toContain('chat ok');
		} finally {
			updateSettings({ sandboxApproval: 'once-per-chat' });
		}
	});

	describe('which sandbox a call uses', () => {
		const jobCtx = makeToolContext({ jobRunId: 7 });

		afterEach(() => {
			setActiveConversationId(null);
			updateSettings({ sandboxApproval: 'once-per-chat' });
		});

		it("runs a job turn's Python in the run's own sandbox, not the open chat's", async () => {
			setActiveConversationId('open-chat');
			mocks.runPython.mockResolvedValue(ok({ result: 'job ok' }));
			const { executeTool } = await import('#lib/agent/tools/index.ts');
			const out = await executeTool('run_python', { code: '1+1' }, jobCtx);
			expect(mocks.runPython).toHaveBeenCalledWith('job:7', '1+1', expect.anything());
			expect(out.result).toContain('job ok');
		});

		it('runs a job turn with no chat open, without asking', async () => {
			setActiveConversationId(null);
			// Every-run would prompt a chat each time; writing the job approved it.
			updateSettings({ sandboxApproval: 'every-run' });
			mocks.runPython.mockResolvedValue(ok());
			mocks.installPackage.mockResolvedValue(ok());
			mocks.resetSandbox.mockResolvedValue(undefined);
			const { executeTool } = await import('#lib/agent/tools/index.ts');
			await executeTool('run_python', { code: '1+1' }, jobCtx);
			await executeTool('install_package', { package: 'numpy' }, jobCtx);
			await executeTool('reset_python', {}, jobCtx);
			expect(mocks.askApproval).not.toHaveBeenCalled();
			expect(mocks.runPython).toHaveBeenCalledWith('job:7', '1+1', expect.anything());
			expect(mocks.installPackage).toHaveBeenCalledWith('job:7', 'numpy', expect.anything());
			expect(mocks.resetSandbox).toHaveBeenCalledWith('job:7');
		});

		it('runs a chat turn in its own chat, whichever chat is open, and still asks', async () => {
			setActiveConversationId('open-chat');
			mocks.runPython.mockResolvedValue(ok());
			const { executeTool } = await import('#lib/agent/tools/index.ts');
			await executeTool('run_python', { code: '1+1' }, ctx);
			expect(mocks.askApproval).toHaveBeenCalledWith(
				expect.objectContaining({ chatId: 'c1' }),
				undefined
			);
			expect(mocks.runPython).toHaveBeenCalledWith('c1', '1+1', expect.anything());
		});

		it('refuses a turn that is neither a chat nor a job rather than borrow the open chat', async () => {
			setActiveConversationId('open-chat');
			const { executeTool } = await import('#lib/agent/tools/index.ts');
			const out = await executeTool('run_python', { code: '1+1' }, makeToolContext());
			expect(JSON.parse(out.result).error).toMatch(/only in a chat or a job/);
			expect(mocks.runPython).not.toHaveBeenCalled();
		});
	});

	it('exposes sandbox tool schemas via getToolSchemas regardless of working dir', async () => {
		const { getToolSchemas } = await import('#lib/agent/tools/index.ts');
		const { updateSettings } = await import('#lib/stores/settings.ts');
		updateSettings({ sandboxEnabled: true });
		try {
			const schemas = getToolSchemas({ hasWorkingDir: false });
			const names = schemas.map((s) => s.function.name);
			expect(names).toContain('run_python');
			expect(names).toContain('reset_python');
			expect(names).toContain('install_package');
		} finally {
			updateSettings({ sandboxEnabled: false });
		}
	});

	it('exposes the document writers alongside run_python when the sandbox is enabled', async () => {
		// Previously these were hidden to force the model through fpdf2 /
		// python-pptx, but Qwen 3.5 9B repeatedly failed at that path
		// (wrong fpdf API, latin-1 encoding errors, install thrash). The
		// dedicated writers produce much better output and should always
		// be the model's first choice for documents.
		const { getToolSchemas } = await import('#lib/agent/tools/index.ts');
		const { updateSettings } = await import('#lib/stores/settings.ts');
		updateSettings({ sandboxEnabled: true });
		try {
			const schemas = getToolSchemas({ hasWorkingDir: true });
			const names = schemas.map((s) => s.function.name);
			expect(names).toContain('fs_write_document');
			expect(names).toContain('fs_write_slides');
			expect(names).toContain('fs_write_spreadsheet');
			expect(names).toContain('run_python');
		} finally {
			updateSettings({ sandboxEnabled: false });
		}
	});

	it('exposes the document writers when the Python sandbox is disabled', async () => {
		const { getToolSchemas } = await import('#lib/agent/tools/index.ts');
		const { updateSettings } = await import('#lib/stores/settings.ts');
		updateSettings({ sandboxEnabled: false });
		const schemas = getToolSchemas({ hasWorkingDir: true });
		const names = schemas.map((s) => s.function.name);
		expect(names).toContain('fs_write_document');
		expect(names).toContain('fs_write_slides');
		// run_python is itself sandbox-gated, so it should NOT appear here.
		expect(names).not.toContain('run_python');
	});
});
