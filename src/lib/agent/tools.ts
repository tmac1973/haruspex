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
				'Fetch and extract the raw text content from a web page URL. Use this when you need to see the full page text yourself — for example, structured data, code samples, or content where you cannot describe in advance what is relevant. For research questions where you only need the parts of a page that answer a specific question, prefer research_url instead — it is much cheaper on context.',
			parameters: {
				type: 'object',
				properties: {
					url: { type: 'string', description: 'The URL to fetch' }
				},
				required: ['url']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'research_url',
			description:
				'Read a web page through a focused research assistant that extracts only the information relevant to a specific question or focus, and returns concise findings instead of the full page text. Strongly preferred over fetch_url when researching a topic across multiple sources, because it dramatically reduces how much context each page consumes — letting you fan out across many more sources before running out of room. Each call processes one URL. The focus parameter tells the assistant what to look for; be specific (e.g. "pricing tiers and free plan limits", "criticisms or downsides", "verbatim quotes about deployment latency") rather than vague.',
			parameters: {
				type: 'object',
				properties: {
					url: { type: 'string', description: 'The URL to research' },
					focus: {
						type: 'string',
						description:
							'What information to look for on this page. Be specific — this is the question the research assistant will try to answer using only this single page.'
					}
				},
				required: ['url', 'focus']
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
			name: 'fs_read_image',
			description:
				'Load an image file (png, jpg, webp, etc.) from the working directory so you can see it with your vision capability. After calling this, the image is added to the conversation and you can describe it or answer questions about it in your next response. Use this for any image file the user asks you to analyze.',
			parameters: {
				type: 'object',
				properties: {
					path: {
						type: 'string',
						description: 'Relative path to the image file within the working directory.'
					}
				},
				required: ['path']
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
				'Extract text content from a PDF file in the working directory. Fast but only works for PDFs with a proper text layer. For form PDFs (W-2, 1040, IRS forms, etc.), scanned documents, or when text extraction produces garbled output, use fs_read_pdf_pages instead to read the PDF visually.',
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
			name: 'fs_read_pdf_pages',
			description:
				'Render pages of a PDF as images so you can see them with your vision capability. Use this for form PDFs (tax forms, applications, receipts, etc.), scanned documents, or any PDF where fs_read_pdf gave garbled or incomplete output. IMPORTANT: only call this for ONE PDF at a time and respond about it before calling it for another PDF — loading images from multiple PDFs in the same turn can exhaust the model context. Only the first 5 pages of a PDF are rendered; for longer PDFs, tell the user to split it or ask about specific pages.',
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
			name: 'fs_write_docx',
			description:
				'Create a Microsoft Word (.docx) file in the working directory from text content. The content is split into paragraphs on newlines. Lines starting with # become Heading 1, ## become Heading 2, ### become Heading 3. Everything else is regular body text.',
			parameters: {
				type: 'object',
				properties: {
					path: {
						type: 'string',
						description: 'Relative path for the new .docx file.'
					},
					content: {
						type: 'string',
						description:
							'Text content for the document. Use newlines between paragraphs. Prefix lines with # / ## / ### for headings.'
					}
				},
				required: ['path', 'content']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'fs_write_pdf',
			description:
				'Create a PDF file in the working directory from text content. The content is split into paragraphs on newlines. Lines starting with # become Heading 1, ## become Heading 2, ### become Heading 3. Long lines are word-wrapped automatically and content flows across pages (US Letter, 20mm margins, Helvetica). Use this for printable reports and documents; use fs_write_docx when the user wants an editable Word document.',
			parameters: {
				type: 'object',
				properties: {
					path: {
						type: 'string',
						description: 'Relative path for the new .pdf file.'
					},
					content: {
						type: 'string',
						description:
							'Text content for the document. Use newlines between paragraphs. Prefix lines with # / ## / ### for headings.'
					}
				},
				required: ['path', 'content']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'fs_write_xlsx',
			description:
				'Create an Excel spreadsheet (.xlsx) file in the working directory. Provide one or more sheets, each with a name and a 2D array of rows. Numeric strings are written as numbers; everything else is written as text.',
			parameters: {
				type: 'object',
				properties: {
					path: {
						type: 'string',
						description: 'Relative path for the new .xlsx file.'
					},
					sheets: {
						type: 'array',
						description: 'Array of sheet objects. Each sheet needs a name and rows.',
						items: {
							type: 'object',
							properties: {
								name: { type: 'string', description: 'Sheet name (tab label)' },
								rows: {
									type: 'array',
									description:
										'2D array: array of rows, each row is an array of cell values (strings).',
									items: {
										type: 'array',
										items: { type: 'string' }
									}
								}
							},
							required: ['name', 'rows']
						}
					}
				},
				required: ['path', 'sheets']
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
 * Get the tools to expose to the agent for this request.
 *
 * - Filesystem tools are only included when a working directory is active.
 * - In deep-research mode, fetch_url is removed from the tool list so the
 *   model is forced to use research_url for every source. This guarantees
 *   each page goes through the sub-agent compression path, which is the
 *   only way deep research can fan out across many sources without
 *   blowing the main context window. Outside deep-research mode both
 *   tools remain available so normal chat can grab raw page text when
 *   that's actually what's wanted.
 */
export function getAgentTools(
	hasWorkingDir: boolean,
	deepResearch: boolean = false
): ToolDefinition[] {
	const webTools = deepResearch
		? WEB_TOOLS.filter((t) => t.function.name !== 'fetch_url')
		: WEB_TOOLS;
	if (hasWorkingDir) {
		return [...webTools, ...FS_TOOLS];
	}
	return webTools;
}

/** @deprecated Use getAgentTools(hasWorkingDir) instead. */
export const AGENT_TOOLS: ToolDefinition[] = WEB_TOOLS;
