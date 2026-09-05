/**
 * Guided-setup progress, and the rules for advancing through it.
 *
 * Split out of the wizard component so the rules are testable without
 * rendering: which step comes next, whether a step has been satisfied, and
 * where to resume.
 *
 * # Why it is resumable
 *
 * Google's OAuth chain sends the user to a browser to create a Cloud project,
 * enable two APIs and download a JSON file. That takes long enough that people
 * close the app mid-way, and re-doing four completed steps to get back to the
 * fifth is the kind of thing that makes someone give up on the integration
 * entirely. Progress is therefore persisted per server, not held in component
 * state.
 */

import type { SetupStep } from '$lib/ipc/gen/SetupStep';
import type { McpServerConfig } from '$lib/ipc/gen/McpServerConfig';

/**
 * Everything the wizard needs to decide whether a step is done.
 *
 * `secrets` mirrors the stored config's optional-valued map rather than
 * tightening it: a key that is present-but-undefined and a key that is absent
 * mean the same thing here, and pretending otherwise would need a conversion
 * at every call site.
 */
export interface SetupState {
	secrets: Record<string, string | undefined>;
	/** Filenames already copied into the server's directory. */
	filesPlaced: string[];
	/** Indices of `command` steps that have been run. */
	commandsRun: number[];
}

const PROGRESS_KEY = 'haruspex.mcp.setupProgress';

/** Per-server setup progress: the index of the first unfinished step. */
type ProgressMap = Record<string, number>;

function load(): ProgressMap {
	try {
		const raw = localStorage.getItem(PROGRESS_KEY);
		if (!raw) return {};
		const parsed: unknown = JSON.parse(raw);
		return parsed && typeof parsed === 'object' ? (parsed as ProgressMap) : {};
	} catch {
		// Losing progress costs the user a few clicks; refusing to load costs
		// them the wizard entirely.
		return {};
	}
}

function save(map: ProgressMap): void {
	try {
		localStorage.setItem(PROGRESS_KEY, JSON.stringify(map));
	} catch {
		// Best-effort: the wizard still works, it just restarts at step one.
	}
}

export function savedStepIndex(serverId: string): number {
	const value = load()[serverId];
	return typeof value === 'number' && value >= 0 ? value : 0;
}

export function saveStepIndex(serverId: string, index: number): void {
	const map = load();
	map[serverId] = index;
	save(map);
}

export function clearSetupProgress(serverId: string): void {
	const map = load();
	if (serverId in map) {
		save(Object.fromEntries(Object.entries(map).filter(([id]) => id !== serverId)));
	}
}

/**
 * Whether a step has everything it needs to be considered done.
 *
 * An `instruction` is done as soon as the user has read it and clicked on —
 * there is nothing to verify. A `secret` needs a non-empty value. A `file`
 * needs to have been copied into the server directory. A `command` needs to
 * have been run.
 *
 * Whitespace-only counts as empty for a secret: a token that is a single space
 * would install cleanly and then fail authentication with a message the user
 * cannot connect to what they typed.
 */
export function isStepSatisfied(step: SetupStep, state: SetupState, index: number): boolean {
	switch (step.kind) {
		case 'instruction':
			return true;
		case 'secret':
			return (state.secrets[step.key] ?? '').trim().length > 0;
		case 'file':
			return state.filesPlaced.includes(step.filename);
		case 'command':
			return state.commandsRun.includes(index);
	}
}

/**
 * Where to resume. The saved index, clamped into range, and never past a step
 * that is not actually satisfied — a saved position that has outrun the data
 * (settings edited elsewhere, a secret cleared) would otherwise let the user
 * "finish" a setup that is missing something.
 */
export function resumeIndex(steps: SetupStep[], serverId: string, state: SetupState): number {
	const saved = Math.min(savedStepIndex(serverId), steps.length);
	for (let i = 0; i < saved; i++) {
		if (!isStepSatisfied(steps[i], state, i)) return i;
	}
	return saved;
}

/** Whether every step is satisfied, i.e. the server is ready to start. */
export function isSetupComplete(steps: SetupStep[], state: SetupState): boolean {
	return steps.every((step, i) => isStepSatisfied(step, state, i));
}

/** A short label for a step, for the wizard's progress list. */
export function stepLabel(step: SetupStep): string {
	switch (step.kind) {
		case 'instruction':
			return step.title;
		case 'secret':
		case 'file':
		case 'command':
			return step.label;
	}
}

/**
 * What a catalog entry will ask of the user, in one sentence, shown **before**
 * they commit to installing.
 *
 * Disclosing a Google-Cloud-project detour after the download has finished is a
 * bad experience — the point of installing was to get a working integration,
 * and finding out afterwards that it needs twenty minutes of console work is
 * the moment someone abandons it half-configured.
 */
export function describeSetup(steps: SetupStep[]): string | null {
	if (steps.length === 0) return null;
	const secrets = steps.filter((s) => s.kind === 'secret').length;
	const files = steps.filter((s) => s.kind === 'file').length;
	const commands = steps.filter((s) => s.kind === 'command').length;
	const parts: string[] = [];
	if (secrets) parts.push(secrets === 1 ? 'a credential' : `${secrets} credentials`);
	if (files) parts.push(files === 1 ? 'a file from your computer' : `${files} files`);
	if (commands) parts.push('a one-time sign-in');
	if (parts.length === 0) return `${steps.length} setup steps to read through.`;
	const list =
		parts.length === 1
			? parts[0]
			: `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
	return `Setup asks for ${list}.`;
}

/** The state a wizard reads out of a stored server config. */
export function setupStateOf(
	config: McpServerConfig,
	filesPlaced: string[],
	commandsRun: number[]
): SetupState {
	return { secrets: config.secrets, filesPlaced, commandsRun };
}
