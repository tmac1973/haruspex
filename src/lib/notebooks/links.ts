/**
 * The notebook dead-link check, frontend side: which links a notebook has
 * (text cards' Markdown links and bare URLs, and table URL cells), whether
 * it's due an automatic check (opened a week or more after the last), and
 * running the check through the app's proxy (`notebook_links.rs`).
 */
import { invoke } from '@tauri-apps/api/core';
import { Marked, type Token } from 'marked';
import * as api from '#lib/notebooks/api.ts';
import type { NotebookCard, NotebookSummary } from '#lib/notebooks/api.ts';
import { columnsOf } from '#lib/notebooks/columns.ts';
import { getSettings } from '#lib/stores/settings.ts';
import type { LinkStatus } from '#lib/ipc/gen/LinkStatus.ts';

export type { LinkStatus };

/** How long after a check a notebook is checked again when opened. */
export const RECHECK_MS = 7 * 24 * 60 * 60 * 1000;

const lexer = new Marked({ gfm: true });

function linksInTokens(tokens: Token[] | undefined, out: Set<string>): void {
	for (const t of tokens ?? []) {
		if (t.type === 'link' && /^https?:\/\//i.test((t as { href: string }).href)) {
			out.add((t as { href: string }).href);
		}
		const nested = t as {
			tokens?: Token[];
			items?: { tokens: Token[] }[];
			rows?: { tokens: Token[] }[][];
			header?: { tokens: Token[] }[];
		};
		linksInTokens(nested.tokens, out);
		for (const i of nested.items ?? []) linksInTokens(i.tokens, out);
		for (const h of nested.header ?? []) linksInTokens(h.tokens, out);
		for (const r of nested.rows ?? []) for (const c of r) linksInTokens(c.tokens, out);
	}
}

/** A table's URL cells. */
function urlCells(c: NotebookCard, out: Set<string>): void {
	const urlCols = columnsOf(api.parseMeta(c.meta)).filter((col) => col.type === 'url');
	for (const r of c.rows) {
		const cells = api.parseMeta<Record<string, unknown>>(r.cells);
		for (const col of urlCols) {
			const v = cells[col.id];
			if (typeof v === 'string' && /^https?:\/\//i.test(v)) out.add(v);
		}
	}
}

/** Every web link in the cards: Markdown links (and bare URLs) in text, URL cells in tables. */
export function collectLinks(cards: NotebookCard[]): string[] {
	const out = new Set<string>();
	for (const c of cards) {
		if (c.kind === 'text') {
			linksInTokens(lexer.lexer(c.body), out);
		} else if (c.kind === 'table') {
			urlCells(c, out);
		}
	}
	return [...out];
}

/** Whether opening `nb` should check its links: never checked, or a week ago or more. */
export function shouldAutoCheck(nb: NotebookSummary, hasLinks: boolean, now = Date.now()): boolean {
	if (!hasLinks) return false;
	return nb.links_checked_at === null || now - nb.links_checked_at >= RECHECK_MS;
}

export function checkLinks(notebookId: string, urls: string[]): Promise<LinkStatus[]> {
	return invoke<LinkStatus[]>('notebook_links_check', {
		notebookId,
		urls,
		proxy: getSettings().proxy ?? null
	});
}

export function linkStatuses(notebookId: string): Promise<LinkStatus[]> {
	return invoke<LinkStatus[]>('notebook_link_status_get', { notebookId });
}
