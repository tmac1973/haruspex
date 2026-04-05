// Render PDF pages to image data URLs using PDF.js.
// Used as a vision fallback when text extraction is insufficient —
// especially for form PDFs, scanned documents, or PDFs with custom fonts
// that confuse pure-text extractors.

import { invoke } from '@tauri-apps/api/core';

// PDF.js worker is bundled by Vite. We import the worker as a URL.
import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

const MAX_PAGES = 20; // Don't blow up the context with huge PDFs
const RENDER_SCALE = 2.0; // 2x for readable text at the vision model's resolution
const MAX_DIMENSION = 1600; // Cap long side to match image tool

function base64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) {
		bytes[i] = bin.charCodeAt(i);
	}
	return bytes;
}

/**
 * Load a PDF from the working directory via the sandboxed Rust command,
 * render each page to a JPEG data URL, and return the list.
 */
export async function renderPdfPages(workdir: string, relPath: string): Promise<string[]> {
	// Get PDF bytes from the Rust side (sandboxed)
	const b64 = await invoke<string>('fs_read_pdf_bytes', { workdir, relPath });
	const bytes = base64ToBytes(b64);

	const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
	const pageCount = Math.min(pdf.numPages, MAX_PAGES);
	const pages: string[] = [];

	for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
		const page = await pdf.getPage(pageNum);

		// Compute a scale that keeps the long side within MAX_DIMENSION
		const unscaledViewport = page.getViewport({ scale: 1.0 });
		const longSide = Math.max(unscaledViewport.width, unscaledViewport.height);
		let scale = RENDER_SCALE;
		if (longSide * scale > MAX_DIMENSION) {
			scale = MAX_DIMENSION / longSide;
		}

		const viewport = page.getViewport({ scale });
		const canvas = document.createElement('canvas');
		canvas.width = Math.ceil(viewport.width);
		canvas.height = Math.ceil(viewport.height);
		const ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('Failed to get canvas context');

		// White background for pages (PDFs can be transparent)
		ctx.fillStyle = '#ffffff';
		ctx.fillRect(0, 0, canvas.width, canvas.height);

		await page.render({ canvasContext: ctx, viewport, canvas }).promise;

		// JPEG at 0.85 quality — smaller payload than PNG for vision model input
		const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
		pages.push(dataUrl);

		page.cleanup();
	}

	await pdf.destroy();
	return pages;
}

export function pdfPageCountNotice(totalPages: number, rendered: number): string {
	if (totalPages > rendered) {
		return ` (showing first ${rendered} of ${totalPages} pages)`;
	}
	return '';
}
