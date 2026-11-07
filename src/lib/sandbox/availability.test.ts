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

describe('probePythonRuntime', () => {
	const answer = (status: number, type = 'text/javascript') =>
		vi.fn(async () => new Response(null, { status, headers: { 'content-type': type } }));

	it('takes the tools away before any call when the runtime file is missing', async () => {
		vi.resetModules();
		const { probePythonRuntime, pythonRuntimeMissing } =
			await import('#lib/sandbox/availability.ts');
		const fetchFn = answer(404);
		await probePythonRuntime(fetchFn as never, 'tauri://localhost');
		expect(fetchFn).toHaveBeenCalledWith('tauri://localhost/pyodide/pyodide.asm.mjs', {
			method: 'HEAD'
		});
		expect(pythonRuntimeMissing()).toBe(true);
	});

	it("counts the SPA's index.html as missing, and keeps the tools when the file is there", async () => {
		const { runtimeFileMissing } = await import('#lib/sandbox/availability.ts');
		expect(await runtimeFileMissing(answer(200, 'text/html') as never, 'x/')).toBe(true);
		expect(await runtimeFileMissing(answer(200) as never, 'x/')).toBe(false);
		const offline = vi.fn(async () => {
			throw new Error('offline');
		});
		expect(await runtimeFileMissing(offline as never, 'x/')).toBe(false);
	});
});
