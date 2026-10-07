/**
 * How a loaded skill looks in the conversation, kept apart from the rest of
 * the skills code so the context budget can recognise it without importing
 * the IPC client.
 *
 * Every loaded skill is wrapped in `<skill_content name="…">`, the tag the
 * agentskills.io client guide suggests: the model can tell a skill's
 * instructions from other text, and the trimmer can leave them alone.
 */

import type { ChatMessage } from '#lib/api.ts';
import { messageText } from '#lib/api.ts';
import type { SkillDoc } from '#lib/ipc/gen/SkillDoc.ts';

const OPEN = '<skill_content name="';

/** True when `text` carries a loaded skill. */
export function holdsSkillContent(text: string): boolean {
	return text.includes(OPEN);
}

/** Names of the skills already loaded somewhere in `messages`. */
export function loadedSkillNames(messages: ChatMessage[]): Set<string> {
	const names = new Set<string>();
	for (const m of messages) {
		const text = messageText(m.content);
		let at = text.indexOf(OPEN);
		while (at >= 0) {
			const start = at + OPEN.length;
			const end = text.indexOf('"', start);
			if (end < 0) break;
			names.add(text.slice(start, end));
			at = text.indexOf(OPEN, end);
		}
	}
	return names;
}

/** A skill's instructions as the model receives them. */
export function renderSkillContent(doc: SkillDoc): string {
	const lines = [`${OPEN}${doc.name}">`, doc.body.trim()];
	if (doc.dir) {
		lines.push(
			'',
			`Skill directory: ${doc.dir}`,
			'Paths in this skill are relative to that directory. Read its files with read_skill_file.'
		);
	}
	if (doc.compatibility) lines.push(`Requirements: ${doc.compatibility}`);
	if (doc.files.length > 0) {
		lines.push('<skill_resources>');
		for (const f of doc.files) lines.push(`  <file>${f}</file>`);
		if (doc.filesTruncated) lines.push('  (more files not listed)');
		lines.push('</skill_resources>');
	}
	lines.push('</skill_content>');
	return lines.join('\n');
}

const CLOSE = '</skill_content>';

/** The line between a skill run by `/name` and what the user typed. */
function slashNote(name: string): string {
	return `The user ran the "${name}" skill. Its instructions above take priority over your usual way of answering, including whether to search or cite sources. Follow them for this message:`;
}
/** Matches this note and the shorter one older messages were stored with. */
const SLASH_NOTE = /^\n\nThe user ran the "[^"]*" skill\.[^\n]*:\n\n/;

/**
 * The user message for `/name …`: the skill's instructions, then what the
 * user typed. Stored this way, so a later turn still has the skill, and the
 * trimmer leaves the message alone (`holdsSkillContent`).
 */
export function renderSlashMessage(doc: SkillDoc, typed: string): string {
	return `${renderSkillContent(doc)}\n\n${slashNote(doc.name)}\n\n${typed}`;
}

/**
 * What the user typed, without the skill a `/name` put ahead of it — for
 * showing the message, titling the chat, and anything else that wants the
 * request rather than the instructions. Other text comes back unchanged.
 */
export function typedText(text: string): string {
	if (!text.startsWith(OPEN)) return text;
	const end = text.indexOf(CLOSE);
	if (end < 0) return text;
	const after = text.slice(end + CLOSE.length);
	const note = SLASH_NOTE.exec(after);
	return note ? after.slice(note[0].length) : text;
}

/**
 * Loaded skills in `messages` that came with files of their own, whose
 * instructions may point the model at them.
 */
export function skillsWithFiles(messages: ChatMessage[]): Set<string> {
	const names = new Set<string>();
	for (const m of messages) {
		const text = messageText(m.content);
		let at = text.indexOf(OPEN);
		while (at >= 0) {
			const nameEnd = text.indexOf('"', at + OPEN.length);
			const end = text.indexOf(CLOSE, at);
			if (nameEnd < 0 || end < 0) break;
			if (text.slice(at, end).includes('<skill_resources>')) {
				names.add(text.slice(at + OPEN.length, nameEnd));
			}
			at = text.indexOf(OPEN, end);
		}
	}
	return names;
}
