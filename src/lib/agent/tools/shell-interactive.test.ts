import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { invokeCalls, invokeRouter } from '#lib/testing/invoke.ts';
import type { ToolContext } from '#lib/agent/tools/types.ts';

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));

import { executeTool, getDisplayLabel } from '#lib/agent/tools/index.ts';

const SID = 7;

interface Region {
	commandLine: string;
	output: string;
	exitCode: number | null;
	cwd: string | null;
	truncated: boolean;
	pending?: boolean;
}

function region(output: string, opts: Partial<Region> = {}): Region {
	return {
		commandLine: 'python3',
		output,
		exitCode: null,
		cwd: '/home/u',
		truncated: false,
		pending: true,
		...opts
	};
}

function shellCtx(over: Partial<ToolContext> = {}): ToolContext {
	return {
		workingDir: null,
		pendingImages: [],
		deepResearch: false,
		shellMode: true,
		codeMode: true,
		codeAutoApprove: false,
		filesWrittenThisTurn: new Set<string>(),
		shellSessionId: SID,
		...over
	};
}

/** The terminal as a sequence of what `shell_get_recent_commands` reports:
 *  each call takes the next entry, and the last one repeats forever. */
function terminal(...frames: (Region | null)[]) {
	let i = 0;
	return () => {
		const frame = frames[Math.min(i, frames.length - 1)];
		i++;
		return frame ? [frame] : [];
	};
}

/** Run a tool, letting its polling sleeps elapse on fake time. */
async function run(name: string, args: Record<string, unknown>, ctx = shellCtx()) {
	const out = executeTool(name, args, ctx);
	await vi.runAllTimersAsync();
	return out;
}

/** The bytes the tool typed into the terminal. */
function typed(): unknown[] {
	return invokeCalls(tauri.invoke, 'shell_write').map((a) => a?.data);
}

beforeEach(() => {
	tauri.invoke.mockReset();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('outside a live terminal', () => {
	it.each(['shell_read', 'shell_input', 'shell_interrupt', 'shell_snapshot'])(
		'%s says it only works in a live terminal session',
		async (name) => {
			tauri.invoke.mockImplementation(invokeRouter({}));
			const out = await run(name, {}, shellCtx({ shellSessionId: undefined }));
			expect(JSON.parse(out.result).error).toMatch(/only works in a live terminal session/);
		}
	);
});

describe('shell_read', () => {
	it('says the terminal is idle when nothing has run yet', async () => {
		tauri.invoke.mockImplementation(invokeRouter({ shell_get_recent_commands: [] }));
		const out = await run('shell_read', {});
		expect(out.result).toBe('The terminal is idle at a prompt; nothing has run yet.');
	});

	it("shows a running program's output so far, trailing whitespace trimmed", async () => {
		tauri.invoke.mockImplementation(
			invokeRouter({
				shell_get_recent_commands: [
					region('Serving on :8000\nGET /\n\n', { commandLine: 'npm run dev' })
				]
			})
		);
		const out = await run('shell_read', {});
		expect(out.result).toBe(
			'`npm run dev` is still running. Output so far:\nServing on :8000\nGET /'
		);
	});

	it('names a running program with no command line as "A command"', async () => {
		tauri.invoke.mockImplementation(
			invokeRouter({ shell_get_recent_commands: [region('x', { commandLine: '' })] })
		);
		const out = await run('shell_read', {});
		expect(out.result).toMatch(/^`A command` is still running/);
	});

	it('suggests a silent running program may be waiting for input', async () => {
		tauri.invoke.mockImplementation(invokeRouter({ shell_get_recent_commands: [region('  \n')] }));
		const out = await run('shell_read', {});
		expect(out.result).toBe(
			'`python3` is still running. Output so far: (no output yet — it may be waiting for input).'
		);
	});

	it('reports the last finished command with its exit code', async () => {
		tauri.invoke.mockImplementation(
			invokeRouter({
				shell_get_recent_commands: [region('done\n', { pending: false, exitCode: 2 })]
			})
		);
		const out = await run('shell_read', {});
		expect(out.result).toBe('Last command finished (exit 2). Output:\ndone');
	});

	it('says "exit unknown" and "no output" for a silent command with no exit code', async () => {
		tauri.invoke.mockImplementation(
			invokeRouter({ shell_get_recent_commands: [region('', { pending: false })] })
		);
		const out = await run('shell_read', {});
		expect(out.result).toBe('Last command finished (exit unknown). Output: (no output).');
	});

	it('spills a very large output to a file the model can read', async () => {
		tauri.invoke.mockImplementation(
			invokeRouter({
				shell_get_recent_commands: [region('log line\n'.repeat(5000))],
				code_write_overflow: '/tmp/haruspex-overflow-1.txt'
			})
		);
		const out = await run('shell_read', {});
		expect(out.result).toMatch(/^`python3` is still running\. Output so far:\n/);
		expect(out.result).toContain('saved to /tmp/haruspex-overflow-1.txt');
		expect(out.result.length).toBeLessThan(45_000);
	});

	it('reports a closed session as a tool error', async () => {
		tauri.invoke.mockImplementation(
			invokeRouter({
				shell_get_recent_commands: () => {
					throw 'no such session';
				}
			})
		);
		const out = await run('shell_read', {});
		expect(JSON.parse(out.result).error).toBe('shell_read failed: no such session');
	});
});

describe('shell_input', () => {
	it('refuses to type into an idle shell, so it cannot bypass run_command', async () => {
		tauri.invoke.mockImplementation(
			invokeRouter({ shell_get_recent_commands: [region('', { pending: false, exitCode: 0 })] })
		);
		const out = await run('shell_input', { text: 'rm -rf build' });
		expect(JSON.parse(out.result).error).toMatch(/Nothing is currently running/);
		expect(typed()).toEqual([]);
	});

	it('refuses when nothing has ever run', async () => {
		tauri.invoke.mockImplementation(invokeRouter({ shell_get_recent_commands: [] }));
		const out = await run('shell_input', { text: 'y' });
		expect(JSON.parse(out.result).error).toMatch(/use run_command/);
		expect(typed()).toEqual([]);
	});

	it('types the line with Enter and returns only what appeared after it', async () => {
		tauri.invoke.mockImplementation(
			invokeRouter({
				shell_get_recent_commands: terminal(region('>>> '), region('>>> 1+1\n2\n>>> '))
			})
		);
		const out = await run('shell_input', { text: '1+1' });
		expect(typed()).toEqual(['1+1\n']);
		expect(out.result).toBe('Sent `1+1`. Output since:\n1+1\n2\n>>>');
	});

	it('sends raw keystrokes without Enter when enter is false', async () => {
		tauri.invoke.mockImplementation(
			invokeRouter({ shell_get_recent_commands: terminal(region('more'), region('more')) })
		);
		await run('shell_input', { text: 'q', enter: false });
		expect(typed()).toEqual(['q']);
	});

	it('reads a stringified "false" for enter as false', async () => {
		tauri.invoke.mockImplementation(
			invokeRouter({ shell_get_recent_commands: terminal(region('more'), region('more')) })
		);
		await run('shell_input', { text: 'q', enter: 'false' });
		expect(typed()).toEqual(['q']);
	});

	it('sends just Enter for empty text', async () => {
		tauri.invoke.mockImplementation(
			invokeRouter({
				shell_get_recent_commands: terminal(region('Continue?'), region('Continue?'))
			})
		);
		const out = await run('shell_input', { text: '' });
		expect(typed()).toEqual(['\n']);
		expect(out.result).toBe('Sent Enter. Output since: (no new output).');
	});

	it('treats text that is not a string or number as empty and sends just Enter', async () => {
		tauri.invoke.mockImplementation(
			invokeRouter({ shell_get_recent_commands: terminal(region('?'), region('?')) })
		);
		const out = await run('shell_input', { text: { line: 'y' } });
		expect(typed()).toEqual(['\n']);
		expect(out.result).toMatch(/^Sent Enter\./);
	});

	it('types a numeric text as its digits', async () => {
		tauri.invoke.mockImplementation(
			invokeRouter({ shell_get_recent_commands: terminal(region('Pick: '), region('Pick: ')) })
		);
		await run('shell_input', { text: 3 });
		expect(typed()).toEqual(['3\n']);
	});

	it('says there was no new output when the screen did not change', async () => {
		tauri.invoke.mockImplementation(
			invokeRouter({ shell_get_recent_commands: terminal(region('(gdb) ')) })
		);
		const out = await run('shell_input', { text: 'next' });
		expect(out.result).toBe('Sent `next`. Output since: (no new output).');
	});

	it('says when the program exited after the input', async () => {
		tauri.invoke.mockImplementation(
			invokeRouter({
				shell_get_recent_commands: terminal(
					region('Proceed? [y/N] '),
					region('Proceed? [y/N] y\nDone.\n', { pending: false, exitCode: 0 })
				)
			})
		);
		const out = await run('shell_input', { text: 'y' });
		expect(out.result).toBe('Sent `y`. The program then exited. Output:\ny\nDone.');
	});

	it('returns the whole buffer when the output ring rotated past what was on screen', async () => {
		tauri.invoke.mockImplementation(
			invokeRouter({
				shell_get_recent_commands: terminal(region('old line\n> '), region('fresh tail\n> '))
			})
		);
		const out = await run('shell_input', { text: 'go' });
		expect(out.result).toBe('Sent `go`. Output since:\nfresh tail\n>');
	});

	it('gives up after about six seconds on output that never settles', async () => {
		let n = 0;
		tauri.invoke.mockImplementation(
			invokeRouter({
				shell_get_recent_commands: () => [region(n === 0 ? '$ ' : `$ ${'.'.repeat(n++)}`, {})],
				shell_write: () => {
					n = 1;
				}
			})
		);
		const start = Date.now();
		const out = await run('shell_input', { text: 'tail' });
		const elapsed = Date.now() - start;
		expect(elapsed).toBeGreaterThanOrEqual(6000);
		expect(elapsed).toBeLessThan(6500);
		expect(out.result).toMatch(/^Sent `tail`\. Output since:\n\.+$/);
	});

	it('reports a session that closes mid-way as a tool error', async () => {
		let calls = 0;
		tauri.invoke.mockImplementation(
			invokeRouter({
				shell_get_recent_commands: () => {
					if (calls++ === 0) return [region('> ')];
					throw 'session closed';
				}
			})
		);
		const out = await run('shell_input', { text: 'x' });
		expect(JSON.parse(out.result).error).toBe('shell_input failed: session closed');
	});
});

describe('shell_interrupt', () => {
	it('still sends Ctrl-C but says nothing was running at an idle prompt', async () => {
		tauri.invoke.mockImplementation(
			invokeRouter({
				shell_get_recent_commands: [region('', { pending: false, exitCode: 0 })],
				shell_get_context: { completed_total: 3 }
			})
		);
		const out = await run('shell_interrupt', {});
		expect(typed()).toEqual(['\x03']);
		expect(out.result).toBe(
			'Sent Ctrl-C (SIGINT), but nothing was running — the terminal was already idle at a prompt.'
		);
	});

	it('reports the program stopped and shows its final output', async () => {
		let total = 3;
		tauri.invoke.mockImplementation(
			invokeRouter({
				shell_get_recent_commands: () =>
					total > 3
						? [region('Serving\n^C\nShutting down\n', { pending: false, exitCode: 130 })]
						: [region('Serving\n')],
				shell_get_context: () => ({ completed_total: total }),
				shell_write: () => {
					total = 4;
				}
			})
		);
		const out = await run('shell_interrupt', {});
		expect(out.result).toBe(
			'Sent Ctrl-C (SIGINT); the program stopped and the terminal is free again. Final output:\nServing\n^C\nShutting down'
		);
	});

	it('leaves out "Final output" when the stopped program printed nothing', async () => {
		let total = 0;
		tauri.invoke.mockImplementation(
			invokeRouter({
				shell_get_recent_commands: () =>
					total > 0 ? [region('', { pending: false })] : [region('')],
				shell_get_context: () => ({ completed_total: total }),
				shell_write: () => {
					total = 1;
				}
			})
		);
		const out = await run('shell_interrupt', {});
		expect(out.result).toBe(
			'Sent Ctrl-C (SIGINT); the program stopped and the terminal is free again.'
		);
	});

	it('suggests force:true when the program ignores Ctrl-C for four seconds', async () => {
		tauri.invoke.mockImplementation(
			invokeRouter({
				shell_get_recent_commands: [region('stubborn')],
				shell_get_context: { completed_total: 5 }
			})
		);
		const start = Date.now();
		const out = await run('shell_interrupt', {});
		expect(Date.now() - start).toBeGreaterThanOrEqual(4000);
		expect(out.result).toBe(
			'Sent Ctrl-C (SIGINT), but the program is still running after 4s — it may be ignoring the signal. Try shell_interrupt again with force:true.'
		);
	});

	it('sends Ctrl-\\ with force and points at the Restart button if that fails too', async () => {
		tauri.invoke.mockImplementation(
			invokeRouter({
				shell_get_recent_commands: [region('stubborn')],
				shell_get_context: { completed_total: 5 }
			})
		);
		const out = await run('shell_interrupt', { force: 'true' });
		expect(typed()).toEqual(['\x1c']);
		expect(out.result).toMatch(/^Sent Ctrl-\\ \(SIGQUIT\), but the program is still running/);
		expect(out.result).toContain('ask the user to use the terminal Restart button');
	});

	it('treats a non-boolean force as a plain Ctrl-C', async () => {
		tauri.invoke.mockImplementation(
			invokeRouter({
				shell_get_recent_commands: [region('', { pending: false })],
				shell_get_context: { completed_total: 0 }
			})
		);
		await run('shell_interrupt', { force: 1 });
		expect(typed()).toEqual(['\x03']);
	});

	it('labels a forced interrupt in the transcript', () => {
		expect(getDisplayLabel('shell_interrupt', { force: true })).toBe('interrupt (force)');
		expect(getDisplayLabel('shell_interrupt', {})).toBe('interrupt');
	});

	it('reports a closed session as a tool error before sending anything', async () => {
		tauri.invoke.mockImplementation(
			invokeRouter({
				shell_get_recent_commands: () => {
					throw 'no such session';
				}
			})
		);
		const out = await run('shell_interrupt', {});
		expect(JSON.parse(out.result).error).toBe('shell_interrupt failed: no such session');
		expect(typed()).toEqual([]);
	});

	it('reports a session that closes while waiting as an error, not a stuck program', async () => {
		let contextCalls = 0;
		tauri.invoke.mockImplementation(
			invokeRouter({
				shell_get_recent_commands: [region('server')],
				shell_get_context: () => {
					if (contextCalls++ === 0) return { completed_total: 1 };
					throw 'session closed';
				}
			})
		);
		const out = await run('shell_interrupt', {});
		expect(JSON.parse(out.result).error).toBe('shell_interrupt failed: session closed');
		expect(out.result).not.toMatch(/still running/);
	});
});
