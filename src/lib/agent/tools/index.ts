// Import tool modules to trigger registration (side-effect imports)
import './web';
import './fs-read';
import './fs-write';
import './email';

// Re-export registry API
export { getToolSchemas, executeTool, getDisplayLabel } from './registry';

// Re-export types used by consumers
export type { ToolExecOutput, PendingImage, ToolContext } from './types';
