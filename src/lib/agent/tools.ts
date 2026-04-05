import type { ToolDefinition } from '$lib/api';

const WEB_TOOLS: ToolDefinition[] = [
	{
		type: 'function',
		function: {
			name: 'web_search',
			description:
				'Search the web for current information. Use this when the user asks about recent events, facts you are unsure about, or anything that benefits from up-to-date information.',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'The search query' }
				},
				required: ['query']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'fetch_url',
			description:
				'Fetch and extract the text content from a web page URL. Use this to read full articles or pages found via web_search.',
			parameters: {
				type: 'object',
				properties: {
					url: { type: 'string', description: 'The URL to fetch' }
				},
				required: ['url']
			}
		}
	}
];

const FS_TOOLS: ToolDefinition[] = [
	{
		type: 'function',
		function: {
			name: 'fs_list_dir',
			description:
				'List the files and subdirectories in a directory within the working directory. Pass "." or "" to list the working directory root. Always call this first before reading specific files if you are not sure what files exist.',
			parameters: {
				type: 'object',
				properties: {
					path: {
						type: 'string',
						description: 'Relative path within the working directory. Use "." for the root.'
					}
				},
				required: ['path']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'fs_read_text',
			description:
				'Read the contents of a text file (txt, md, csv, json, sh, yml, toml, log, etc.) from the working directory. Do not use this for PDF, docx, xlsx, or image files — use format-specific tools instead.',
			parameters: {
				type: 'object',
				properties: {
					path: {
						type: 'string',
						description: 'Relative path to the file within the working directory.'
					}
				},
				required: ['path']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'fs_write_text',
			description:
				'Create a new text file or overwrite an existing one in the working directory. Use this for txt, md, csv, json, bash scripts, and other plain text formats. The content parameter is written verbatim to the file.',
			parameters: {
				type: 'object',
				properties: {
					path: {
						type: 'string',
						description: 'Relative path for the new/overwritten file within the working directory.'
					},
					content: {
						type: 'string',
						description: 'The full text content to write to the file.'
					},
					overwrite: {
						type: 'boolean',
						description: 'Whether to overwrite if the file exists. Defaults to true.'
					}
				},
				required: ['path', 'content']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'fs_read_docx',
			description:
				'Extract text content from a Microsoft Word (.docx) file in the working directory. Returns plain text with paragraph breaks preserved.',
			parameters: {
				type: 'object',
				properties: {
					path: {
						type: 'string',
						description: 'Relative path to the .docx file within the working directory.'
					}
				},
				required: ['path']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'fs_read_xlsx',
			description:
				'Read data from an Excel spreadsheet (.xlsx) file in the working directory. Returns the data as CSV-formatted text. If the workbook has multiple sheets, specify one by name — otherwise the first sheet is returned and available sheet names are listed in the output header.',
			parameters: {
				type: 'object',
				properties: {
					path: {
						type: 'string',
						description: 'Relative path to the .xlsx file within the working directory.'
					},
					sheet: {
						type: 'string',
						description: 'Optional sheet name. If omitted, the first sheet is read.'
					}
				},
				required: ['path']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'fs_read_pdf',
			description:
				'Extract text content from a PDF file in the working directory. Returns the text from all pages. If the PDF is a scanned document without a text layer, this will fail — use fs_read_image on each page image instead (not yet supported for inline PDF pages).',
			parameters: {
				type: 'object',
				properties: {
					path: {
						type: 'string',
						description: 'Relative path to the PDF within the working directory.'
					}
				},
				required: ['path']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'fs_edit_text',
			description:
				'Edit a text file by replacing exactly one occurrence of old_str with new_str. The old_str must appear exactly once in the file — include enough surrounding context to make it unique. Use this for small targeted changes; for large rewrites use fs_write_text with overwrite.',
			parameters: {
				type: 'object',
				properties: {
					path: {
						type: 'string',
						description: 'Relative path to the file within the working directory.'
					},
					old_str: {
						type: 'string',
						description: 'The exact text to find and replace. Must be unique in the file.'
					},
					new_str: {
						type: 'string',
						description: 'The replacement text.'
					}
				},
				required: ['path', 'old_str', 'new_str']
			}
		}
	}
];

/**
 * Get the tools to expose to the agent for this request. Filesystem tools
 * are only included when a working directory is active — otherwise the
 * model cannot invoke them at all.
 */
export function getAgentTools(hasWorkingDir: boolean): ToolDefinition[] {
	if (hasWorkingDir) {
		return [...WEB_TOOLS, ...FS_TOOLS];
	}
	return WEB_TOOLS;
}

/** @deprecated Use getAgentTools(hasWorkingDir) instead. */
export const AGENT_TOOLS: ToolDefinition[] = WEB_TOOLS;
