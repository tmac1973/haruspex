import type { ToolDefinition } from '$lib/api';
import { hasEnabledEmailAccount } from '$lib/stores/settings';

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
				'Read a web page through a focused research assistant that extracts only the information relevant to a specific question. Returns concise findings instead of the full page text. Preferred over fetch_url when researching across multiple sources — dramatically reduces context usage per page.',
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
	},
	{
		type: 'function',
		function: {
			name: 'image_search',
			description:
				'Search Wikimedia Commons for freely-licensed images. Returns image metadata including url, thumbnail, dimensions, and license. All results are openly licensed — safe to embed in documents or presentations.',
			parameters: {
				type: 'object',
				properties: {
					query: {
						type: 'string',
						description:
							'What to search for. Plain English works ("Eiffel Tower at night", "red panda", "vintage motorcycle").'
					},
					max_results: {
						type: 'integer',
						minimum: 1,
						maximum: 20,
						description: 'How many results to return. Defaults to 5. Cap is 20.'
					}
				},
				required: ['query']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'fetch_url_images',
			description:
				'Fetch a web page and return a list of image URLs found on it (img tags, og:image, etc.). Returns up to 50 results as { src, alt, width?, height? } objects. Use this to find images on a specific page, e.g. product photos from a manufacturer site.',
			parameters: {
				type: 'object',
				properties: {
					url: {
						type: 'string',
						description: 'The URL of the page to scan for images.'
					}
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
				'Render PDF pages as images for visual reading. Use this for form PDFs, scanned documents, or when fs_read_pdf gives garbled output. Process one PDF at a time — respond before loading the next. Renders up to 5 pages.',
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
				'Create a PDF report from markdown content. Use # / ## / ### for headings. Supports bold, italic, code, bullet lists, and markdown tables. Write flowing prose organized by sections — prefer paragraphs over bullet lists.',
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
							'Report content as markdown-style text. Headings use `#`/`##`/`###` (never `**Bold**` alone). Body is flowing paragraphs separated by blank lines. `- item` bullets ONLY for lists of 3+ related items. Markdown tables render as real tables — use them for genuinely tabular data with short cell contents. Do not use `---` for page breaks; page flow is automatic.'
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
			name: 'fs_write_odt',
			description:
				'Create an OpenDocument Text (.odt) file for LibreOffice Writer. Same API as fs_write_docx. Only use when the user asks for ODT specifically.',
			parameters: {
				type: 'object',
				properties: {
					path: {
						type: 'string',
						description: 'Relative path for the new .odt file.'
					},
					content: {
						type: 'string',
						description:
							'Text content. Use newlines between paragraphs. Prefix lines with # / ## / ### for headings.'
					}
				},
				required: ['path', 'content']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'fs_write_ods',
			description:
				'Create an OpenDocument Spreadsheet (.ods) for LibreOffice Calc. Same API as fs_write_xlsx. Only use when the user asks for ODS specifically.',
			parameters: {
				type: 'object',
				properties: {
					path: {
						type: 'string',
						description: 'Relative path for the new .ods file.'
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
			name: 'fs_write_pptx',
			description:
				'Create a PowerPoint presentation. Each slide has a title and optional bullets (strings or {text, level} for nesting). Use layout "section" for divider slides. Optional per-slide image path from the working directory.',
			parameters: {
				type: 'object',
				properties: {
					path: {
						type: 'string',
						description: 'Relative path for the new .pptx file.'
					},
					slides: {
						type: 'array',
						description: 'Array of slide objects.',
						items: {
							type: 'object',
							properties: {
								title: {
									type: 'string',
									description: 'Short slide title (~8 words max).'
								},
								layout: {
									type: 'string',
									enum: ['content', 'section'],
									description:
										'"content" (default): title + bullets (+ optional image). "section": big centered title used as a divider between groups of content slides; put the section headline in `title` and an optional short tagline in `subtitle`. Section slides have no bullets.'
								},
								subtitle: {
									type: 'string',
									description:
										'Optional short tagline shown below the main title on section slides. Ignored on content slides.'
								},
								bullets: {
									type: 'array',
									description:
										'Bullet points for content slides. Each entry is either a plain string (level 0) or an object { "text": "...", "level": 0|1|2 } for nested bullets. Use sub-levels sparingly — levels beyond 2 are clamped. Pass an empty array for a title-only content slide.',
									items: {
										oneOf: [
											{ type: 'string' },
											{
												type: 'object',
												properties: {
													text: { type: 'string' },
													level: {
														type: 'integer',
														minimum: 0,
														maximum: 2,
														description:
															'Indent depth. 0 = top level, 1 = sub-bullet, 2 = sub-sub-bullet.'
													}
												},
												required: ['text']
											}
										]
									}
								},
								image: {
									type: 'string',
									description:
										'Optional relative path (inside the working directory) to an image file to embed on this slide. Supported formats: png, jpg, jpeg, gif. When set, bullets occupy the left half of the slide and the image the right half. Only applies to content layout.'
								}
							},
							required: ['title']
						}
					}
				},
				required: ['path', 'slides']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'fs_write_odp',
			description:
				'Create an OpenDocument Presentation (.odp) for LibreOffice Impress. Same API as fs_write_pptx. Only use when the user asks for ODP specifically.',
			parameters: {
				type: 'object',
				properties: {
					path: {
						type: 'string',
						description: 'Relative path for the new .odp file.'
					},
					slides: {
						type: 'array',
						description: 'Array of slide objects.',
						items: {
							type: 'object',
							properties: {
								title: {
									type: 'string',
									description: 'Short slide title (~8 words max).'
								},
								layout: {
									type: 'string',
									enum: ['content', 'section'],
									description:
										'"content" (default): title + bullets (+ optional image). "section": big centered title used as a divider; put the section headline in `title` and an optional short tagline in `subtitle`.'
								},
								subtitle: {
									type: 'string',
									description:
										'Optional short tagline shown below the main title on section slides.'
								},
								bullets: {
									type: 'array',
									description:
										'Bullet points for content slides. Each entry is either a plain string (level 0) or an object { "text": "...", "level": 0|1|2 } for nested bullets.',
									items: {
										oneOf: [
											{ type: 'string' },
											{
												type: 'object',
												properties: {
													text: { type: 'string' },
													level: {
														type: 'integer',
														minimum: 0,
														maximum: 2,
														description:
															'Indent depth. 0 = top level, 1 = sub-bullet, 2 = sub-sub-bullet.'
													}
												},
												required: ['text']
											}
										]
									}
								},
								image: {
									type: 'string',
									description:
										'Optional relative path to an image file inside the working directory (png/jpg/jpeg/gif). When set, bullets occupy the left half of a content slide and the image the right half.'
								}
							},
							required: ['title']
						}
					}
				},
				required: ['path', 'slides']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'fs_download_url',
			description:
				'Download a file from a URL into the working directory. 50 MB limit. Executable formats are blocked.',
			parameters: {
				type: 'object',
				properties: {
					url: {
						type: 'string',
						description: 'The HTTP(S) URL to download.'
					},
					path: {
						type: 'string',
						description:
							'Relative path (inside the working directory) where the downloaded file should be written. Include the file extension — it determines whether the download is allowed (e.g. images/hero.png is fine, installer.exe is blocked).'
					}
				},
				required: ['url', 'path']
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

const EMAIL_TOOLS: ToolDefinition[] = [
	{
		type: 'function',
		function: {
			name: 'email_list_recent',
			description:
				'List recent email messages. Returns metadata only (subject, sender, date, snippet) — no bodies. Omit account_id to query all enabled accounts.',
			parameters: {
				type: 'object',
				properties: {
					account_id: {
						type: 'string',
						description:
							'Optional — target a specific account by accountId UUID or label. Omit to query all enabled accounts.'
					},
					hours: {
						type: 'integer',
						minimum: 1,
						description:
							'Only return messages from the last N hours. Use this for "recent" / "today" / "in the last few hours" requests.'
					},
					since_date: {
						type: 'string',
						description:
							'Alternative date floor in IMAP SINCE format (e.g. "10-Apr-2026"). Mutually exclusive with hours; if both are set, hours wins.'
					},
					from: {
						type: 'string',
						description:
							'Substring filter on the sender. Matched case-insensitively against the From header. Example: "alice" or "example.com".'
					},
					subject_contains: {
						type: 'string',
						description: 'Substring filter on the Subject header. Case-insensitive.'
					},
					max_results: {
						type: 'integer',
						minimum: 1,
						maximum: 50,
						description:
							'Upper bound on results. Default 25. Raise to 50 for multi-day windows.'
					}
				}
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'email_summarize_message',
			description:
				'Summarize a single email message via a focused sub-agent. Returns a 2-4 sentence summary covering sender, topic, and action items.',
			parameters: {
				type: 'object',
				properties: {
					account_id: {
						type: 'string',
						description:
							'Account selector — pass the accountId from the listing.'
					},
					message_id: {
						type: 'string',
						description: 'The id of the specific message to summarize (from the listing).'
					},
					focus: {
						type: 'string',
						description:
							'Optional — a specific question to bias the summary toward ("what action does the sender want?", "is there a deadline mentioned?"). Leave blank for a general summary.'
					}
				},
				required: ['account_id', 'message_id']
			}
		}
	},
	{
		type: 'function',
		function: {
			name: 'email_read_full',
			description:
				'Fetch the full body of a single message verbatim. Use only when the user needs exact text or the summary was insufficient.',
			parameters: {
				type: 'object',
				properties: {
					account_id: {
						type: 'string',
						description:
							'Account selector — pass the accountId from the listing.'
					},
					message_id: {
						type: 'string',
						description: 'The id of the specific message to read (from the listing).'
					}
				},
				required: ['account_id', 'message_id']
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
/**
 * Set of filesystem tool names that require the model to have vision
 * capability. These load image bytes into the next turn's user message
 * via `pendingImages`, and sending an image to a text-only model gets
 * rejected server-side (or silently ignored). When the active backend
 * is known to be text-only, we filter them out of the tool list so the
 * model never attempts the call in the first place.
 */
const VISION_DEPENDENT_TOOLS = new Set(['fs_read_image', 'fs_read_pdf_pages']);

export function getAgentTools(
	hasWorkingDir: boolean,
	deepResearch: boolean = false,
	visionSupported: boolean = true
): ToolDefinition[] {
	const webTools = deepResearch
		? WEB_TOOLS.filter((t) => t.function.name !== 'fetch_url')
		: WEB_TOOLS;
	const tools: ToolDefinition[] = [...webTools];
	if (hasWorkingDir) {
		const fsTools = visionSupported
			? FS_TOOLS
			: FS_TOOLS.filter((t) => !VISION_DEPENDENT_TOOLS.has(t.function.name));
		tools.push(...fsTools);
	}
	// Email tools are completely hidden until the user has enabled at
	// least one account in Settings. The model never sees descriptions
	// for an integration that isn't usable — it can't accidentally call
	// them, and we don't waste prompt tokens on them.
	if (hasEnabledEmailAccount()) {
		tools.push(...EMAIL_TOOLS);
	}
	return tools;
}
