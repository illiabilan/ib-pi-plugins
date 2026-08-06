#!/usr/bin/env node
/**
 * compare.js — side-by-side comparison of two `pi --mode json` traces,
 * typically produced by run-pair.sh (with.jsonl vs without.jsonl).
 *
 * Usage:
 *   node compare.js <log-a> <log-b> [--full]
 *
 * Prints tool calls for each, then a metrics table (calls, new tokens, cost)
 * with the delta. Use --full to also dump full tool-result text for both
 * (do this whenever the numbers look surprising, per the methodology —
 * the real explanation is almost always visible in the raw text).
 */

const fs = require("node:fs");

const [fileA, fileB] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const full = process.argv.includes("--full");

if (!fileA || !fileB) {
  console.error("Usage: node compare.js <log-a> <log-b> [--full]");
  process.exit(1);
}

function parse(file) {
  return fs
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
}

function metrics(lines) {
  let inputSum = 0,
    outputSum = 0,
    cacheWriteSum = 0,
    costSum = 0,
    calls = 0,
    turns = 0;
  const toolCalls = [];
  const results = [];
  for (const ev of lines) {
    if (ev.type === "tool_execution_start") {
      calls++;
      toolCalls.push(`${ev.toolName}(${JSON.stringify(ev.args)})`);
    }
    if (ev.type === "tool_execution_end") {
      const text = (ev.result?.content ?? []).map((c) => c.text || "").join("");
      results.push({ tool: ev.toolName, chars: text.length, text });
    }
    if (ev.type === "turn_end" && ev.message?.usage) {
      const u = ev.message.usage;
      turns++;
      inputSum += u.input || 0;
      outputSum += u.output || 0;
      cacheWriteSum += u.cacheWrite || 0;
      costSum += u.cost?.total || 0;
    }
  }
  let finalAnswer = "";
  for (const ev of lines) {
    if (ev.type === "agent_end") {
      const last = ev.messages?.[ev.messages.length - 1];
      const textBlock = (last?.content ?? []).find((c) => c.type === "text");
      finalAnswer = textBlock?.text ?? "";
    }
  }
  return {
    turns,
    calls,
    toolCalls,
    results,
    newTokens: inputSum + outputSum + cacheWriteSum,
    cost: costSum,
    finalAnswer,
  };
}

const a = metrics(parse(fileA));
const b = metrics(parse(fileB));

console.log(`\n=== A: ${fileA} ===`);
a.toolCalls.forEach((c, i) => console.log(`  ${i + 1}. ${c}`));
console.log(`\n=== B: ${fileB} ===`);
b.toolCalls.forEach((c, i) => console.log(`  ${i + 1}. ${c}`));

console.log("\n=== Comparison ===");
console.log(`${"metric".padEnd(14)} ${"A".padEnd(12)} ${"B".padEnd(12)} delta (A-B)`);
console.log(`${"calls".padEnd(14)} ${String(a.calls).padEnd(12)} ${String(b.calls).padEnd(12)} ${a.calls - b.calls}`);
console.log(
  `${"new tokens".padEnd(14)} ${String(a.newTokens).padEnd(12)} ${String(b.newTokens).padEnd(12)} ${a.newTokens - b.newTokens}`,
);
console.log(
  `${"cost ($)".padEnd(14)} ${a.cost.toFixed(4).padEnd(12)} ${b.cost.toFixed(4).padEnd(12)} ${(a.cost - b.cost).toFixed(4)}`,
);

const pct = (((a.newTokens - b.newTokens) / Math.max(b.newTokens, 1)) * 100).toFixed(0);
console.log(`\nA uses ${pct}% ${a.newTokens >= b.newTokens ? "more" : "fewer"} tokens than B.`);

console.log("\n=== Final answers (check these match before trusting the token comparison!) ===");
console.log(`A: ${a.finalAnswer.slice(0, 300)}`);
console.log(`B: ${b.finalAnswer.slice(0, 300)}`);

if (full) {
  console.log("\n=== A: full tool result text ===");
  a.results.forEach((r, i) => console.log(`\n--- ${i + 1}. ${r.tool} (${r.chars} chars) ---\n${r.text}`));
  console.log("\n=== B: full tool result text ===");
  b.results.forEach((r, i) => console.log(`\n--- ${i + 1}. ${r.tool} (${r.chars} chars) ---\n${r.text}`));
}
