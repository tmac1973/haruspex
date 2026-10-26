import { describe, expect, it, vi } from 'vitest';

describe('a missing Python runtime', () => {
	it('takes the sandbox tools out of every toolset and refuses a guessed call', async () => {
		vi.resetModules();
		const { noteRuntimeMissing, PYTHON_UNAVAILABLE } = await import('#lib/sandbox/availability.ts');
		await import('#lib/agent/tools/sandbox.ts');
		const { executeTool, getToolSchemas } = await import('#lib/agent/tools/registry.ts');
		const { makeToolContext } = await import('#lib/testing/toolContext.ts');
		const names = () =>
			getToolSchemas({ hasWorkingDir: true, interactive: true }).map((s) => s.function.name);

		expect(names()).toContain('run_python');
		noteRuntimeMissing();
		expect(names()).not.toContain('run_python');
		expect(names()).not.toContain('install_package');
		const out = await executeTool('run_python', { code: '1' }, makeToolContext());
		expect(JSON.parse(out.result).error).toBe(PYTHON_UNAVAILABLE);
	});
});
