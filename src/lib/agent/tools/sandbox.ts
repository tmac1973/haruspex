import { runPython, installPackage, resetSandbox, type ToolResult } from '$lib/sandbox/sandbox';
import { registerTool } from './registry';
import { toolResult, toolError } from './types';

function formatResult(r: ToolResult): string {
	const lines: string[] = [];
	if (r.error) {
		lines.push(`Error: ${r.error}`);
		if (r.stderr.trim()) lines.push(`Stderr:\n${r.stderr.trim()}`);
		if (r.stdout.trim()) lines.push(`Stdout:\n${r.stdout.trim()}`);
		lines.push(`(took ${r.duration_ms}ms)`);
		return lines.join('\n\n');
	}
	if (r.stdout.trim()) lines.push(`Stdout:\n${r.stdout.trim()}`);
	if (r.stderr.trim()) lines.push(`Stderr:\n${r.stderr.trim()}`);
	if (r.result) lines.push(`Result: ${r.result}`);
	if (r.artifacts > 0) {
		lines.push(`(${r.artifacts} artifact${r.artifacts === 1 ? '' : 's'} rendered in UI)`);
	}
	if (r.notes.length > 0) lines.push(`Notes: ${r.notes.join('; ')}`);
	if (lines.length === 0) lines.push('(no output)');
	lines.push(`(took ${r.duration_ms}ms)`);
	return lines.join('\n\n');
}

function firstLine(code: string, max = 60): string {
	const line = code.split('\n')[0]?.trim() ?? '';
	return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

registerTool({
	category: 'sandbox',
	schema: {
		type: 'function',
		function: {
			name: 'run_python',
			description:
				"Execute Python code in a persistent sandbox running in this app. Variables, imports, and installed packages persist across calls within the current chat. Use this for math, data analysis, parsing, plotting, or any computation that benefits from real code execution. Top-level await is supported. The final expression value is returned alongside any captured stdout/stderr. Common pre-installable packages (numpy, pandas, matplotlib, scipy, scikit-learn, sympy, pillow) need install_package first. To save large outputs (PNG plots, full DataFrame HTML, generated images) to the user's working directory, use 'await haruspex.save(filename, content)' inside your code — content can be str or bytes; the bytes never round-trip through your context.",
			parameters: {
				type: 'object',
				properties: {
					code: {
						type: 'string',
						description: 'Python source to execute. Multiple statements are fine.'
					}
				},
				required: ['code']
			}
		}
	},
	displayLabel: (args) => firstLine((args.code as string) || ''),
	async execute(args) {
		const code = args.code;
		if (typeof code !== 'string' || !code.trim()) {
			return toolResult(toolError('Missing or empty `code` argument'));
		}
		try {
			const r = await runPython(code);
			return { result: formatResult(r), artifacts: r.artifactsList };
		} catch (e) {
			return toolResult(toolError(`Sandbox error: ${e instanceof Error ? e.message : String(e)}`));
		}
	}
});

registerTool({
	category: 'sandbox',
	schema: {
		type: 'function',
		function: {
			name: 'reset_python',
			description:
				'Wipe the Python sandbox: clears all variables, imports, and installed packages for the current chat. Use after a poisoned state (hung import, bad monkey-patch, irrecoverable error). Does not affect chat history.',
			parameters: { type: 'object', properties: {} }
		}
	},
	displayLabel: () => 'reset',
	async execute() {
		try {
			await resetSandbox();
			return toolResult('Python sandbox reset.');
		} catch (e) {
			return toolResult(toolError(`Reset failed: ${e instanceof Error ? e.message : String(e)}`));
		}
	}
});

registerTool({
	category: 'sandbox',
	schema: {
		type: 'function',
		function: {
			name: 'install_package',
			description:
				'Install a Python package into the sandbox via micropip. Pre-built Pyodide packages (numpy, pandas, matplotlib, scipy, scikit-learn, sympy, pillow, beautifulsoup4) work out of the box. Pure-Python wheels from PyPI also work; packages with C extensions that have not been pre-built for Pyodide will fail. Installs persist for the current chat session.',
			parameters: {
				type: 'object',
				properties: {
					package: {
						type: 'string',
						description: "Package name, optionally with a version: 'pandas' or 'pandas==2.1.0'."
					}
				},
				required: ['package']
			}
		}
	},
	displayLabel: (args) => `install ${args.package as string}`,
	async execute(args) {
		const pkg = args.package;
		if (typeof pkg !== 'string' || !pkg.trim()) {
			return toolResult(toolError('Missing or empty `package` argument'));
		}
		try {
			const r = await installPackage(pkg);
			return toolResult(formatResult(r));
		} catch (e) {
			return toolResult(toolError(`Install failed: ${e instanceof Error ? e.message : String(e)}`));
		}
	}
});
