// Render PDF pages to image data URLs using PDF.js.
// Used as a vision fallback when text extraction is insufficient —
// especially for form PDFs, scanned documents, or PDFs with custom fonts
// that confuse pure-text extractors.

import { invoke } from '@tauri-apps/api/core';
import { base64ToBytes } from '#lib/utils/base64.ts';
import { cellOrigin, planSheets } from '#lib/slides/sheets.ts';
import type { SheetPlan } from '#lib/slides/sheets.ts';

// PDF.js worker is bundled by Vite. We import the worker as a URL.
import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

// Rendering parameters tuned for form PDFs where small text legibility
// matters (tax forms, invoices, receipts). 1536px gives enough resolution
// for the vision model to read 8-10pt form text reliably. MAX_PAGES is
// kept tight since each high-res page takes ~1200-1600 image tokens.
// The one-PDF-per-turn enforcement in search.ts prevents multiple calls
// from stacking images and crashing llama-server.
const MAX_PAGES = 3;
const RENDER_SCALE = 2.0;
const MAX_DIMENSION = 1536;
const JPEG_QUALITY = 0.92;

/**
 * Load a PDF from the working directory via the sandboxed Rust command,
 * render each page to a JPEG data URL, and return the list.
 */
export async function renderPdfPages(workdir: string, relPath: string): Promise<string[]> {
	// Get PDF bytes from the Rust side (sandboxed)
	const b64 = await invoke<string>('fs_read_pdf_bytes', { workdir, relPath });
	const bytes = base64ToBytes(b64);

	// The loading task owns the document and its worker; destroying it frees
	// both, including when a page fails to render.
	const task = pdfjsLib.getDocument({ data: bytes });
	try {
		return await renderPages(await task.promise);
	} finally {
		await task.destroy();
	}
}

async function renderPages(pdf: pdfjsLib.PDFDocumentProxy): Promise<string[]> {
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

		// High-quality JPEG — lower quality blurs small digits and punctuation
		// (a decimal point can shift with aggressive chroma subsampling).
		const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
		pages.push(dataUrl);

		page.cleanup();
	}
	return pages;
}

/**
 * Render a slide deck's PDF as contact sheets (`#lib/slides/sheets.ts`):
 * each slide drawn small in a numbered grid, as JPEG data URLs.
 */
export async function renderPdfSheets(
	bytes: Uint8Array
): Promise<{ sheets: string[]; shown: number; total: number }> {
	const task = pdfjsLib.getDocument({ data: bytes });
	try {
		const pdf = await task.promise;
		const first = (await pdf.getPage(1)).getViewport({ scale: 1 });
		const plan = planSheets(pdf.numPages, first.width / first.height);
		const sheets: string[] = [];
		for (const sheet of plan.sheets) sheets.push(await renderSheet(pdf, sheet, plan.cell));
		return { sheets, shown: plan.shown, total: plan.total };
	} finally {
		await task.destroy();
	}
}

async function renderSheet(
	pdf: pdfjsLib.PDFDocumentProxy,
	sheet: SheetPlan,
	cell: { w: number; h: number }
): Promise<string> {
	const canvas = document.createElement('canvas');
	canvas.width = sheet.width;
	canvas.height = sheet.height;
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new Error('Failed to get canvas context');
	ctx.fillStyle = '#808080';
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	for (let i = 0; i < sheet.count; i++) {
		const num = sheet.first + i + 1;
		const page = await pdf.getPage(num);
		const unscaled = page.getViewport({ scale: 1 });
		const viewport = page.getViewport({ scale: cell.w / unscaled.width });
		const slide = document.createElement('canvas');
		slide.width = cell.w;
		slide.height = cell.h;
		const slideCtx = slide.getContext('2d');
		if (!slideCtx) throw new Error('Failed to get canvas context');
		slideCtx.fillStyle = '#ffffff';
		slideCtx.fillRect(0, 0, cell.w, cell.h);
		await page.render({ canvasContext: slideCtx, viewport, canvas: slide }).promise;
		page.cleanup();
		const { x, y } = cellOrigin(sheet, cell, i);
		ctx.drawImage(slide, x, y);
		// The slide's number, so the model can say which one is wrong.
		ctx.fillStyle = '#000000';
		ctx.fillRect(x, y, 34, 24);
		ctx.fillStyle = '#ffffff';
		ctx.font = 'bold 16px sans-serif';
		ctx.fillText(String(num), x + 6, y + 18);
	}
	return canvas.toDataURL('image/jpeg', 0.85);
}

export function pdfPageCountNotice(totalPages: number, rendered: number): string {
	if (totalPages > rendered) {
		return ` (showing first ${rendered} of ${totalPages} pages)`;
	}
	return '';
}
