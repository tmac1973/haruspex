import { invoke } from '@tauri-apps/api/core';
import { registerTool } from './registry';
import { toolResult, toolError } from './types';
import type { ToolExecOutput } from './types';
import { IMAGE_EXT_RE } from './fs-read';

/**
 * Outcome of pre-write conflict resolution. `null` means the user
 * canceled and the caller should return an error to the model.
 */
interface ResolvedWritePath {
	finalPath: string;
	overwrite: boolean;
}

/**
 * Check whether a write to `relPath` would clobber an existing file,
 * and if so, show the file-conflict modal to let the user pick.
 */
async function resolveWritePathInteractive(
	workdir: string,
	relPath: string,
	filesWrittenThisTurn: Set<string>
): Promise<ResolvedWritePath | null> {
	if (filesWrittenThisTurn.has(relPath)) {
		return { finalPath: relPath, overwrite: true };
	}

	let exists = false;
	try {
		exists = await invoke<boolean>('fs_path_exists', { workdir, relPath });
	} catch {
		exists = false;
	}
	if (!exists) {
		return { finalPath: relPath, overwrite: false };
	}

	const { askFileConflict } = await import('$lib/stores/fileConflict.svelte');
	const choice = await askFileConflict(relPath);
	if (choice === 'cancel') {
		return null;
	}
	if (choice === 'overwrite') {
		return { finalPath: relPath, overwrite: true };
	}
	try {
		const newPath = await invoke<string>('fs_find_available_path', { workdir, relPath });
		return { finalPath: newPath, overwrite: false };
	} catch (e) {
		console.error('fs_find_available_path failed:', e);
		return { finalPath: relPath, overwrite: true };
	}
}

function userCanceledWriteError(relPath: string, command: string): ToolExecOutput {
	return toolResult(
		toolError(
			`User canceled the ${command} write. The file "${relPath}" already exists in the working directory and the user chose to stop instead of overwriting or renaming. Do NOT retry automatically — stop what you were doing, briefly explain to the user that the file already exists, and ask them how they'd like to proceed (pick a different filename, overwrite the existing file, or skip the write entirely).`
		)
	);
}

/**
 * Generic write wrapper — deduplicates the resolve/invoke/track pattern
 * shared by all fs_write_* tools.
 */
async function fsWriteWithConflictCheck(
	command: string,
	workdir: string,
	relPath: string,
	payload: Record<string, unknown>,
	filesWrittenThisTurn: Set<string>
): Promise<ToolExecOutput> {
	const resolved = await resolveWritePathInteractive(workdir, relPath, filesWrittenThisTurn);
	if (!resolved) return userCanceledWriteError(relPath, command);
	try {
		await invoke(command, {
			workdir,
			relPath: resolved.finalPath,
			...payload,
			overwrite: resolved.overwrite
		});
		filesWrittenThisTurn.add(resolved.finalPath);
		return toolResult(`Wrote: ${resolved.finalPath}`);
	} catch (e) {
		return toolResult(toolError(`${command} failed: ${e}`));
	}
}

// Shared slide schema used by both pptx and odp
const SLIDE_SCHEMA = {
	type: 'array' as const,
	description: 'Array of slide objects.',
	items: {
		type: 'object' as const,
		properties: {
			title: {
				type: 'string' as const,
				description: 'Short slide title (~8 words max).'
			},
			layout: {
				type: 'string' as const,
				enum: ['content', 'section'],
				description:
					'"content" (default): title + bullets (+ optional image). "section": big centered title used as a divider; put the section headline in `title` and an optional short tagline in `subtitle`.'
			},
			subtitle: {
				type: 'string' as const,
				description: 'Optional short tagline shown below the main title on section slides.'
			},
			bullets: {
				type: 'array' as const,
				description:
					'Bullet points for content slides. Each entry is either a plain string (level 0) or an object { "text": "...", "level": 0|1|2 } for nested bullets.',
				items: {
					oneOf: [
						{ type: 'string' as const },
						{
							type: 'object' as const,
							properties: {
								text: { type: 'string' as const },
								level: {
									type: 'integer' as const,
									minimum: 0,
									maximum: 2,
									description: 'Indent depth. 0 = top level, 1 = sub-bullet, 2 = sub-sub-bullet.'
								}
							},
							required: ['text']
						}
					]
				}
			},
			image: {
				type: 'string' as const,
				description:
					'Optional relative path to an image file inside the working directory (png/jpg/jpeg/gif).'
			}
		},
		required: ['title']
	}
};

// --- Registration ---

registerTool({
	category: 'fs',
	schema: {
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
	displayLabel: (args) => (args.path as string) || '',
	async execute(args, ctx) {
		return fsWriteWithConflictCheck(
			'fs_write_text',
			ctx.workingDir!,
			args.path as string,
			{ content: args.content },
			ctx.filesWrittenThisTurn
		);
	}
});

registerTool({
	category: 'fs',
	schema: {
		type: 'function',
		function: {
			name: 'fs_write_docx',
			description:
				'Create a Microsoft Word (.docx) file in the working directory from text content. The content is split into paragraphs on newlines. Lines starting with # become Heading 1, ## become Heading 2, ### become Heading 3. Everything else is regular body text.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Relative path for the new .docx file.' },
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
	displayLabel: (args) => (args.path as string) || '',
	async execute(args, ctx) {
		return fsWriteWithConflictCheck(
			'fs_write_docx',
			ctx.workingDir!,
			args.path as string,
			{ content: args.content },
			ctx.filesWrittenThisTurn
		);
	}
});

registerTool({
	category: 'fs',
	schema: {
		type: 'function',
		function: {
			name: 'fs_write_pdf',
			description:
				'Create a PDF report from markdown content. Use # / ## / ### for headings. Supports bold, italic, code, bullet lists, and markdown tables. Write flowing prose organized by sections — prefer paragraphs over bullet lists.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Relative path for the new .pdf file.' },
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
	displayLabel: (args) => (args.path as string) || '',
	async execute(args, ctx) {
		return fsWriteWithConflictCheck(
			'fs_write_pdf',
			ctx.workingDir!,
			args.path as string,
			{ content: args.content },
			ctx.filesWrittenThisTurn
		);
	}
});

registerTool({
	category: 'fs',
	schema: {
		type: 'function',
		function: {
			name: 'fs_write_xlsx',
			description:
				'Create an Excel spreadsheet (.xlsx) file in the working directory. Provide one or more sheets, each with a name and a 2D array of rows. Numeric strings are written as numbers; everything else is written as text.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Relative path for the new .xlsx file.' },
					sheets: {
						type: 'array',
						description: 'Array of sheet objects. Each sheet needs a name and rows.',
						items: {
							type: 'object',
							properties: {
								name: { type: 'string', description: 'Sheet name (tab label)' },
								rows: {
									type: 'array',
									description: '2D array: array of rows, each row is an array of cell values.',
									items: { type: 'array', items: { type: 'string' } }
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
	displayLabel: (args) => (args.path as string) || '',
	async execute(args, ctx) {
		return fsWriteWithConflictCheck(
			'fs_write_xlsx',
			ctx.workingDir!,
			args.path as string,
			{ sheets: args.sheets },
			ctx.filesWrittenThisTurn
		);
	}
});

registerTool({
	category: 'fs',
	schema: {
		type: 'function',
		function: {
			name: 'fs_write_odt',
			description:
				'Create an OpenDocument Text (.odt) file for LibreOffice Writer. Same API as fs_write_docx. Only use when the user asks for ODT specifically.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Relative path for the new .odt file.' },
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
	displayLabel: (args) => (args.path as string) || '',
	async execute(args, ctx) {
		return fsWriteWithConflictCheck(
			'fs_write_odt',
			ctx.workingDir!,
			args.path as string,
			{ content: args.content },
			ctx.filesWrittenThisTurn
		);
	}
});

registerTool({
	category: 'fs',
	schema: {
		type: 'function',
		function: {
			name: 'fs_write_ods',
			description:
				'Create an OpenDocument Spreadsheet (.ods) for LibreOffice Calc. Same API as fs_write_xlsx. Only use when the user asks for ODS specifically.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Relative path for the new .ods file.' },
					sheets: {
						type: 'array',
						description: 'Array of sheet objects. Each sheet needs a name and rows.',
						items: {
							type: 'object',
							properties: {
								name: { type: 'string', description: 'Sheet name (tab label)' },
								rows: {
									type: 'array',
									description: '2D array: array of rows, each row is an array of cell values.',
									items: { type: 'array', items: { type: 'string' } }
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
	displayLabel: (args) => (args.path as string) || '',
	async execute(args, ctx) {
		return fsWriteWithConflictCheck(
			'fs_write_ods',
			ctx.workingDir!,
			args.path as string,
			{ sheets: args.sheets },
			ctx.filesWrittenThisTurn
		);
	}
});

registerTool({
	category: 'fs',
	schema: {
		type: 'function',
		function: {
			name: 'fs_write_pptx',
			description:
				'Create a PowerPoint presentation. Each slide has a title and optional bullets (strings or {text, level} for nesting). Use layout "section" for divider slides. Optional per-slide image path from the working directory.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Relative path for the new .pptx file.' },
					slides: SLIDE_SCHEMA
				},
				required: ['path', 'slides']
			}
		}
	},
	displayLabel: (args) => (args.path as string) || '',
	async execute(args, ctx) {
		return fsWriteWithConflictCheck(
			'fs_write_pptx',
			ctx.workingDir!,
			args.path as string,
			{ slides: args.slides },
			ctx.filesWrittenThisTurn
		);
	}
});

registerTool({
	category: 'fs',
	schema: {
		type: 'function',
		function: {
			name: 'fs_write_odp',
			description:
				'Create an OpenDocument Presentation (.odp) for LibreOffice Impress. Same API as fs_write_pptx. Only use when the user asks for ODP specifically.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Relative path for the new .odp file.' },
					slides: SLIDE_SCHEMA
				},
				required: ['path', 'slides']
			}
		}
	},
	displayLabel: (args) => (args.path as string) || '',
	async execute(args, ctx) {
		return fsWriteWithConflictCheck(
			'fs_write_odp',
			ctx.workingDir!,
			args.path as string,
			{ slides: args.slides },
			ctx.filesWrittenThisTurn
		);
	}
});

registerTool({
	category: 'fs',
	schema: {
		type: 'function',
		function: {
			name: 'fs_download_url',
			description:
				'Download a file from a URL into the working directory. 50 MB limit. Executable formats are blocked.',
			parameters: {
				type: 'object',
				properties: {
					url: { type: 'string', description: 'The HTTP(S) URL to download.' },
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
	displayLabel: (args) => {
		const path = (args.path as string) || '';
		const url = (args.url as string) || '';
		return path ? `${path} (${url})` : url;
	},
	async execute(args, ctx) {
		const url = args.url as string;
		const relPath = args.path as string;
		const resolved = await resolveWritePathInteractive(
			ctx.workingDir!,
			relPath,
			ctx.filesWrittenThisTurn
		);
		if (!resolved) return userCanceledWriteError(relPath, 'fs_download_url');
		try {
			const message = await invoke<string>('fs_download_url', {
				workdir: ctx.workingDir,
				url,
				relPath: resolved.finalPath,
				overwrite: resolved.overwrite
			});
			ctx.filesWrittenThisTurn.add(resolved.finalPath);
			let thumbDataUrl: string | undefined;
			if (IMAGE_EXT_RE.test(resolved.finalPath)) {
				try {
					thumbDataUrl = await invoke<string>('fs_read_image', {
						workdir: ctx.workingDir,
						relPath: resolved.finalPath
					});
				} catch {
					// Thumbnail is best-effort
				}
			}
			return { result: message, thumbDataUrl };
		} catch (e) {
			return toolResult(toolError(`fs_download_url failed: ${e}`));
		}
	}
});

registerTool({
	category: 'fs',
	schema: {
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
	},
	displayLabel: (args) => (args.path as string) || '',
	async execute(args, ctx) {
		try {
			await invoke('fs_edit_text', {
				workdir: ctx.workingDir,
				relPath: args.path as string,
				oldStr: args.old_str as string,
				newStr: args.new_str as string
			});
			return toolResult(`Edited ${args.path}`);
		} catch (e) {
			return toolResult(toolError(`fs_edit_text failed: ${e}`));
		}
	}
});
