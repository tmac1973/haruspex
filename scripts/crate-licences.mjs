#!/usr/bin/env node
// The crates a Rust binary is built from, with their licence texts, from
// `cargo metadata`. build-licences.mjs lists the app's own this way.
// build-sidecars.sh runs it on Kokoros right after building koko, because the
// crates koko is built from are only known once its patched Cargo.toml has
// been resolved:
//
//   node scripts/crate-licences.mjs <Cargo.toml> <bin> <target triple> <out.json>
//
// It writes [{ name, version, licence, url, text: [licence file, …] }].
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const spdxDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'licences', 'spdx');

export const LICENCE_FILE = /^(licen[cs]e|copying|copyright|notice)(\.|-|_|$)/i;

/** The standard text of the licences in `expr` that licences/spdx/ has, for `holder`. */
export function standardText(expr, holder) {
	const ids = String(expr ?? '').match(/[A-Za-z0-9.+-]+/g) ?? [];
	const known = ids.filter(
		(id) => !['AND', 'OR', 'WITH'].includes(id) && existsSync(join(spdxDir, `${id}.txt`))
	);
	// Under OR any one licence will do; under AND each applies.
	const chosen = /\bAND\b/.test(expr) ? [...new Set(known)] : known.slice(0, 1);
	return chosen.map((id) =>
		readFileSync(join(spdxDir, `${id}.txt`), 'utf8').replace('{holder}', holder)
	);
}

export const holderOf = (authors, name) =>
	(authors.length ? authors.join(', ') : `the ${name} authors`).replace(/\s*<[^>]*>/g, '');

/**
 * The registry crates `bin` (or, without one, the manifest's own package) is
 * built from for `triple`. Normal dependencies only: build scripts, dev
 * dependencies and proc macros run on the build machine and never reach the
 * binary. Throws when cargo fails.
 */
export function crateLicences({ manifest, bin, triple }) {
	const args = ['metadata', '--format-version', '1', '--manifest-path', manifest];
	if (triple) args.push('--filter-platform', triple);
	const meta = JSON.parse(
		execFileSync('cargo', args, {
			cwd: dirname(manifest),
			encoding: 'utf8',
			maxBuffer: 1 << 28,
			stdio: ['ignore', 'pipe', 'pipe']
		})
	);
	const byId = new Map(meta.packages.map((p) => [p.id, p]));
	const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
	const start = bin
		? meta.workspace_members.find((id) =>
				byId.get(id).targets.some((t) => t.name === bin && t.kind.includes('bin'))
			)
		: meta.resolve.root;
	if (!start) throw new Error(`no package in ${manifest} builds ${bin ?? 'a root crate'}`);

	const crates = new Set();
	const walk = (id) => {
		const p = byId.get(id);
		if (crates.has(id) || p.targets.every((t) => t.kind.includes('proc-macro'))) return;
		crates.add(id);
		for (const d of nodes.get(id).deps) if (d.dep_kinds.some((k) => k.kind === null)) walk(d.pkg);
	};
	walk(start);

	return [...crates]
		.map((id) => byId.get(id))
		.filter((p) => p.source) // path crates are the project's own
		.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
		.map((p) => {
			const dir = dirname(p.manifest_path);
			const own = readdirSync(dir).filter((f) => LICENCE_FILE.test(f));
			if (p.license_file) own.push(p.license_file);
			const files = [...new Set(own)]
				.sort()
				.map((f) => join(dir, f))
				.filter((f) => existsSync(f) && statSync(f).isFile());
			let text = files.map((f) => readFileSync(f, 'utf8'));
			if (!text.length) text = standardText(p.license, holderOf(p.authors ?? [], p.name));
			return {
				name: p.name,
				version: p.version,
				licence: p.license ?? 'see text',
				url: p.repository ?? p.homepage ?? `https://crates.io/crates/${p.name}`,
				text
			};
		});
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	const [manifest, bin, triple, out] = process.argv.slice(2);
	if (!out) {
		console.error('usage: crate-licences.mjs <Cargo.toml> <bin> <target triple> <out.json>');
		process.exit(2);
	}
	const list = crateLicences({ manifest, bin, triple });
	writeFileSync(out, JSON.stringify(list));
	console.warn(`licences: wrote ${list.length} crates of ${bin} to ${out}`);
}
