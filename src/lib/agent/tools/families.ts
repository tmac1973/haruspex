/**
 * Tool families for deferred loading (plan/deferred-tools).
 *
 * A turn with deferred loading on sends the core tools in full and lists each
 * family in one line; the model loads a family when the request needs it.
 * Nothing reads this module yet.
 */

import { toolCategory } from '#lib/agent/tools/registry.ts';
import { registeredMcpServers } from '#lib/agent/tools/mcp.ts';
import { parseMcpToolName } from '#lib/agent/tools/mcp-names.ts';

export interface ToolFamily {
	id: string;
	/** One line for the prompt's index: what it is for, in the user's words. */
	line: string;
	/** Whether a registered tool belongs to this family. */
	has: (name: string, category: string) => boolean;
}

const byCategory = (category: string) => (_: string, c: string) => c === category;
const byName = (...names: string[]) => {
	const set = new Set(names);
	return (name: string) => set.has(name);
};

/**
 * The built-in families. `save_generated` is in none: it saves pictures, songs
 * and clips alike, so it stays core rather than sit in one of their families.
 */
export const TOOL_FAMILIES: readonly ToolFamily[] = [
	{
		id: 'documents',
		line: 'documents — write a PDF, Word or OpenDocument file, a spreadsheet or a slide deck',
		has: byName('fs_write_document', 'fs_write_spreadsheet', 'fs_write_slides')
	},
	{
		id: 'email',
		line: "email — read, summarise and draft the user's email",
		has: byCategory('email')
	},
	{
		id: 'calendar',
		line: "calendar — the user's events and schedule",
		has: byCategory('calendar')
	},
	{
		id: 'contacts',
		line: "contacts — look up people in the user's address book",
		has: byCategory('contacts')
	},
	{
		id: 'images',
		line: 'images — make, edit or upscale a picture',
		has: byName('generate_image', 'edit_image', 'upscale_image')
	},
	{
		id: 'music',
		line: 'music — write a song or edit one',
		has: byCategory('music')
	},
	{
		id: 'speech',
		line: 'speech — read text aloud into an audio file',
		has: byCategory('speech')
	},
	{
		id: 'video-gen',
		line: 'video-gen — make a short video clip from a description or a picture',
		has: byCategory('video-gen')
	},
	{
		id: 'video',
		line: "video — the episodes and clips in the working folder: what's in them, cutting, captions, render",
		has: byCategory('video')
	},
	{
		id: 'screen',
		line: "screen — look at the user's screen or a window on it",
		has: byCategory('desktop')
	},
	{
		id: 'skill-writing',
		line: 'skill-writing — create or change a skill, or write AGENTS.md',
		has: byCategory('skills-write')
	},
	{
		id: 'assets',
		line: 'assets — make game art: textures, sprites and tiles',
		has: byName('make_asset')
	}
];

/** One family per MCP server with tools registered, as `mcp:<server id>`. */
export function mcpFamilies(): ToolFamily[] {
	return registeredMcpServers().map(({ id, label }) => ({
		id: `mcp:${id}`,
		line: `mcp:${id} — the tools of the ${label} server`,
		has: (name) => parseMcpToolName(name)?.serverId === id
	}));
}

/** The built-in families, then one per MCP server. */
export function allFamilies(): ToolFamily[] {
	return [...TOOL_FAMILIES, ...mcpFamilies()];
}

/** The family a registered tool belongs to, or null for a core tool. */
export function familyOf(name: string, families = allFamilies()): ToolFamily | null {
	const category = toolCategory(name);
	if (!category) return null;
	return families.find((f) => f.has(name, category)) ?? null;
}

/** Always sent in Chat (overview → Decisions). */
export const CHAT_CORE: ReadonlySet<string> = new Set([
	'web_search',
	'fetch_url',
	'fetch_url_images',
	'image_search',
	'research_url',
	'fs_list_dir',
	'fs_read_text',
	'fs_read_pdf',
	'fs_read_pdf_pages',
	'fs_read_docx',
	'fs_read_xlsx',
	'fs_read_image',
	'fs_download_url',
	'fs_write_text',
	'fs_edit_text',
	'save_generated',
	'run_python',
	'install_package',
	'reset_python',
	'ask_user_question',
	'haruspex_docs',
	'remember_this',
	'load_skill',
	'read_skill_file',
	'task_status',
	'task_cancel'
]);

/** Always sent in the Code tab (overview → Decisions). */
export const CODE_CORE: ReadonlySet<string> = new Set([
	'fs_read_text',
	'fs_list_dir',
	'fs_edit_text',
	'fs_write_text',
	'code_grep',
	'code_glob',
	'run_command',
	'web_search',
	'research_url',
	'delegate',
	'command_output',
	'command_stop',
	'open_in_shell',
	'open_in_editor',
	'save_generated',
	'ask_user_question',
	'haruspex_docs',
	'load_skill',
	'read_skill_file'
]);

/**
 * Whether a tool is always sent. A tool in no family is core, so a new tool
 * is sent in full until someone gives it a family.
 */
export function isCore(name: string, codeTab: boolean): boolean {
	return (codeTab ? CODE_CORE : CHAT_CORE).has(name) || familyOf(name) === null;
}
