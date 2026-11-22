/**
 * A job drafted from a chat (`propose_job`): the model's arguments, checked
 * against the job type's `propose` entry and its own `validate`, turned into
 * the draft the Jobs tab opens unsaved. Nothing here saves or runs a job.
 */
import type { JobStepInput } from '#lib/stores/jobs.svelte.ts';
import type { JobDraft } from '#lib/stores/jobsTabSelection.svelte.ts';
import type {
	JobProposal,
	JobTypeDefinition,
	ProposalSetting,
	ProposedFields
} from '#lib/agent/jobs/types/types.ts';

/** What the model asked for, read from its arguments. */
export interface ProposalArgs {
	name: string;
	workingDir: string;
	brief: string;
	steps: string[];
	settings: Record<string, unknown>;
	spec: string | null;
}

export type ProposalResult = { draft: JobDraft } | { error: string };

/** How many spec problems go back to the model at once. */
const MAX_SPEC_PROBLEMS = 8;

/** The type's settings, one per line, for an error that lists them. */
export function describeSettings(settings: Record<string, ProposalSetting>): string {
	const lines = Object.entries(settings).map(
		([key, s]) => `- ${key}: ${s.help}${s.values ? ` (${s.values.join(', ')})` : ''}`
	);
	return lines.length > 0 ? lines.join('\n') : '(none)';
}

/** What is wrong with one setting, or null. */
function settingProblem(
	key: string,
	value: unknown,
	setting: ProposalSetting,
	current: unknown
): string | null {
	const want = typeof current;
	if (current !== null && current !== undefined && typeof value !== want) {
		return `${key} takes a ${want}, not ${JSON.stringify(value)}.`;
	}
	if (want === 'number' && !Number.isFinite(value)) return `${key} takes a number.`;
	if (setting.values && !setting.values.includes(String(value))) {
		return `${key} takes ${setting.values.join(', ')}; not ${JSON.stringify(value)}.`;
	}
	return null;
}

/** The defaults with the model's settings laid over them, or what is wrong with those. */
function applySettings(
	def: JobTypeDefinition,
	propose: JobProposal,
	settings: Record<string, unknown>
): { config: Record<string, unknown> } | { error: string } {
	let config = def.configDefaults();
	const problems: string[] = [];
	for (const [key, value] of Object.entries(settings)) {
		const setting = propose.settings[key];
		const problem = setting
			? settingProblem(key, value, setting, config[key])
			: `${key} is not a setting of a ${def.label} job.`;
		if (problem) problems.push(problem);
		else config = { ...config, [key]: value };
	}
	if (problems.length === 0) return { config };
	return {
		error: `${problems.join(' ')}\nThe settings a ${def.label} job takes:\n${describeSettings(propose.settings)}`
	};
}

/** The spec as the draft carries it, null for none, or what is wrong with it. */
function readSpec(
	def: JobTypeDefinition,
	propose: JobProposal,
	text: string | null
): { spec: string | null } | { error: string } {
	if (text === null || !text.trim()) return { spec: null };
	if (!propose.spec) return { error: `A ${def.label} job doesn't read a spec. Leave spec out.` };
	const problems = propose.spec.problems(text);
	if (problems.length === 0) return { spec: text.endsWith('\n') ? text : `${text}\n` };
	const shown = problems.slice(0, MAX_SPEC_PROBLEMS).join('\n- ');
	const more =
		problems.length > MAX_SPEC_PROBLEMS
			? `\n(and ${problems.length - MAX_SPEC_PROBLEMS} more)`
			: '';
	return {
		error: `The spec can't be read:\n- ${shown}${more}\nFix it, or leave spec out and give a brief: the run writes the spec from it.`
	};
}

/** A blank name, or a blank folder for a type that needs one. */
function missingBasics(def: JobTypeDefinition, args: ProposalArgs): string | null {
	if (!args.name.trim()) return 'name is empty: give the job a short name.';
	if (def.workingDirPlaceholder && !args.workingDir.trim()) {
		return `A ${def.label} job needs working_dir: an absolute path to a folder.`;
	}
	return null;
}

function stepsFrom(prompts: string[]): JobStepInput[] {
	const steps = prompts
		.map((prompt) => prompt.trim())
		.filter(Boolean)
		.map((prompt) => ({ prompt, deep_research: false }));
	return steps.length > 0 ? steps : [{ prompt: '', deep_research: false }];
}

/** The config and steps with the brief, and a spec, in the type's places for them. */
function briefed(
	propose: JobProposal,
	config: Record<string, unknown>,
	args: ProposalArgs,
	hasSpec: boolean
): ProposedFields {
	let fields: ProposedFields = { config, steps: stepsFrom(args.steps) };
	const brief = args.brief.trim();
	if (brief && propose.brief) fields = propose.brief(fields, brief);
	if (hasSpec && propose.spec?.select) {
		fields = { ...fields, config: propose.spec.select(fields.config) };
	}
	return fields;
}

/** The draft for `args`, or what the model has to change. */
export function draftFromProposal(def: JobTypeDefinition, args: ProposalArgs): ProposalResult {
	const propose = def.propose;
	if (!propose) return { error: `A ${def.label} job can't be proposed from a chat.` };
	const missing = missingBasics(def, args);
	if (missing) return { error: missing };
	const name = args.name.trim();
	const workingDir = args.workingDir.trim();
	const applied = applySettings(def, propose, args.settings);
	if ('error' in applied) return applied;
	const read = readSpec(def, propose, args.spec);
	if ('error' in read) return read;

	const { config, steps } = briefed(propose, applied.config, args, read.spec !== null);
	const description = propose.brief ? '' : args.brief.trim();

	const invalid = def.validate?.({ name, workingDir, steps, config }) ?? null;
	if (invalid) return { error: `The job isn't ready: ${invalid}` };

	return {
		draft: {
			jobType: def.id,
			name,
			workingDir,
			config,
			...(description ? { description } : {}),
			steps,
			...(read.spec !== null ? { spec: read.spec } : {})
		}
	};
}
