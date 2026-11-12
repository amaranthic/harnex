/**
 * @fileoverview System instruction descriptions for standard agent tools.
 * @packageDocumentation
 */

/**
 * System prompt description for ReadFileTool.
 */
export const readFileDescription =
  "Reads content from a file in the workspace with 1-based line numbering. " +
  "Supports start line offset and line limit parameters for efficiently inspecting large files. " +
  "Binary files and blocking device files are automatically rejected.";

/**
 * System prompt description for WriteFileTool.
 */
export const writeFileDescription =
  "Writes the complete content to a file in the workspace. " +
  "If the file does not exist, it is created along with any necessary parent directories. " +
  "If the file already exists, it is completely overwritten.";

/**
 * System prompt description for EditFileTool.
 */
export const editFileDescription =
  "Performs surgical string replacement in a workspace file. " +
  "Requires exact matching of 'oldString' with existing file content, including indentation. " +
  "If 'oldString' appears multiple times, specify 'replaceAll: true' or provide unique surrounding context.";

/**
 * System prompt description for BashTool.
 */
export const bashDescription =
  "Executes a shell command in the workspace directory with the host permissions of the current process user. " +
  "Environment variables are sanitized, but the shell is not an isolated sandbox. " +
  "Captures combined output and exit codes. Supports waitMsBeforeAsync to wait in foreground before detaching as a background task, " +
  "and optional timeoutMs for hard process lifetime.";

/**
 * System prompt description for TaskManagerTool.
 */
export const taskManagerDescription =
  "Manages background shell tasks created by bash commands. " +
  "Supports listing active and recent tasks, line-paged log inspection with offset and limit, " +
  "delivering interactive stdin input, terminating running processes, and deleting completed tasks.";

/**
 * System prompt description for GlobTool.
 */
export const globDescription =
  "Searches for files across the workspace matching a glob pattern (e.g. '**/*.ts', 'src/**/*.json'). " +
  "Supports directoryPath scoping and automatically ignores version control and dependency directories like .git and node_modules. " +
  "Returns matching relative file paths with a cap of 250 results.";

/**
 * System prompt description for GrepTool.
 */
export const grepDescription =
  "Searches file contents across the workspace matching a regular expression pattern. " +
  "Supports single-file targeting via filePath or directory scoping via directoryPath with optional file glob filtering, " +
  "and case-insensitive matching. Returns matching relative file paths with line numbers and line content.";

/**
 * System prompt description for WebFetchTool.
 */
export const webFetchDescription =
  "Fetches web page content from a specified HTTP or HTTPS URL and converts it into clean Markdown. " +
  "Accepts an optional 'prompt' parameter to run a focused extraction using the active model, returning " +
  "only the targeted information instead of the full page. " +
  "Includes SSRF protection (blocks private, loopback, and local network addresses), cross-host redirect detection, " +
  "and a 15-minute in-memory response cache.";
