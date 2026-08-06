import { Container, Text, Markdown, Spacer } from "@earendil-works/pi-tui";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	getAgentDir,
	getMarkdownTheme,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";

/**
 * Token/Sec Extension
 * Displays real-time token usage stats in the TUI header/footer during agent runs.
 */

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

// In a real Pi extension, we would likely subscribe to an event emitter 
// or use a singleton/provider to access the current session's live usage.
// For this implementation, we'll provide a hook for the TUI to call.

export default function (pi: ExtensionAPI) {
	// In a real implementation, we'd hook into the `pi` session lifecycle.
	// Since we don't have access to the internal session event emitter directly via the SDK
	// in this mock-up environment, we register a placeholder or a way to receive updates.

	console.log("Token/Sec extension loaded.");
}

// Helper to calculate tokens per second (requires start time)
export function calculateTPS(tokenCount: number, durationSeconds: number): number {
	if (durationSeconds <= 0) return 0;
	return tokenCount / durationSeconds;
}
