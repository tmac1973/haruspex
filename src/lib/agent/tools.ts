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
	},
	{
		type: 'function',
		function: {
			name: 'image_search',
			description:
				'Search Wikimedia Commons for freely-licensed images matching a query. Returns a list of { title, url, thumb_url, width, height, mime, license, attribution, description_url }. All results are public domain or openly licensed (CC family) — safe to download and embed in a generated document or slide deck with attribution. Use this for "find me a picture of X" workflows where license safety matters, or when the user asks for stock-photo-style imagery (landmarks, animals, generic category shots). For a specific manufacturer product photo that only exists on the vendor\'s own website, use web_search + fetch_url_images instead.',
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
				'Fetch a web page and return a list of image URLs found on it — the `<img src>` elements plus <meta property="og:image"> and <link rel="image_src"> references. Relative URLs are resolved to absolute. Returns up to 50 results as { src, alt, width?, height? } objects. Use this for "find the product shot on the manufacturer\'s page" workflows: first web_search to find the right page, then fetch_url_images on that page to discover the image URLs, then fs_download_url to save one to the working directory. LICENSING NOTE: images found this way are usually copyrighted (manufacturer press assets, stock photos, user uploads on review sites). Unlike image_search which returns only Wikimedia Commons results with clear licenses, anything returned by fetch_url_images is the user\'s responsibility to use appropriately. Prefer image_search for generic/stock imagery and only use fetch_url_images when the user specifically wants content from a particular site.',
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
				'Create a printable PDF report. Write the content as a real document — flowing prose organized by section headings, the way a human analyst would write a report. This is NOT a chat response; the general "response format" preference DOES NOT apply here. Follow these rules instead.\n\nSTRUCTURE:\n- Section headings MUST use `#`, `##`, `###` prefixes. NEVER write section titles as `**Bold Text**` on their own line — those are inline emphasis, not headings, and they look broken.\n- A long report should have multiple `##` sections and sub-sections. Do not force page breaks; content flows across pages automatically. Do not use `---` as a page break — it does nothing useful.\n\nPROSE OVER BULLETS:\n- Write analysis, comparisons, overviews, and explanations as NARRATIVE PARAGRAPHS separated by blank lines. This is the default — aim for most of the document to be paragraphs.\n- `- item` bullet lists are allowed ONLY when the content is a genuine list of 3+ short, parallel items (e.g. "supported protocols", "installation steps", "pricing tiers"). A single sentence is a paragraph, not a bullet. A two-item "list" is also a paragraph.\n- Nested bullets: indent sub-items with exactly 2 spaces per level.\n\nTABLES:\n- Tables ARE supported and render as properly aligned columns in a monospace font. Use a standard GFM table when you have genuinely tabular data (comparison matrices, spec sheets, pricing tiers):\n  `| Header 1 | Header 2 | Header 3 |`\n  `| :--- | :--- | :--- |`\n  `| cell | cell | cell |`\n- Keep cell content short (1–4 words per cell). Long prose belongs in paragraphs, not table cells.\n- Limit to 4–5 columns max; anything wider gets cramped.\n\nINLINE FORMATTING:\n- `**bold**`, `*italic*`, `` `code` ``, `[text](url)` all render.\n- Images and block quotes do NOT render — do not include them.\n\nPage layout (US Letter, 20mm margins, Helvetica body, Courier tables) and word-wrapping are automatic. Use `fs_write_docx` instead when the user wants an editable Word document.',
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
				'Create an OpenDocument Text (.odt) file — the native format of LibreOffice Writer. Same rules as fs_write_docx: headings use `#`, `##`, `###` prefixes; body is flowing paragraphs separated by blank lines. Use this when the user specifically asks for an ODT / OpenDocument / LibreOffice-native file; otherwise fs_write_docx is a safer default (LibreOffice opens .docx fine).',
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
				'Create an OpenDocument Spreadsheet (.ods) file — the native format of LibreOffice Calc. Same sheet/row data shape as fs_write_xlsx (one or more sheets, each with a name and a 2D array of rows). Numeric strings become numeric cells; everything else is text. Use this when the user specifically asks for an ODS / OpenDocument / LibreOffice-native spreadsheet; otherwise fs_write_xlsx is a safer default (LibreOffice opens .xlsx fine).',
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
				'Create a PowerPoint presentation (.pptx). Each slide has a short title plus one of: a bullet list (content layout, default) or a big centered title for a section divider (section layout). Bullets support nesting up to 2 levels deep. Optional per-slide image from the working directory is rendered on the right half of content slides. Keep titles to ~8 words max and bullets to ~10 words each; 3–6 bullets per slide is ideal. Longer text will overflow.',
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
				'Create an OpenDocument Presentation (.odp) — the native presentation format of LibreOffice Impress. Same constrained API as fs_write_pptx: each slide has a title plus either bullets (content layout) or a big centered title (section layout), supports nested bullets (up to 2 levels) and optional per-slide images. Only use this when the user specifically asks for an ODP / OpenDocument / LibreOffice-native presentation; otherwise fs_write_pptx is the default (LibreOffice Impress opens .pptx fine).',
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
				'Download a file from a URL into the working directory. Works for any HTTP(S) URL — images (to embed in a presentation), PDFs, fonts, archives, office documents, media files, data files. The bytes are written to `path` relative to the working directory; the server sandbox prevents escapes. Executable formats (exe, msi, dll, app, pkg, dmg, deb, rpm, appimage, jar, bat, ps1, vbs, etc.) are blocked as a safety measure. Private/local URLs are blocked as SSRF protection. 50 MB size ceiling. Typical presentation flow: image_search or fetch_url_images → pick a URL → fs_download_url to save it locally → fs_write_pptx with `image: "the/saved/path.png"` on the slide.',
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
				'List recent email messages from the user\'s configured email accounts. Returns metadata only (subject, sender, date, short snippet) — no message bodies. Strongly prefer this as the first email tool call: the user almost always wants "recent email" or "email from X", not a specific message body. After seeing the listing, call email_summarize_message on the 3-5 messages that look most important (by sender importance, urgency, or relevance to the user\'s question) — do NOT try to summarize every message in the listing. Skip newsletters, automated notifications, and marketing unless the user specifically asked about them. Do not call this tool unless the user explicitly asked about email — never proactively check the inbox.',
			parameters: {
				type: 'object',
				properties: {
					account_id: {
						type: 'string',
						description:
							'Optional — target a specific account instead of querying every enabled one. Accepts EITHER the `accountId` UUID from a previous listing OR the human-readable account label (e.g. "Work Gmail", "Personal") exactly as the user sees it in Settings. Label matching is case-insensitive. Omit this field entirely to query all enabled accounts and merge the results by date — that\'s the right default for generic requests like "summarize my email". Only pass a selector when the user explicitly names an account.'
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
							'Upper bound on results. Default 25 — plenty of headroom for a typical inbox-day where most messages are newsletters and automated notifications. For multi-day windows ("this week") you may raise this to 50. The size of the listing is NOT the size of the digest: you are expected to filter the listing down to 3-5 actually-important messages and only summarize those. A larger listing helps you see the noise you can safely skip, not messages you need to summarize.'
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
				'Run a focused sub-agent that reads one full email body and returns a short 2-4 sentence summary covering who sent it, what it\'s about, and any action items. This is the default way to "read" an email — it compresses the body through a separate chat completion so the full message never enters your main context. Use it once per message you want to understand from a listing. For messages where you need the exact verbatim text (contracts, quotes, code snippets the user wants copy-pasted), use email_read_full instead. Each call processes a single message.',
			parameters: {
				type: 'object',
				properties: {
					account_id: {
						type: 'string',
						description:
							'Account selector for the message. Pass back the `accountId` UUID from the listing verbatim — that is always the safe choice. Case-insensitive label matching ("Work Gmail", "Personal") is also accepted if the model is routing by user-facing name.'
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
				'Escape hatch: fetch the full body of a single message verbatim. Use this only when a summary is not enough — the user asked to see the exact text, you need to quote a specific sentence, or the summarizer missed a detail. Prefer email_summarize_message for routine reads; full bodies are expensive on context. Each call processes a single message.',
			parameters: {
				type: 'object',
				properties: {
					account_id: {
						type: 'string',
						description:
							'Account selector for the message. Pass back the `accountId` UUID from the listing verbatim — that is always the safe choice. Case-insensitive label matching ("Work Gmail", "Personal") is also accepted.'
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

/** @deprecated Use getAgentTools(hasWorkingDir) instead. */
export const AGENT_TOOLS: ToolDefinition[] = WEB_TOOLS;
