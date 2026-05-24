import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolResult } from '$lib/sandbox/sandbox';

const mocks = vi.hoisted(() => ({
	runPython: vi.fn(),
	installPackage: vi.fn(),
	resetSandbox: vi.fn(),
	askApproval: vi.fn().mockResolvedValue('allow_chat' as const)
}));

vi.mock('$lib/sandbox/sandbox', () => ({
	runPython: mocks.runPython,
	installPackage: mocks.installPackage,
	resetSandbox: mocks.resetSandbox
}));

vi.mock('$lib/stores/sandboxApproval.svelte', () => ({
	askApproval: mocks.askApproval
}));

const ctx = {
	workingDir: null,
	pendingImages: [],
	deepResearch: false,
	filesWrittenThisTurn: new Set<string>()
};

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
	});

	it('routes run_python to runPython and formats stdout + result', async () => {
		mocks.runPython.mockResolvedValue(ok({ stdout: 'hello\n', result: '4' }));
		const { executeTool } = await import('$lib/agent/tools');
		const out = await executeTool('run_python', { code: 'print("hello"); 2+2' }, ctx);
		expect(mocks.runPython).toHaveBeenCalledWith(
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
		const { executeTool } = await import('$lib/agent/tools');
		const out = await executeTool('run_python', { code: 'print(x)' }, ctx);
		expect(out.result).toContain('Error:');
		expect(out.result).toContain('NameError');
		expect(out.result).toContain('Stderr:');
	});

	it('rejects empty code with a structured error', async () => {
		const { executeTool } = await import('$lib/agent/tools');
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
		const { executeTool } = await import('$lib/agent/tools');
		const out = await executeTool('run_python', { code: 'df' }, ctx);
		expect(out.result).toContain('2 artifacts');
		expect(out.result).toContain('DataFrame truncated');
	});

	it('routes reset_python to resetSandbox', async () => {
		mocks.resetSandbox.mockResolvedValue(undefined);
		const { executeTool } = await import('$lib/agent/tools');
		const out = await executeTool('reset_python', {}, ctx);
		expect(mocks.resetSandbox).toHaveBeenCalled();
		expect(out.result).toMatch(/reset/i);
	});

	it('routes install_package to installPackage', async () => {
		mocks.installPackage.mockResolvedValue(ok({ result: 'installed numpy' }));
		const { executeTool } = await import('$lib/agent/tools');
		const out = await executeTool('install_package', { package: 'numpy' }, ctx);
		expect(mocks.installPackage).toHaveBeenCalledWith(
			'numpy',
			expect.objectContaining({ timeoutMs: expect.any(Number) })
		);
		expect(out.result).toContain('installed numpy');
	});

	it('rejects empty package name', async () => {
		const { executeTool } = await import('$lib/agent/tools');
		const out = await executeTool('install_package', { package: '' }, ctx);
		expect(JSON.parse(out.result)).toHaveProperty('error');
		expect(mocks.installPackage).not.toHaveBeenCalled();
	});

	it('returns "User denied code execution" and skips runPython on deny', async () => {
		mocks.askApproval.mockResolvedValueOnce('deny');
		const { executeTool } = await import('$lib/agent/tools');
		const out = await executeTool('run_python', { code: '1+1' }, ctx);
		expect(JSON.parse(out.result)).toEqual({ error: 'User denied code execution.' });
		expect(mocks.runPython).not.toHaveBeenCalled();
	});

	it('skips the approval prompt and runs Python when auto-approve is active', async () => {
		mocks.runPython.mockResolvedValue(ok({ result: 'job ok' }));
		const { runWithAutoApprove } = await import('$lib/stores/approvalOverride');
		const { executeTool } = await import('$lib/agent/tools');
		const { updateSettings } = await import('$lib/stores/settings');
		// Force the every-run mode so we'd normally prompt every time.
		updateSettings({ sandboxApproval: 'every-run' });
		try {
			const out = await runWithAutoApprove(() =>
				executeTool('run_python', { code: 'print("hi")' }, ctx)
			);
			expect(mocks.askApproval).not.toHaveBeenCalled();
			expect(mocks.runPython).toHaveBeenCalled();
			expect(out.result).toContain('job ok');
		} finally {
			updateSettings({ sandboxApproval: 'once-per-chat' });
		}
	});

	it('exposes sandbox tool schemas via getToolSchemas regardless of working dir', async () => {
		const { getToolSchemas } = await import('$lib/agent/tools');
		const { updateSettings } = await import('$lib/stores/settings');
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

	it('exposes fs_write_pdf / fs_write_pptx alongside run_python when the sandbox is enabled', async () => {
		// Previously these were hidden to force the model through fpdf2 /
		// python-pptx, but Qwen 3.5 9B repeatedly failed at that path
		// (wrong fpdf API, latin-1 encoding errors, install thrash). The
		// dedicated writers produce much better output and should always
		// be the model's first choice for documents.
		const { getToolSchemas } = await import('$lib/agent/tools');
		const { updateSettings } = await import('$lib/stores/settings');
		updateSettings({ sandboxEnabled: true });
		try {
			const schemas = getToolSchemas({ hasWorkingDir: true });
			const names = schemas.map((s) => s.function.name);
			expect(names).toContain('fs_write_pdf');
			expect(names).toContain('fs_write_pptx');
			expect(names).toContain('fs_write_docx');
			expect(names).toContain('fs_write_xlsx');
			expect(names).toContain('run_python');
		} finally {
			updateSettings({ sandboxEnabled: false });
		}
	});

	it('exposes fs_write_pdf / fs_write_pptx when the Python sandbox is disabled', async () => {
		const { getToolSchemas } = await import('$lib/agent/tools');
		const { updateSettings } = await import('$lib/stores/settings');
		updateSettings({ sandboxEnabled: false });
		const schemas = getToolSchemas({ hasWorkingDir: true });
		const names = schemas.map((s) => s.function.name);
		expect(names).toContain('fs_write_pdf');
		expect(names).toContain('fs_write_pptx');
		// run_python is itself sandbox-gated, so it should NOT appear here.
		expect(names).not.toContain('run_python');
	});
});
