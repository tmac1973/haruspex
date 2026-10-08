/**
 * Slash commands for the Chat and Shell input boxes: `/name what I want`.
 *
 * A name is a built-in command or a skill. Running a skill this way works on
 * any model and whatever the autonomous-use setting says: the user chose it,
 * so its instructions go straight into the message (`renderSlashMessage`)
 * rather than waiting for the model to notice and load it.
 *
 * Only a whole name at the very start counts, followed by a space or the end:
 * `/etc/hosts is broken` is a sentence, and so is anything naming no command
 * — it is sent as written.
 */

import type { SkillDoc } from '#lib/ipc/gen/SkillDoc.ts';
import { codeModeOnly, listSkills, readSkill, usableSkills } from '#lib/skills/client.ts';
import { knownTrustedRoot } from '#lib/skills/project.ts';

export { knownTrustedRoot };

export type BuiltinName = 'new' | 'skills';

export interface SlashItem {
	name: string;
	description: string;
	builtin: boolean;
}

/** Kept small: each one is a name a skill can no longer use. */
export const BUILTINS: readonly SlashItem[] = [
	{ name: 'new', description: 'Start over with an empty conversation', builtin: true },
	{ name: 'skills', description: 'List the skills you can run', builtin: true }
];

const COMMAND = /^\s*\/([a-z0-9][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i;

/** `/name rest` at the start of `text`, or null. */
export function parseSlash(text: string): { name: string; rest: string } | null {
	const m = COMMAND.exec(text);
	return m ? { name: m[1], rest: (m[2] ?? '').trim() } : null;
}

/**
 * The name being typed, while the user is still on it (`/dep`), else null.
 * Drives the autocomplete: it closes once a space follows the name.
 */
export function typingName(text: string): string | null {
	const m = /^\s*\/([a-z0-9_-]*)$/i.exec(text);
	return m ? m[1] : null;
}

/** Built-ins, then usable skills, each name once. */
export async function slashItems(
	projectRoot: string | null,
	codeMode = false
): Promise<SlashItem[]> {
	const skills = usableSkills(await listSkills(projectRoot).catch(() => []), codeMode)
		.filter((s) => !BUILTINS.some((b) => b.name === s.name))
		.map((s) => ({ name: s.name, description: s.description, builtin: false }));
	return [...BUILTINS, ...skills];
}

/** Items whose name starts with `prefix`, in their listed order. */
export function matchItems(items: SlashItem[], prefix: string): SlashItem[] {
	const p = prefix.toLowerCase();
	return items.filter((i) => i.name.toLowerCase().startsWith(p));
}

export type SlashAction =
	| { kind: 'builtin'; name: BuiltinName }
	| { kind: 'skill'; doc: SkillDoc }
	/** A built-in skill that only works in Code mode, outside it. */
	| { kind: 'needsCodeMode'; name: string }
	| { kind: 'none' };

/**
 * What sending `text` should do. A skill that can't be read throws, so the
 * caller can say so and keep the text rather than send it without its skill.
 */
export async function resolveSlash(
	text: string,
	projectRoot: string | null,
	codeMode = false
): Promise<SlashAction> {
	const parsed = parseSlash(text);
	if (!parsed) return { kind: 'none' };
	const builtin = BUILTINS.find((b) => b.name === parsed.name);
	if (builtin) return { kind: 'builtin', name: builtin.name as BuiltinName };
	const all = await listSkills(projectRoot).catch(() => []);
	if (!usableSkills(all, codeMode).some((s) => s.name === parsed.name)) {
		const codeOnly = usableSkills(all, true).some((s) => s.name === parsed.name && codeModeOnly(s));
		return codeOnly ? { kind: 'needsCodeMode', name: parsed.name } : { kind: 'none' };
	}
	return { kind: 'skill', doc: await readSkill(parsed.name, projectRoot) };
}

/** `/skills`: what can be run here, as a note in the conversation. */
export function describeSkills(items: SlashItem[]): string {
	const skills = items.filter((i) => !i.builtin);
	if (skills.length === 0) {
		return 'No skills yet. Add one in Settings → Skills, then run it with `/name`.';
	}
	const list = skills.map((s) => `- \`/${s.name}\`: ${s.description}`).join('\n');
	return `Skills you can run with \`/name\`, followed by what you want:\n\n${list}`;
}

/** What an input box lends `runSlash`: its tab's own ways of doing things. */
export interface SlashHost {
	/** The trusted repo whose project skills count, if any. */
	projectRoot: () => Promise<string | null>;
	/** Code mode is on; absent in Chat, which has none. */
	codeMode?: () => boolean;
	/** `/new`: a fresh conversation (Chat) or an empty thread (Shell). */
	newConversation: () => void;
	/** `/skills`: put a note in the conversation without a model call. */
	addNote: (text: string) => void;
}

export type SlashOutcome =
	/** A built-in ran; there is nothing to send. */
	| { kind: 'handled' }
	/** Send the text, with the skill it named, if any. */
	| { kind: 'send'; skill?: SkillDoc };

/**
 * The input box's send, before it sends: run a built-in, or find the skill a
 * `/name` asks for. Throws when that skill can't be read, so the caller can
 * say so and keep the text.
 */
export async function runSlash(text: string, host: SlashHost): Promise<SlashOutcome> {
	if (!parseSlash(text)) return { kind: 'send' };
	const projectRoot = await host.projectRoot();
	const codeMode = host.codeMode?.() ?? false;
	const action = await resolveSlash(text, projectRoot, codeMode);
	if (action.kind === 'skill') return { kind: 'send', skill: action.doc };
	if (action.kind === 'none') return { kind: 'send' };
	if (action.kind === 'needsCodeMode') {
		host.addNote(
			`\`/${action.name}\` needs Code mode: switch it on in a Shell tab's assistant, inside the repo.`
		);
	} else if (action.name === 'new') host.newConversation();
	else host.addNote(describeSkills(await slashItems(projectRoot, codeMode)));
	return { kind: 'handled' };
}
