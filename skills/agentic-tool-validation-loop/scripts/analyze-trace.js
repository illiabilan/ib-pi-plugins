#!/usr/bin/env node
/**
 * analyze-trace.js — parse a `pi --mode json` JSONL log and print a clean summary.
 *
 * Usage:
 *   node analyze-trace.js <log-file> [--full]
 *
 * Without --full: prints tool calls (name + args), thinking excerpts, per-turn
 * token deltas, totals, and the final answer.
 *
 * With --full: also prints the complete raw text of every tool result (use
 * this to actually read what the model saw — this is where most real bugs
 * in this methodology were found, not in the summary numbers).
 */

const fs = require("node:fs");

const file = process.argv[2];
const full = process.argv.includes("--full");

if (!file) {
  console.error("Usage: node analyze-trace.js <log-file> [--full]");
  process.exit(1);
}

const lines = fs
  .readFileSync(file, "utf-8")
  .split("\n")
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

console.log(`\n=== ${file} ===\n`);

// --- Tool calls, in order, with arguments ---
console.log("--- Tool calls ---");
let toolCallCount = 0;
for (const ev of lines) {
  if (ev.type === "tool_execution_start") {
    toolCallCount++;
    console.log(`  ${toolCallCount}. ${ev.toolName}(${JSON.stringify(ev.args)})`);
  }
}
if (toolCallCount === 0) console.log("  (none)");

// --- Tool results: size + optional full text ---
console.log("\n--- Tool results ---");
let idx = 0;
for (const ev of lines) {
  if (ev.type === "tool_execution_end") {
    idx++;
    const text = (ev.result?.content ?? []).map((c) => c.text || "").join("");
    const flag = text.length > 2000 ? "  ⚠ large — inspect with --full" : "";
    console.log(`  ${idx}. ${ev.toolName}: ${text.length} chars, isError=${!!ev.isError}${flag}`);
    if (full) {
      console.log("     " + text.split("\n").join("\n     "));
      console.log();
    }
  }
}

// --- Model's own reasoning (thinking blocks) — read this, it's where the
// real "why did it choose that tool / why didn't it trust the result"
// answers live, not in the numbers. ---
console.log("\n--- Thinking / reasoning excerpts ---");
let thinkingCount = 0;
for (const ev of lines) {
  if (ev.type === "turn_end") {
    for (const c of ev.message?.content ?? []) {
      if (c.type === "thinking" && c.thinking?.trim()) {
        thinkingCount++;
        console.log(`  [${thinkingCount}] ${c.thinking.trim()}`);
      }
    }
  }
}
if (thinkingCount === 0) console.log("  (none — run with --thinking high to capture reasoning)");

// --- Token accounting per turn ---
console.log("\n--- Token usage per turn (turn_end) ---");
let inputSum = 0,
  outputSum = 0,
  cacheWriteSum = 0,
  cacheReadLast = 0,
  costSum = 0,
  turnCount = 0;
for (const ev of lines) {
  if (ev.type === "turn_end" && ev.message?.usage) {
    const u = ev.message.usage;
    turnCount++;
    inputSum += u.input || 0;
    outputSum += u.output || 0;
    cacheWriteSum += u.cacheWrite || 0;
    cacheReadLast = u.cacheRead || 0;
    costSum += u.cost?.total || 0;
    console.log(
      `  turn ${turnCount}: input=${u.input} output=${u.output} cacheWrite=${u.cacheWrite} cacheRead=${u.cacheRead}`,
    );
  }
}

// --- Totals ---
// "newTokens" = input + output + cacheWrite. This is the meaningful cost
// metric: cacheRead is a cache hit on already-paid-for context and is cheap;
// cacheWrite + input + output is what actually got newly added/generated
// this run. Comparing raw "totalTokens" between runs is misleading because
// it re-counts cheap cache reads that grow with conversation length.
console.log("\n--- Totals ---");
console.log(`  turns: ${turnCount}`);
console.log(`  tool calls: ${toolCallCount}`);
console.log(`  new tokens (input+output+cacheWrite): ${inputSum + outputSum + cacheWriteSum}`);
console.log(`    (input=${inputSum}, output=${outputSum}, cacheWrite=${cacheWriteSum}, last cacheRead=${cacheReadLast})`);
console.log(`  cost: $${costSum.toFixed(4)}`);

// --- Final answer ---
// NOTE: content[0] is not reliably the text block — assistant messages can
// start with a thinking block. Find the actual text block explicitly.
console.log("\n--- Final answer ---");
for (const ev of lines) {
  if (ev.type === "agent_end") {
    const last = ev.messages?.[ev.messages.length - 1];
    const textBlock = (last?.content ?? []).find((c) => c.type === "text");
    console.log(textBlock?.text ?? "(no text content in final message)");
  }
}
console.log();
