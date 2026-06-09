// Presentation helpers for SearchStep: the icon and human label shown for
// each agent tool step. Kept out of the .svelte component so they're unit-
// testable and so adding a tool is a one-line map entry, not a switch arm.

/** Tools whose query is shown quoted (`<prefix>: "<query>"`). */
const QUOTED_LABEL_PREFIX: Record<string, string> = {
	web_search: 'Searching',
	image_search: 'Searching images'
};

/** Tool → label prefix for the rest (`<prefix>: <query>`). */
const STEP_LABEL_PREFIX: Record<string, string> = {
	fetch_url: 'Reading',
	research_url: 'Researching',
	fs_list_dir: 'Listing',
	fs_read_text: 'Reading',
	fs_read_pdf: 'Reading PDF',
	fs_read_pdf_pages: 'Rendering PDF pages',
	fs_read_docx: 'Reading docx',
	fs_read_xlsx: 'Reading xlsx',
	fs_read_image: 'Viewing image',
	fs_write_text: 'Writing',
	fs_write_docx: 'Writing docx',
	fs_write_pdf: 'Writing pdf',
	fs_write_xlsx: 'Writing xlsx',
	fs_write_odt: 'Writing odt',
	fs_write_ods: 'Writing ods',
	fs_write_pptx: 'Writing pptx',
	fs_write_odp: 'Writing odp',
	fs_edit_text: 'Editing',
	fetch_url_images: 'Scanning page for images',
	fs_download_url: 'Downloading'
};

/** Human-readable label for a running/done tool step. */
export function stepLabel(toolName: string, query: string): string {
	const quoted = QUOTED_LABEL_PREFIX[toolName];
	if (quoted) return `${quoted}: "${query}"`;
	const prefix = STEP_LABEL_PREFIX[toolName];
	return prefix ? `${prefix}: ${query}` : `${toolName}: ${query}`;
}

/** Emoji icon for a tool step. */
export function stepIcon(toolName: string): string {
	if (toolName === 'web_search') return '\u{1F50D}'; // magnifying glass
	if (toolName === 'image_search') return '\u{1F5BC}️'; // framed picture
	if (toolName === 'research_url') return '\u{1F9D0}'; // face with monocle
	if (toolName === 'fs_download_url') return '\u{2B07}️'; // down arrow
	if (toolName.startsWith('fs_write')) return '\u{1F4DD}'; // memo
	if (toolName.startsWith('fs_list')) return '\u{1F4C2}'; // open folder
	if (toolName.startsWith('fs_edit')) return '✏️'; // pencil
	return '\u{1F4C4}'; // generic document
}
