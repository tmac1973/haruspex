# Phase 02 — Tool families and the core set

**Depends on:** nothing (can run beside phase 01) · **Enables:** phases 03, 04

## Goal

Give every tool a family and an index line, and define the core sets. Pure
data and tests. Nothing reads it yet, so no request changes.

## Files touched

- `src/lib/agent/tools/families.ts` (new): the families, their index lines,
  and the core sets.
- `src/lib/agent/tools/families.test.ts` (new).
- `src/lib/agent/tools/registry.ts`: export `offeredSchemas(opts)`, the current
  body of `getToolSchemas` unchanged, so later phases can split its result.

## Steps

1. **Families.** In `families.ts`:
   ```ts
   export interface ToolFamily {
   	id: string;
   	/** One line for the prompt's index: what it is for, in the user's words. */
   	line: string;
   	/** Whether a registered tool belongs to this family. */
   	has: (name: string, category: string) => boolean;
   }
   ```
   Add one entry per family in the overview's Decisions list: documents,
   email, calendar, contacts, images, music, speech, video-gen, video, screen,
   skill-writing and assets. Match on category where one exists (`email`,
   `calendar`, `contacts`, `music`, `speech`, `video`, `video-gen`, `desktop`,
   `skills-write`). Match on name for the rest (`fs_write_document`,
   `fs_write_spreadsheet`, `fs_write_slides`; `generate_image`, `edit_image`,
   `upscale_image`, `save_generated`; `make_asset`).
2. **MCP families.** `mcpFamilies()` returns one family per server in
   `registeredMcpServerLabels()`, with id `mcp:<server id>` and the server's
   label as the line. A server's tools are found through the same name prefix
   `mcp-names.ts` uses.
3. **Index lines.** Each line says when to load the family, not what each tool
   does, in under 100 characters. Examples:
   - `video — edit the episodes in the working folder with Kdenlive: probe, cut, captions, render`
   - `documents — write a PDF, Word or OpenDocument file, a spreadsheet or a slide deck`
   - `email — read, summarise and draft the user's email`
4. **Core sets.** `CHAT_CORE` and `CODE_CORE` as name sets, from the
   overview's Decisions. `isCore(name, codeTab)` returns true for a core
   tool, and for any tool in no family. A new tool is then core until someone
   gives it a family, which is the safe default.
5. **Tests** in `families.test.ts`, with all tools registered:
   - Every registered tool is in at most one family.
   - No core tool is in a family.
   - Every family line is under 100 characters and starts with its id.
   - With everything on (the audit's settings mock), the core schemas for Chat
     are under 18 KB, and for the Code tab under 14.5 KB.

## Build gate

```bash
npm run check && npm run lint && npm run format:check && npm run test
```

## Commit

`refactor(tools): group the tools into families for deferred loading`

PR label `no-docs`.

## Rollback

Revert the commit. Nothing reads the module yet.
