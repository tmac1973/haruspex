/**
 * Lean mode's tool profile (Settings → General → Lean mode): a Chat turn with
 * someone at it gets these tools and no others. Chat and research only, for
 * models of 9B or smaller and machines without a fast GPU, where every schema
 * costs prompt time and context room and a long list makes the model pick
 * badly.
 *
 * Only constants live here, so the registry can import it without the cycle a
 * tool module would make (tool modules register through the registry).
 */

/**
 * What a lean Chat turn may offer, by name. A tool not listed is out, so a
 * new tool stays out of lean mode until someone adds it here on purpose. The
 * registry's other gates still apply to these: `fs_*` needs a working folder,
 * `fs_read_image` vision, `remember_this` writable memory, the skills tools
 * a skill to name.
 */
export const LEAN_CHAT_TOOLS: ReadonlySet<string> = new Set([
	'web_search',
	'fetch_url',
	'research_url',
	'image_search',
	'haruspex_docs',
	'remember_this',
	'load_skill',
	'read_skill_file',
	'fs_list_dir',
	'fs_read_text',
	'fs_read_pdf',
	'fs_read_pdf_pages',
	'fs_read_docx',
	'fs_read_xlsx',
	'fs_read_image'
]);

/** The most a lean Chat turn's schemas may add up to, in JSON characters. */
export const LEAN_SCHEMA_BUDGET_CHARS = 9500;
