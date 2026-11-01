/**
 * A fake run for driving the autonomous-coding pipeline directly: a
 * JobRunContext whose `runJobTurn` plays a script per turn kind, and an
 * `invoke` that stands in for the working directory (an in-memory file tree
 * plus a small fake git and the verification command).
 *
 * Not shipped: only the `pipeline.*.test.ts` files import this. Each test file
 * mocks `@tauri-apps/api/core` with `tauri.invoke` and calls `fakeRun`, which
 * routes it.
 */
import { vi, type Mock } from 'vitest';
import type { RunStatus, RunStepState, RunTrigger } from '#lib/agent/jobs/runner.svelte.ts';
import type { JobRunContext } from '#lib/agent/jobs/types/types.ts';
import type { JobWithSteps } from '#lib/stores/jobs.svelte.ts';
import { invokeRouter } from '#lib/testing/invoke.ts';

export const PLAN_DIR = 'plan/x/';
export const DECISIONS = `${PLAN_DIR}DECISIONS-coding.md`;
export const TODO = `${PLAN_DIR}TODO-coding.md`;
export const PROGRESS = `${PLAN_DIR}PROGRESS-coding.md`;
export const REPORT = `${PLAN_DIR}REPORT-coding.md`;
export const VERIFY_CMD = 'npm test';

/** A decisions file whose verification section the runner can read. */
export function decisionsWith(command: string | null): string {
	return command === null
		? '# Decisions\n\nNothing to verify.\n'
		: `# Decisions\n\n## Verification command\n\n\`\`\`sh\n${command}\n\`\`\`\n`;
}

export type TurnOpts = Parameters<JobRunContext['runJobTurn']>[0];

/** What a turn script does: act on the world, return the turn's final text. */
export type TurnScript = (opts: TurnOpts, run: FakeRun) => string | void | Promise<string | void>;

export interface FakeRunOptions {
	/** The job's `type_config`, laid over `{ plan_dir: PLAN_DIR }`. */
	config?: Record<string, unknown>;
	trigger?: RunTrigger;
	/** Files on disk before the run, by path relative to the working dir. */
	files?: Record<string, string>;
	/** Scripts by `turnKind`, over the defaults (see `fakeRun`). */
	turns?: Record<string, TurnScript>;
	/** Exit codes the verification command gives, in order; the last repeats. */
	verifyExits?: number[];
	/** `git commit` fails unless signing is turned off (an expired signer). */
	signFails?: boolean;
}

interface ExecResult {
	stdout: string;
	stderr: string;
	exit_code: number | null;
	duration_ms: number;
	killed: boolean;
	out_of_memory: boolean;
	memory_limit_mb: number | null;
}

export interface FakeRun {
	ctx: JobRunContext;
	files: Map<string, string>;
	/** Every turn the pipeline started, in order. */
	turns: TurnOpts[];
	steps: Partial<RunStepState>[];
	/** Set by `finalizeRun`. */
	result: { status: RunStatus; error: string | null } | null;
	/** Messages of the commits that landed, in order. */
	commits: string[];
	/** Every command `run_command_capture` ran, in order. */
	commands: string[];
	/** Commands run that were not git (the verification command). */
	checks: string[];
	/** A tool call, as the agent loop reports it to the turn's callbacks. */
	callTool: (opts: TurnOpts, name: string, args: Record<string, unknown>) => void;
	/** A write tool call that also lands the file. */
	writeFile: (opts: TurnOpts, path: string, content: string) => void;
	/** Lines of PROGRESS-coding.md that start a section. */
	progressHeadings: () => string[];
	turnsOf: (kind: string) => TurnOpts[];
}

export function codingJob(config: Record<string, unknown> = {}): JobWithSteps {
	return {
		id: 1,
		name: 'Coding job',
		description: null,
		working_dir: '/repo',
		auto_approve_tools: true,
		job_type: 'autonomous_coding',
		schedule_kind: 'manual',
		schedule_config: null,
		next_due_at: null,
		created_at: 0,
		updated_at: 0,
		steps: [],
		type_config: JSON.stringify({ plan_dir: PLAN_DIR, ...config }),
		model_remote_base_url: null,
		model_remote_api_key: null,
		model_remote_api_key_id: null,
		model_remote_model_id: null,
		model_remote_context_size: null,
		model_remote_vision_supported: null,
		model_advanced: null
	};
}

const exec = (out: Partial<ExecResult> = {}): ExecResult => ({
	stdout: '',
	stderr: '',
	exit_code: 0,
	duration_ms: 1,
	killed: false,
	out_of_memory: false,
	memory_limit_mb: null,
	...out
});

/**
 * The working directory: files in memory, and a git that knows only whether
 * anything changed since the last commit (and whether that was outside the
 * plan dir). Any command that is not git is the verification command.
 */
function fakeWorkdir(opts: FakeRunOptions) {
	const files = new Map(Object.entries(opts.files ?? {}));
	const commits: string[] = [];
	const commands: string[] = [];
	const checks: string[] = [];
	const verifyExits = [...(opts.verifyExits ?? [0])];
	const git = { head: 1, dirty: false, dirtyOutsidePlan: false, staged: false };

	const exact: Record<string, () => ExecResult> = {
		'git rev-parse --is-inside-work-tree': () => exec({ stdout: 'true' }),
		'git rev-parse HEAD': () => exec({ stdout: `head${git.head}\n` }),
		'git branch --show-current': () => exec({ stdout: 'main\n' }),
		'git status --porcelain': () => exec({ stdout: git.dirty ? ' M a\n' : '' }),
		'git add -A': () => {
			git.staged = git.dirty;
			return exec();
		},
		'git diff --cached --quiet': () => exec({ exit_code: git.staged ? 1 : 0 }),
		'git reset --soft HEAD~1': () => {
			commits.pop();
			git.head--;
			return exec();
		}
	};

	const commit = (command: string): ExecResult => {
		if (opts.signFails && !command.includes('commit.gpgsign=false')) {
			return exec({ exit_code: 128, stderr: 'error: gpg failed to sign the data' });
		}
		commits.push(/-m "(.*)"$/.exec(command)?.[1] ?? command);
		git.head++;
		git.dirty = git.dirtyOutsidePlan = git.staged = false;
		return exec();
	};

	const check = (command: string): ExecResult => {
		checks.push(command);
		const exit = verifyExits.length > 1 ? verifyExits.shift()! : verifyExits[0];
		return exit === 0
			? exec({ stdout: 'all tests pass' })
			: exec({ exit_code: exit, stdout: 'FAIL: 1 test' });
	};

	const run = (command: string): ExecResult => {
		commands.push(command);
		if (exact[command]) return exact[command]();
		if (command.startsWith('git checkout -b ')) return exec();
		if (command.startsWith('git status --porcelain -- .')) {
			return exec({ stdout: git.dirtyOutsidePlan ? ' M src/lib.rs\n' : '' });
		}
		if (command.startsWith('git ') && command.includes(' commit')) return commit(command);
		return check(command);
	};

	const write = (path: string, content: string) => {
		files.set(path, content);
		git.dirty = true;
		if (!path.startsWith(PLAN_DIR)) git.dirtyOutsidePlan = true;
	};

	return { files, commits, commands, checks, run, write };
}

/** Answers `invoke` for the pipeline's file and shell commands. */
function routeWorkdir(invoke: Mock, wd: ReturnType<typeof fakeWorkdir>) {
	invoke.mockImplementation(
		invokeRouter({
			fs_read_text_full: (a) => {
				const content = wd.files.get(String(a?.relPath));
				if (content === undefined) throw new Error('No such file');
				return content;
			},
			fs_write_text: (a) => wd.write(String(a?.relPath), String(a?.content)),
			fs_path_exists: (a) => wd.files.has(String(a?.relPath)),
			fs_list_dir: (a) => {
				const dir = String(a?.relPath);
				const names = [...wd.files.keys()]
					.filter((p) => p.startsWith(dir) && !p.slice(dir.length).includes('/'))
					.map((p) => p.slice(dir.length));
				return { entries: names.map((name) => ({ name, is_dir: false })) };
			},
			run_command_capture: (a) => wd.run(String(a?.command))
		})
	);
}

/** Submit a phase result after writing one source file: a phase that built. */
export const buildsThePhase: TurnScript = (o, run) => {
	run.writeFile(o, 'src/lib.rs', 'fn main() {}\n');
	run.callTool(o, 'submit_phase_result', { note: 'Phase built.' });
};

/** A repair that edits a source file and reports done for the item it was given. */
export const repairsIt: TurnScript = (o, run) => {
	run.writeFile(o, 'src/fix.rs', '// fixed\n');
	run.callTool(o, 'submit_iteration_result', {
		item_id: assignedItem(o),
		status: 'done',
		note: 'Fixed the failing test.'
	});
};

/** The item id an iteration turn was told to work on. */
export function assignedItem(o: TurnOpts): string {
	return /EXACTLY ONE checklist item: (\d+)\./.exec(o.userMessage)?.[1] ?? '';
}

/**
 * Build a fake run, route `invoke` through it, and return it. Default turns:
 * preflight writes the decisions file (with `VERIFY_CMD`) and reports ready,
 * decompose submits one phase of two items, the phase turn builds, finalize
 * and the README turn write their files. Everything else does nothing.
 */
export function fakeRun(invoke: Mock, opts: FakeRunOptions = {}): FakeRun {
	const wd = fakeWorkdir(opts);
	const { files } = wd;
	const turns: TurnOpts[] = [];
	const steps: Partial<RunStepState>[] = Array.from({ length: 5 }, () => ({}));
	const write = wd.write;
	let current = 0;

	routeWorkdir(invoke, wd);

	const defaults: Record<string, TurnScript> = {
		preflight: (o, r) => {
			r.writeFile(o, DECISIONS, decisionsWith(VERIFY_CMD));
			r.callTool(o, 'submit_preflight', { ready: true, decisions_resolved: 2 });
			return 'All settled.';
		},
		decompose: (o, r) => {
			r.callTool(o, 'submit_task_list', {
				items: [
					{ title: 'One', description: 'first', phase: 'Scaffold' },
					{ title: 'Two', description: 'second', phase: 'Scaffold' }
				]
			});
		},
		'loop.phase': buildsThePhase,
		'finalize.report': (o, r) => r.writeFile(o, REPORT, '# Report\n'),
		'document.readme': (o, r) => r.writeFile(o, 'README.md', '# Project\n')
	};
	const scripts = { ...defaults, ...opts.turns };

	const run: FakeRun = {
		files,
		turns,
		steps,
		result: null,
		commits: wd.commits,
		commands: wd.commands,
		checks: wd.checks,
		callTool: (o, name, args) => {
			o.onToolStart?.({ id: `${name}-${turns.length}`, name, arguments: args });
		},
		writeFile: (o, path, content) => {
			run.callTool(o, 'fs_write_text', { path, content });
			write(path, content);
		},
		progressHeadings: () =>
			(files.get(PROGRESS) ?? '').split('\n').filter((l) => l.startsWith('## ')),
		turnsOf: (kind) => turns.filter((t) => t.turnKind === kind),
		ctx: {
			job: codingJob(opts.config),
			runId: 7,
			abort: new AbortController(),
			trigger: opts.trigger ?? 'manual',
			runJobTurn: async (o) => {
				turns.push(o);
				const script = o.turnKind ? scripts[o.turnKind] : undefined;
				const text = (await script?.(o, run)) ?? '';
				return { finalText: text, rawText: text };
			},
			patchStep: (i, patch) => Object.assign(steps[i], patch),
			buildStreamCallbacks: () => ({}),
			setCurrentStepIndex: (i) => {
				current = i;
			},
			liveStepIndex: () => current,
			stepAuthored: () => '',
			isLive: () => true,
			contextSize: () => 32_768,
			visionSupported: () => false,
			finalizeRun: (status, error) => {
				run.result = { status, error };
			},
			onSettled: vi.fn(),
			startChainedRun: vi.fn(async () => null)
		}
	};
	return run;
}
