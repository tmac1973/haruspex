import { runPython, installPackage, resetSandbox, type ToolResult } from '$lib/sandbox/sandbox';
import { lintSandboxCode, formatLintFailure } from '$lib/sandbox/lint';
import { registerTool } from './registry';
import { toolResult, toolError } from './types';
import { getSettings } from '$lib/stores/settings';
import { getActiveConversation } from '$lib/stores/chat.svelte';
import { askApproval } from '$lib/stores/sandboxApproval.svelte';
import { isAutoApproveActive } from '$lib/stores/approvalOverride';
import { errMessage } from '$lib/utils/error';

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
				'Execute Python code in a persistent sandbox. Variables, imports, and installed packages persist across calls within the current chat. Top-level await is supported. The final expression value is returned alongside captured stdout/stderr. ' +
				'PACKAGE INSTALLS ARE AUTOMATIC — just import what you need; missing PyPI / Pyodide packages are installed transparently on first import. You do NOT need to call install_package first for normal usage. ' +
				'OUTPUT: ' +
				'(1) Text — stdout + final-expression repr. ' +
				'(2) Inline images — matplotlib `plt.show()` emits the figure as a PNG in chat. ' +
				'(3) Inline interactive plots — plotly / bokeh / altair / folium figures returned as the LAST EXPRESSION render in the chat message as an interactive HTML iframe (hover, pan, zoom). Example: `import plotly.express as px; fig = px.scatter(...); fig` — just leave `fig` as the last line; the runtime auto-detects script-bearing HTML and renders it interactively. Do NOT save the HTML to disk and do NOT call any helper to render — return the figure as the last expression. ' +
				'(4) Inline DataFrames — a pandas DataFrame as the last expression renders as an HTML table. ' +
				'Your CODE must complete within the timeout (default 30s); there is no background-task pattern. Package installs do NOT count against that timeout — a first-time import that has to download is budgeted separately, so you can just import freely. Bundled offline (no install needed, no network): matplotlib, numpy, pandas, scipy, scikit-learn, sympy, pillow, beautifulsoup4, lxml, requests, plotly, plus fpdf2, python-pptx, xlsxwriter, bokeh, altair. Other PyPI packages are auto-installed on first import (one-time download, then cached).',
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
	async execute(args, ctx) {
		const code = args.code;
		if (typeof code !== 'string' || !code.trim()) {
			return toolResult(toolError('Missing or empty `code` argument'));
		}
		const mode = getSettings().sandboxApproval;
		const conv = getActiveConversation();
		// 'off' bypasses; 'once-per-chat' bypasses if the user has already
		// approved this chat. 'every-run' always prompts.
		const needsPrompt =
			!isAutoApproveActive() &&
			(mode === 'every-run' || (mode === 'once-per-chat' && !conv?.sandboxApproved));
		if (needsPrompt) {
			try {
				const choice = await askApproval({ code, mode });
				if (choice === 'deny') {
					return toolResult(toolError('User denied code execution.'));
				}
				if (choice === 'allow_chat' && conv) {
					conv.sandboxApproved = true;
				}
			} catch (e) {
				return toolResult(toolError(`Approval prompt failed: ${errMessage(e)}`));
			}
		}
		// Pre-run lint pass — short-circuits on bug-class issues (undefined
		// names, control-flow misuse, mutable defaults, etc.) so the model
		// gets actionable feedback in microseconds instead of failing
		// mid-execution after side effects. Failures here are advisory:
		// if the ruff sidecar is missing the call returns [] and we run.
		const lintIssues = await lintSandboxCode(code);
		if (lintIssues.length > 0) {
			return {
				result: formatLintFailure(lintIssues),
				lintIssues
			};
		}
		try {
			const timeoutMs = Math.round((getSettings().sandboxTimeoutSeconds ?? 60) * 1000);
			const r = await runPython(code, {
				timeoutMs,
				// Surface package downloads on the running tool card so a slow
				// first import reads as "Installing plotly…" rather than a hang.
				onInstall: (pkg) => ctx.onProgress?.(`Installing ${pkg}…`)
			});
			return { result: formatResult(r), artifacts: r.artifactsList };
		} catch (e) {
			return toolResult(toolError(`Sandbox error: ${errMessage(e)}`));
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
				'Wipe the Python sandbox for the current chat: clears all variables, imports, and installed packages. Use after a poisoned state (hung import, bad monkey-patch, irrecoverable error). Does not affect chat history.',
			parameters: { type: 'object', properties: {} }
		}
	},
	displayLabel: () => 'reset',
	async execute() {
		try {
			await resetSandbox();
			return toolResult('Python sandbox reset.');
		} catch (e) {
			return toolResult(toolError(`Reset failed: ${errMessage(e)}`));
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
				'Install a Python package via micropip. NOTE: run_python auto-installs imports, so you usually do NOT need this — just import the package directly. Use this tool only if you need a specific version (`pandas==2.1.0`) or want to install a package without running any code yet. Pure-Python wheels from PyPI and pre-built Pyodide packages work. C-extension packages not pre-built for Pyodide will fail.',
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
			const timeoutMs = Math.round((getSettings().sandboxTimeoutSeconds ?? 60) * 1000);
			const r = await installPackage(pkg, { timeoutMs });
			return toolResult(formatResult(r));
		} catch (e) {
			return toolResult(toolError(`Install failed: ${errMessage(e)}`));
		}
	}
});
