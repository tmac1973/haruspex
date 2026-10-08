// Import tool modules to trigger registration (side-effect imports)
import './web';
import './fs-read';
import './fs-write';
import './email';
import './email-compose';
import './sandbox';
import './code';
import './code-bg';
import './shell-interactive';
import './audit';
import './planning';
import './coding';
import './memory';
import './memoryWrite';
import './user-question';
import './mcp';
import './calendar';
import './contacts';
import './screen';
import './image-gen';
import './make-asset';
import './skills';
import './skillsWrite';
import './guide';

// Re-export registry API
export { getToolSchemas, executeTool, getDisplayLabel, coerceCallArguments } from './registry';
export { registerMcpTools, unregisterMcpServer } from './mcp';

// Re-export types used by consumers
export type { ToolExecOutput, PendingImage, ToolContext, Artifact, LintIssue } from './types';
