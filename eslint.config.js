import js from '@eslint/js';
import ts from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import path from 'node:path';
import globals from 'globals';

/**
 * `src/lib/agent/tools/` file names (CLAUDE.md): a module that registers tools
 * is kebab-case after them (`fs-write.ts`); every other module is
 * `_camelCase` (`_helpers.ts`). The folder's own `index`, `registry` and
 * `types` keep their names.
 *
 * @type {import('eslint').Rule.RuleModule}
 */
const toolFileNames = {
	meta: { type: 'suggestion', schema: [] },
	create(context) {
		const name = path.basename(context.filename, '.ts');
		if (['index', 'registry', 'types'].includes(name)) return {};
		let registers = false;
		return {
			CallExpression(node) {
				const callee = node.callee;
				if (callee.type === 'Identifier' && /^registerTool(Alias)?$/.test(callee.name)) {
					registers = true;
				}
			},
			'Program:exit'(program) {
				if (registers && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
					context.report({
						node: program,
						message: 'A module that registers tools is named kebab-case after them (fs-write.ts).'
					});
				} else if (!registers && !/^_[a-z][a-zA-Z0-9]*$/.test(name)) {
					context.report({
						node: program,
						message: 'A module here that registers no tools is named _camelCase (_helpers.ts).'
					});
				}
			}
		};
	}
};

export default ts.config(
	js.configs.recommended,
	...ts.configs.recommended,
	...svelte.configs.recommended,
	{
		languageOptions: {
			globals: {
				...globals.browser,
				...globals.node
			}
		},
		rules: {
			complexity: ['warn', 15],
			'max-depth': ['warn', 4],
			'max-lines-per-function': ['warn', { max: 80, skipBlankLines: true, skipComments: true }],
			'max-lines': ['warn', { max: 400, skipBlankLines: true, skipComments: true }]
		}
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parserOptions: {
				parser: ts.parser
			}
		},
		rules: {
			// $state() runes require `let` even though the variable is never reassigned
			'prefer-const': 'off',
			// We use {@html} for rendering trusted markdown output
			'svelte/no-at-html-tags': 'off',
			// We use simple goto() navigation without the resolve pattern
			'svelte/no-navigation-without-resolve': 'off'
		}
	},
	{
		// Svelte component files combine script + markup + style; the
		// `max-lines` threshold targeted at TS modules doesn't translate.
		files: ['**/*.svelte'],
		rules: {
			'max-lines': 'off'
		}
	},
	{
		// Test files: `describe`/`it` callbacks are naturally long, and a file
		// grows with every case its source needs; neither length rule is a
		// useful signal there.
		files: ['**/*.test.ts', '**/*.test.js'],
		rules: {
			'max-lines-per-function': 'off',
			'max-lines': 'off'
		}
	},
	{
		// App code logs through console.warn / console.error only: those reach
		// devtools and, via forwardConsoleToDebugLog, the debug log a user can
		// attach. console.log / info / debug would reach devtools alone.
		files: ['src/**/*.ts', 'src/**/*.svelte'],
		ignores: ['**/*.test.ts'],
		rules: {
			'no-console': ['error', { allow: ['warn', 'error'] }]
		}
	},
	{
		// src/lib imports go through `#lib/<path>` with the file's extension
		// (CLAUDE.md): an extensionless relative path is how `./loop` ends up
		// meaning loop.ts in one place and loop/ in another.
		files: ['src/lib/**/*.ts', 'src/lib/**/*.svelte'],
		ignores: ['**/*.test.ts'],
		rules: {
			'no-restricted-imports': [
				'error',
				{
					patterns: [
						{
							regex: '^\\.{1,2}/',
							message: "Import from src/lib as '#lib/<path>' with the file's extension."
						}
					]
				}
			]
		}
	},
	{
		// A promise nobody awaits, voids or catches turns a failure into an
		// unhandled rejection: say `void` when the callee handles its own
		// errors, `void … .catch` when it doesn't. Needs type information, so
		// only this rule runs typed. no-floating-promises counts a bare
		// `.catch(…)` statement as handled, so the second rule asks for the
		// `void` there too: it marks the call as fire-and-forget at a glance.
		files: ['src/**/*.ts', 'src/**/*.svelte'],
		ignores: ['**/*.test.ts'],
		languageOptions: {
			parserOptions: {
				projectService: true,
				extraFileExtensions: ['.svelte'],
				tsconfigRootDir: import.meta.dirname
			}
		},
		rules: {
			'@typescript-eslint/no-floating-promises': 'error',
			'no-restricted-syntax': [
				'error',
				{
					selector: "ExpressionStatement > CallExpression[callee.property.name='catch']",
					message: 'Mark a fire-and-forget promise with `void`, even with a `.catch`.'
				}
			]
		}
	},
	{
		files: ['src/lib/agent/tools/*.ts'],
		ignores: ['**/*.test.ts'],
		plugins: { haruspex: { rules: { 'tool-file-names': toolFileNames } } },
		rules: {
			'haruspex/tool-file-names': 'error'
		}
	},
	{
		ignores: ['build/', '.svelte-kit/', 'dist/', 'node_modules/', 'src-tauri/', 'src/lib/ipc/gen/']
	}
);
