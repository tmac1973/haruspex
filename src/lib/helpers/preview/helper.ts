/** The Web preview helper: `show_preview` (`#lib/agent/tools/show-preview.ts`). */
import { registerHelper } from '#lib/helpers/registry.ts';

registerHelper({
	id: 'preview',
	label: 'Web preview',
	summary: 'Opens web pages the agent writes in a preview window.',
	tooltip:
		"Serves the session folder on this computer only and reloads the window when the page's files change. With the Browser (Playwright) server installed, the agent can open the same address to take screenshots.",
	tools: ['show_preview'],
	writes: false,
	defaultOn: true,
	prompt:
		"- show_preview — open an .html file from the project in a preview window the user sees; it reloads when the page's files change. Returns the page's address, which browser_navigate can open."
});
