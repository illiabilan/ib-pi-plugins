/**
 * Grep Extension for Pi
 *
 * Wraps the ripgrep command to provide powerful text search capabilities
 * across codebases with fallback to grep if ripgrep is not installed.
 *
 * Install:
 *   Symlinked into ~/.pi/agent/extensions/grep
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";

/** Default cap on returned match lines; overridable per call via `limit`. */
const DEFAULT_LIMIT = 500;
/** Hard cap on characters returned, mirroring the built-in read tool. */
const MAX_CHARS = 50_000;
/** Buffer ceiling for the child process; we cut with `head` long before this. */
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/** Wrap a value in single quotes so the shell treats it as a literal. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

class BashGrepExtension {
  constructor(private pi: ExtensionAPI) {}

  async init() {
    this.pi.registerTool({
      name: "grep",
      label: "Grep",
      description:
        "Search text patterns in files using ripgrep or grep. " +
        "Provides fast text matching with support for regex patterns.",
      promptSnippet:
        "Search text patterns in files using ripgrep or grep with regex support",
      promptGuidelines: [
        "Use grep to search for specific text patterns or regular expressions across files.",
        "If you want to search for exact strings, use basic pattern matching.",
        "Use line numbers to locate specific matches within files.",
        `Output is capped at ${DEFAULT_LIMIT} match lines by default; raise or lower it with 'limit'. If the result says it was truncated, narrow the pattern or directory instead of retrying the same search.`,
      ],
      parameters: Type.Object({
        pattern: Type.String({
          description: "The text pattern or regex to search for",
        }),
        file: Type.Optional(
          Type.String({
            description: "Specific file to search in (optional)",
          })
        ),
        directory: Type.Optional(
          Type.String({
            description: "Directory to search in (optional, defaults to current)",
          })
        ),
        regex: Type.Optional(
          Type.Boolean({
            description: "Whether to use regex pattern matching (default true)",
            default: true,
          })
        ),
        caseSensitive: Type.Optional(
          Type.Boolean({
            description: "Whether the search is case sensitive (default true)",
            default: true,
          })
        ),
        lineNumbers: Type.Optional(
          Type.Boolean({
            description: "Whether to include line numbers (default true)",
            default: true,
          })
        ),
        context: Type.Optional(
          Type.Number({
            description: "Number of context lines before/after matches (default 0)",
            default: 0,
          })
        ),
        limit: Type.Optional(
          Type.Number({
            description: `Maximum number of output lines to return (default ${DEFAULT_LIMIT})`,
            default: DEFAULT_LIMIT,
          })
        ),
      }),
      execute: async (_toolCallId, params, _signal, onUpdate, ctx) => {
        // Check if ripgrep is available in the environment
        const ripgrepAvailable = await this.isRipgrepAvailable();
        let command = "";
        
        if (ripgrepAvailable) {
          command = "rg";
          onUpdate?.({ content: [{ type: "text", text: "Using ripgrep (rg) as the search tool" }], details: { tool: "ripgrep" } });
        } else {
          // Fallback to grep if ripgrep is not available
          const grepAvailable = await this.isGrepAvailable();
          if (!grepAvailable) {
            return {
              content: [{ type: "text", text: "Error: Neither ripgrep nor grep command available on this system" }],
              details: { error: "ripgrep and grep not available" }
            };
          }
          command = "grep";
          onUpdate?.({ content: [{ type: "text", text: "Falling back to grep as the search tool" }], details: { tool: "grep" } });
        }

        // Build the command based on selected tool
        // Add flags based on parameters
        // NOTE: flags differ between the two tools. In ripgrep, -E is --encoding
        // and -r is --replace, so they must NOT be reused from the grep path.
        if (params.regex === false) {
          command += " -F"; // Treat the pattern as a literal string (both tools)
        } else if (!ripgrepAvailable) {
          command += " -E"; // grep needs -E for extended regex; rg is regex by default
        }
        
        if (params.caseSensitive === false) {
          command += " -i"; // Case insensitive (both tools)
        }
        
        if (params.lineNumbers !== false) {
          command += " -n"; // Show line numbers (both tools)
        }
        
        if (params.context && params.context > 0) {
          command += ` -C ${params.context}`; // Context lines (both tools)
        }
        
        // Add the search pattern (quoted so regex metacharacters reach the tool intact)
        command += ` ${shellQuote(params.pattern)}`;
        
        // Add file or directory arguments
        // ripgrep recurses by default and takes the path positionally;
        // grep needs an explicit -r for directories.
        const recurseFlag = ripgrepAvailable ? "" : " -r";
        if (params.file) {
          command += ` ${shellQuote(params.file)}`;
        } else if (params.directory) {
          command += `${recurseFlag} ${shellQuote(params.directory)}`;
        } else {
          command += `${recurseFlag} .`; // Default to searching the current directory
        }
        
        // Stop the search early rather than buffering an unbounded match set.
        // We ask for one extra line so we can detect that truncation happened.
        const limit =
          params.limit && params.limit > 0 ? Math.floor(params.limit) : DEFAULT_LIMIT;
        command += ` | head -n ${limit + 1}`;
        
        onUpdate?.({ content: [{ type: "text", text: `Executing: ${command}` }], details: { command } });
        
        // Use the built-in bash tool (that Pi already has access to)  
        try {
          const result = await this.executeCommand(command, ctx, params.pattern, limit);
          return {
            content: [{ type: "text", text: result }],
            details: { command, results: result, tool: ripgrepAvailable ? "ripgrep" : "grep" }
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          return {
            content: [{ type: "text", text: `Error: ${errorMessage}` }],
            details: { command, error: errorMessage, tool: ripgrepAvailable ? "ripgrep" : "grep" }
          };
        }
      },
      renderCall: (args, theme) => {
        let text = theme.fg("toolTitle", theme.bold("grep "));
        text += theme.fg("accent", args.pattern);
        return new Text(text, 0, 0);
      },
      renderResult: (result, { expanded, isPartial }, theme) => {
        if (isPartial) return new Text(theme.fg("warning", "Searching..."), 0, 0);
        
        const content = result.content[0]?.text ?? "";
        if (content.includes("Error:")) {
          return new Text(theme.fg("error", content), 0, 0);
        }
        
        const lines = content.split("\n");
        if (lines.length > 15 && !expanded) {
          const truncated = lines.slice(0, 15).join("\n") + `\n... and ${lines.length - 15} more lines`;
          return new Text(truncated, 0, 0);
        }
        
        return new Text(content, 0, 0);
      },
    });
  }

  private async isRipgrepAvailable(): Promise<boolean> {
    try {
      const { exec } = await import("child_process");
      const { promisify } = await import("util");
      const execPromise = promisify(exec);
      await execPromise("which rg");
      return true;
    } catch {
      return false;
    }
  }

  private async isGrepAvailable(): Promise<boolean> {
    try {
      const { exec } = await import("child_process");
      const { promisify } = await import("util");
      const execPromise = promisify(exec);
      await execPromise("which grep");
      return true;
    } catch {
      return false;
    }
  }

  private async executeCommand(
    command: string,
    ctx: ExtensionContext,
    pattern: string,
    limit: number
  ): Promise<string> {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execPromise = promisify(exec);
    
    try {
      const { stdout, stderr } = await execPromise(command, {
        cwd: ctx.cwd,
        maxBuffer: MAX_BUFFER_BYTES,
      });
      
      const truncatedStdout = this.truncate(stdout, limit);
      
      // If there's stderr (like grep warnings), include it in the result
      const result = truncatedStdout + (stderr ? `\nErrors: ${stderr}` : "");
      
      // If result is empty, indicate no matches found
      return result.trim() || `No matches found for pattern: "${pattern}"`;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      // Handle grep-specific error conditions more gracefully
      if (errorMessage.includes("No such file or directory") || 
          errorMessage.includes("Permission denied")) {
        return `Error: ${errorMessage}`;
      }
      throw error;
    }
  }

  /**
   * Cut output down to `limit` lines and MAX_CHARS characters, appending an
   * explicit marker so the caller knows results are incomplete.
   */
  private truncate(stdout: string, limit: number): string {
    let text = stdout;
    let truncated = false;
    
    const lines = text.split("\n");
    if (lines.length > limit) {
      text = lines.slice(0, limit).join("\n");
      truncated = true;
    }
    
    if (text.length > MAX_CHARS) {
      text = text.slice(0, MAX_CHARS);
      truncated = true;
    }
    
    if (truncated) {
      text +=
        `\n... [output truncated at ${limit} lines / ${MAX_CHARS} chars. ` +
        "More matches exist: narrow the pattern or directory, or raise 'limit'.]";
    }
    
    return text;
  }
}

export default function (pi: ExtensionAPI) {
  const ext = new BashGrepExtension(pi);
  return ext.init();
}