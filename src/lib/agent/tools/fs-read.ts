import { invoke } from '@tauri-apps/api/core';
import { registerTool } from './registry';
import { toolResult, toolError } from './types';

// Max images per turn. Each ~1024px image is ~500-800 image tokens for
// Qwen3.5-9B vision; batching more than this at once risks blowing out
// the KV cache and crashing llama-server.
const MAX_PENDING_IMAGES = 6;

// Regex for file extensions we can preview as a thumbnail inline.
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|ico|tiff?)$/i;
export { IMAGE_EXT_RE };

interface DirListing {
	path: string;
	entries: Array<{ name: string; is_dir: boolean; size: number }>;
	truncated: boolean;
}

function formatDirListing(listing: DirListing): string {
	const lines: string[] = [`Directory: ${listing.path}`];
	if (listing.entries.length === 0) {
		lines.push('(empty)');
	}
	for (const entry of listing.entries) {
		const marker = entry.is_dir ? '[DIR] ' : '      ';
		const size = entry.is_dir ? '' : ` (${entry.size} bytes)`;
		lines.push(`${marker}${entry.name}${size}`);
	}
	if (listing.truncated) {
		lines.push('... (listing truncated; more than 500 entries)');
	}
	return lines.join('\n');
}

/** Generic read wrapper — deduplicates the identical try/catch/invoke pattern. */
async function fsRead(
	command: string,
	workdir: string,
	relPath: string,
	extra?: Record<string, unknown>
): Promise<string> {
	try {
		return await invoke<string>(command, { workdir, relPath, ...extra });
	} catch (e) {
		return toolError(`${command} failed: ${e}`);
	}
}

// --- Registration ---

registerTool({
	category: 'fs',
	schema: {
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
	displayLabel: (args) => (args.path as string) || '.',
	async execute(args, ctx) {
		try {
			const listing = await invoke<DirListing>('fs_list_dir', {
				workdir: ctx.workingDir,
				relPath: (args.path as string) ?? '.'
			});
			return toolResult(formatDirListing(listing));
		} catch (e) {
			return toolResult(toolError(`fs_list_dir failed: ${e}`));
		}
	}
});

registerTool({
	category: 'fs',
	schema: {
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
	displayLabel: (args) => (args.path as string) || '',
	async execute(args, ctx) {
		return toolResult(await fsRead('fs_read_text', ctx.workingDir!, args.path as string));
	}
});

registerTool({
	category: 'fs',
	schema: {
		type: 'function',
		function: {
			name: 'fs_read_pdf',
			description:
				'Extract text content from a PDF file in the working directory. Fast but only works for PDFs with a proper text layer. For form PDFs, scanned documents, or when text extraction produces garbled output, use fs_read_pdf_pages instead to read the PDF visually.',
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
	displayLabel: (args) => (args.path as string) || '',
	async execute(args, ctx) {
		return toolResult(await fsRead('fs_read_pdf', ctx.workingDir!, args.path as string));
	}
});

registerTool({
	category: 'fs',
	requiresVision: true,
	schema: {
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
	displayLabel: (args) => (args.path as string) || '',
	async execute(args, ctx) {
		if (ctx.pendingImages.length > 0) {
			return toolResult(
				toolError(
					`You already have ${ctx.pendingImages.length} image(s) pending. Respond about them first, then call fs_read_pdf_pages for the next PDF. Loading multiple PDFs as images in one turn crashes the inference server.`
				)
			);
		}
		try {
			const { renderPdfPages } = await import('$lib/agent/pdf-render');
			const pages = await renderPdfPages(ctx.workingDir!, args.path as string);
			for (let i = 0; i < pages.length; i++) {
				ctx.pendingImages.push({
					path: `${args.path}#page${i + 1}`,
					dataUrl: pages[i]
				});
			}
			return toolResult(
				`Rendered ${pages.length} page${pages.length === 1 ? '' : 's'} of ${args.path} as images. You can now see the pages in your next response — read form fields, labels, values, and layout directly.`
			);
		} catch (e) {
			return toolResult(toolError(`fs_read_pdf_pages failed: ${e}`));
		}
	}
});

registerTool({
	category: 'fs',
	schema: {
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
	displayLabel: (args) => (args.path as string) || '',
	async execute(args, ctx) {
		return toolResult(await fsRead('fs_read_docx', ctx.workingDir!, args.path as string));
	}
});

registerTool({
	category: 'fs',
	schema: {
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
	displayLabel: (args) => {
		const path = (args.path as string) || '';
		const sheet = args.sheet as string | undefined;
		return sheet ? `${path} (${sheet})` : path;
	},
	async execute(args, ctx) {
		return toolResult(
			await fsRead('fs_read_xlsx', ctx.workingDir!, args.path as string, {
				sheet: args.sheet
			})
		);
	}
});

registerTool({
	category: 'fs',
	requiresVision: true,
	schema: {
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
	displayLabel: (args) => (args.path as string) || '',
	async execute(args, ctx) {
		if (ctx.pendingImages.length >= MAX_PENDING_IMAGES) {
			return toolResult(
				toolError(
					`Too many images pending (${ctx.pendingImages.length}). Respond about the images you've already loaded before loading more — loading too many images in one turn exhausts the model context and crashes inference.`
				)
			);
		}
		try {
			const dataUrl = await invoke<string>('fs_read_image', {
				workdir: ctx.workingDir,
				relPath: args.path as string
			});
			ctx.pendingImages.push({ path: args.path as string, dataUrl });
			return {
				result: `Image loaded: ${args.path}. You can now see it — describe or analyze it in your next response.`,
				thumbDataUrl: dataUrl
			};
		} catch (e) {
			return toolResult(toolError(`fs_read_image failed: ${e}`));
		}
	}
});
