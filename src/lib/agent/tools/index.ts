// Import tool modules to trigger registration (side-effect imports)
import './web';
import './fs-read';
import './fs-write';
import './email';
import './sandbox';
import './code';
import './shell-interactive';
import './audit';
import './user-question';

// Re-export registry API
export { getToolSchemas, executeTool, getDisplayLabel } from './registry';

// Re-export types used by consumers
export type { ToolExecOutput, PendingImage, ToolContext, Artifact, LintIssue } from './types';
