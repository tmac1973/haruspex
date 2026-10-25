// Import tool modules to trigger registration (side-effect imports)
import '#lib/agent/tools/web.ts';
import '#lib/agent/tools/fs-read.ts';
import '#lib/agent/tools/fs-write.ts';
import '#lib/agent/tools/email.ts';
import '#lib/agent/tools/email-compose.ts';
import '#lib/agent/tools/sandbox.ts';
import '#lib/agent/tools/code.ts';
import '#lib/agent/tools/code-bg.ts';
import '#lib/agent/tools/code-handoff.ts';
import '#lib/agent/tools/delegate.ts';
import '#lib/agent/tools/shell-interactive.ts';
import '#lib/agent/tools/audit.ts';
import '#lib/agent/tools/planning.ts';
import '#lib/agent/tools/coding.ts';
import '#lib/agent/tools/memory.ts';
import '#lib/agent/tools/memoryWrite.ts';
import '#lib/agent/tools/user-question.ts';
import '#lib/agent/tools/mcp.ts';
import '#lib/agent/tools/calendar.ts';
import '#lib/agent/tools/contacts.ts';
import '#lib/agent/tools/screen.ts';
import '#lib/agent/tools/image-gen.ts';
import '#lib/agent/tools/make-asset.ts';
import '#lib/agent/tools/music-gen.ts';
import '#lib/agent/tools/save-audio.ts';
import '#lib/agent/tools/skills.ts';
import '#lib/agent/tools/skillsWrite.ts';
import '#lib/agent/tools/guide.ts';

// Re-export registry API
export {
	getToolSchemas,
	executeTool,
	getDisplayLabel,
	coerceCallArguments
} from '#lib/agent/tools/registry.ts';
export { registerMcpTools, unregisterMcpServer } from '#lib/agent/tools/mcp.ts';

// Re-export types used by consumers
export type {
	ToolExecOutput,
	PendingImage,
	ToolContext,
	Artifact,
	LintIssue
} from '#lib/agent/tools/types.ts';
