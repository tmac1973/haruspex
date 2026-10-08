---
name: plan-web-app
description: Questions and requirements for planning a web app, covering users and sign-in, data and storage, where it runs, the stack, screens, states, accessibility, security and testing. Use when the project is a website or browser-based app with interactive pages.
metadata:
  haruspex-job: guided-planning
---

# Planning a web app

A description of a web app usually says what it does and leaves out who
uses it, where its data lives and where it runs. Those decide the stack.
Guessing them wrong means rewriting the backend.

Settle each topic below that the description hasn't already settled. Offer
the options given, recommended first. Skip topics that clearly don't
apply, such as sign-in for a single-user local tool.

## Questions

### Who uses it
- Just the user, on their own machine.
- A few people they know.
- The public.

This drives sign-in, hosting and security, so ask it first.

### Sign-in
- None.
- A single shared password.
- Accounts with email and password.
- Sign in with an outside provider (Google, GitHub).

Default: none for a personal tool, accounts for anything shared.

### Data
- Where it is kept: only in the browser (localStorage, IndexedDB); a file
  or SQLite database on a server; a hosted database.
- Whether it must survive a restart and be shared between devices.
- Rough size: tens of records, or many thousands.

Default: SQLite for a server app; browser storage for a single-user tool
with no server.

### Where it runs
- Only on the user's machine.
- A static host (GitHub Pages, Netlify): no server code.
- A server or container the user runs.
- A platform host (Vercel, Fly.io, Render).

Default: local first, built so it could be deployed.

### Stack
- No framework: plain HTML, CSS and TypeScript.
- A frontend framework (Svelte, React, Vue).
- A full-stack framework (SvelteKit, Next.js).
- A backend in another language (Python with FastAPI or Flask, Go).
- Whatever the project already uses.

Default: what the project uses; otherwise the smallest stack that does
the job.

### Screens and main flow
Ask for the main screens and the one path through them that matters most
(for example, sign in, see the list, add an item, edit it). This becomes
the phase order.

### Loading, empty and error states
Each screen that shows data needs all three. Ask whether anything
specific should happen, such as retrying, or a first-run screen with
sample content.

### Screen sizes
- Desktop only.
- Desktop and phone (responsive).
- Phone first.

Default: responsive.

### Accessibility
- Basic: proper labels, keyboard use, enough contrast.
- A stated standard (WCAG 2.1 AA).

Default: basic, which the plan must still deliver.

### Look
- Light only, dark only, or both, following the system.
- An existing design or brand to match.
- A component library, or plain CSS.

### Offline
- Online only.
- Works offline once loaded, and syncs later.

### Languages
English only, or translatable from the start.

### Security
Ask what's sensitive: personal data, payments, admin actions. Then cover
input validation, where secrets live, cross-site request forgery for forms
with a server, and rate limits on sign-in.

### Outside services
Email, payments, maps, AI APIs: which ones, and whether keys are needed.

### Sample data
Whether to seed the database with sample records for development and
demos.

### Testing
- Unit tests for logic.
- A headless browser check that each page loads (Playwright).
- Both.

Default: both, with the headless check kept small.

## Plan requirements

- The first phase serves a page that loads in a browser with no console
  errors, and the verification command checks it headlessly.
- Every screen that shows data has loading, empty and error states, built
  in the phase that builds the screen.
- Every form validates its input and shows errors next to the field. A
  server validates again whatever the browser sent.
- No secret or key is committed. Configuration comes from the environment
  or a gitignored file, with a committed example file listing the names.
- Every interactive element works with the keyboard and has a label.
- Each phase ends with the app starting from a clean checkout with the
  documented commands, and with the verification command passing.
- If there's sign-in, every page and API route that needs it refuses
  requests without it, and a test proves that.
