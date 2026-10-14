import { describe, it, expect } from 'vitest';
import { languageFor } from './languages';

const name = (path?: string) => {
	const lang = languageFor(path);
	return lang && typeof lang !== 'string' ? lang.name : lang;
};

describe('languageFor', () => {
	it('picks the language by extension, in any case and any folder', () => {
		expect(name('src/app.ts')).toBe('TypeScript');
		expect(name('src\\App.TSX')).toBe('TSX');
		expect(name('tools/run.py')).toBe('Python');
		expect(name('src-tauri/src/main.rs')).toBe('Rust');
		expect(name('scripts/dev-setup.sh')).toBe('Shell');
		expect(name('Cargo.toml')).toBe('TOML');
		expect(name('package.json')).toBe('JSON');
	});

	it('knows files by their whole name', () => {
		expect(name('docker/Dockerfile')).toBe('Dockerfile');
	});

	it('reads Svelte as HTML, which hands its script and style on', () => {
		expect(name('src/routes/+page.svelte')).toBe('HTML');
	});

	it('keeps markdown, and markdown is what text with no file is', () => {
		expect(name('notes/plan.md')).toBe('markdown');
		expect(name()).toBe('markdown');
	});

	it('leaves files it does not know as plain text', () => {
		expect(name('notes.txt')).toBeNull();
		expect(name('.gitignore')).toBeNull();
	});
});

describe('loading a language', () => {
	it('loads the parser on demand', async () => {
		const lang = languageFor('main.py');
		expect(lang && typeof lang !== 'string' && (await lang.load()).language.name).toBe('python');
	});
});
