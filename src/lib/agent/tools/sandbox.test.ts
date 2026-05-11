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

	it('exposes sandbox tool schemas via getToolSchemas regardless of working dir', async () => {
		const { getToolSchemas } = await import('$lib/agent/tools');
		const schemas = getToolSchemas({ hasWorkingDir: false });
		const names = schemas.map((s) => s.function.name);
		expect(names).toContain('run_python');
		expect(names).toContain('reset_python');
		expect(names).toContain('install_package');
	});
});
