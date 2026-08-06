# Active Subagents Widget Extension - Final Report

## Built

**Location:** `active-subagents-widget/index.ts`

**What it does:** A Pi extension that displays a real-time widget above the editor showing currently executing subagent tasks. The widget automatically appears when a subagent tool starts, updates elapsed time during execution, and disappears when all subagents complete.

## Validation Summary

### Claim tested
The active subagents widget correctly displays currently executing subagent tasks in real-time, updating when subagents start and complete, and clearing when all subagents finish.

### Method
**Empirical verification through instrumented testing:**

1. **Type-checking:** Verified TypeScript compilation with strict settings (`--noEmit --target es2022 --module esnext --moduleResolution bundler`)

2. **Smoke testing:** Loaded extension with `pi -e ./active-subagents-widget/index.ts --mode json` and verified zero runtime errors

3. **Event flow verification:** Traced actual `tool_execution_start`, `tool_execution_update`, and `tool_execution_end` events from real subagent tool calls using `pi --mode json` instrumentation:
   ```bash
   pi --mode json -p "Call subagent with agent=code_writer and task='list files'"
   # Observed sequence:
   # - tool_execution_start (toolName="subagent")
   # - tool_execution_update (×5 during 3-second execution)
   # - tool_execution_end (final result)
   ```

4. **Argument extraction testing:** Created isolated test script (`test-extraction.mjs`) that verified `extractAgentInfo` correctly handles:
   - Single mode: `{ agent: "scout", task: "..." }` → extracts agent name and task ✓
   - Parallel mode: `{ tasks: [{agent, task}, ...] }` → shows "parallel" with count ✓
   - Chain mode: `{ chain: [{agent, task}, ...] }` → shows "chain" with count ✓
   - Invalid/null args → returns null safely ✓
   - Missing fields → graceful degradation ✓

5. **Defensive programming verification:** Confirmed Map-based state management handles:
   - Multiple concurrent subagents (separate toolCallIds)
   - Missing tool_execution_start before update/end (no crash)
   - Session lifecycle events (cleanup on shutdown, clear on start)

### Result

**Extension operates correctly with measured behavior:**

✅ **Event handling verified:** All three tool execution events properly intercepted for subagent tool  
✅ **State management verified:** Map correctly tracks active subagents by toolCallId  
✅ **Argument parsing verified:** All three modes (single/parallel/chain) correctly extracted  
✅ **Lifecycle management verified:** Cleanup on session_start and session_shutdown  
✅ **Error handling verified:** Null/invalid args don't crash, gracefully degrade  

**Measured event flow from real execution:**
- Start event: Captures agent name, task, start timestamp → adds to Map → shows widget
- Update events: Fire naturally during execution (5 times in 3-second run) → refresh elapsed time
- End event: Removes from Map → hides widget if empty

### Bugs found and fixed

**Bug #1: Elapsed time not updating during execution**

**Symptom:** Widget showed elapsed time only at start; wouldn't update during long-running subagents (time would stay frozen at "0s" for the entire execution).

**Root Cause:** Widget only updated on `tool_execution_start` and `tool_execution_end` events. During execution, no mechanism triggered updateWidget to recalculate elapsed time.

**Discovery method:** While reviewing the pi-extension-builder skill's lifecycle section and comparing against the plan-mode example, noticed plan-mode's todos widget only updates on specific events. Realized my widget would have the same issue - time display calculated from `Date.now() - startTime` but never recalculated.

**Fix:** Added `tool_execution_update` event handler that calls `updateWidget(ctx)` to refresh the display. This leverages subagent tool's natural streaming updates (observed firing 5 times during a 3-second execution).

**Code added:**
```typescript
pi.on("tool_execution_update", async (event, ctx) => {
    if (event.toolName !== "subagent") return;
    if (!activeSubagents.has(event.toolCallId)) return;
    
    // Update widget to refresh elapsed time
    updateWidget(ctx);
});
```

**Verification:** Confirmed via `pi --mode json` trace that `tool_execution_update` events fire naturally during subagent execution, so elapsed time will update at those intervals.

### Adversarial cases tried

1. **Malformed subagent arguments:** Passed various invalid structures to `extractAgentInfo`:
   - `{ invalid: "data" }` → null returned ✓
   - `null` → null returned ✓
   - `{ agent: "scout" }` (missing task) → null returned ✓
   - `{ tasks: [] }` (empty array) → null returned ✓
   - Result: No crashes, graceful degradation

2. **Tool events without matching start:** Simulated `tool_execution_end` without prior `tool_execution_start`:
   - `Map.delete()` safely handles missing key (no-op)
   - `updateWidget()` called with empty Map → widget clears ✓

3. **Concurrent subagents:** Verified extraction logic for parallel mode:
   - `{ tasks: [{agent: "a", task: "x"}, {agent: "b", task: "y"}] }` → "parallel, 2 tasks in parallel" ✓
   - Each subagent call gets unique toolCallId (from Pi core)
   - Map tracks each independently ✓

4. **Session lifecycle edge cases:**
   - Extension load before session_start → no crash ✓
   - session_start with stale Map → Map.clear() ✓
   - session_shutdown → Map.clear() ✓

5. **Long task text:** Verified truncation logic:
   - Task > 60 chars → truncated with "..." ✓
   - Task exactly 60 chars → no truncation ✓
   - Task < 60 chars → displayed fully ✓

## Known Unverified Risks

1. **Visual appearance in actual TUI not verified.** Testing was done in `--mode json` to trace events. The widget's actual visual layout (colors, positioning, line wrapping, terminal width handling) has not been observed in a live TUI session. The theme color functions (`theme.fg("accent", ...)`) are correctly called, but their rendered appearance depends on the active theme, which varies.

2. **Timer update frequency depends on subagent streaming behavior.** Elapsed time updates only when `tool_execution_update` events fire. A subagent that produces no output/updates for extended periods (e.g., a long computation with no intermediate results) will show a stale elapsed time. The update frequency is controlled by the subagent tool's streaming implementation, not by this extension.

3. **Widget interaction with other extensions not tested.** If multiple extensions call `ctx.ui.setWidget("active-subagents", ...)` (same widget ID), later calls overwrite earlier ones. Widget ordering/stacking when multiple extensions use different IDs (above/below editor placement) hasn't been tested. Unlikely but theoretically possible conflict.

4. **Performance with many concurrent subagents (8+) not tested.** Verified logic for parallel mode argument extraction, but actual simultaneous execution of the maximum 8 parallel subagents (per subagent tool docs) hasn't been tested. Map operations scale well, but widget rendering with 8+ entries and frequent updates could have performance implications.

5. **Theme invalidation on mid-session theme change not explicitly tested.** Widget uses `ctx.ui.theme` on each `updateWidget()` call, which should handle theme changes dynamically. However, a `/reload` or theme change command during active subagent execution hasn't been tested to verify colors update immediately.

6. **Multi-line task text edge case.** Truncation logic assumes single-line task strings. If a subagent's task parameter contains newlines (unclear if possible from subagent tool schema), only the first line would be shown, truncated to 60 chars. The subagent tool's schema shows task as `Type.String()`, which can technically include newlines.

7. **RPC mode behavior not verified.** Extension guards widget calls with `ctx.hasUI`, which is true in both TUI and RPC modes. In RPC mode, `setWidget` is a no-op (per rpc.md), so the widget shouldn't appear, but this hasn't been explicitly tested via RPC client.

8. **Aborted/killed subagent cleanup.** If a subagent process is killed (e.g., Ctrl+C during execution) without Pi firing `tool_execution_end`, the Map entry persists until `session_shutdown`. This is a minor memory leak (one Map entry per aborted task). The subagent tool docs mention "Ctrl+C propagates to kill subprocess," but whether this guarantees `tool_execution_end` isn't documented.

9. **Widget name collision risk.** The widget ID is hardcoded as `"active-subagents"`. If another extension (user-written or from a package) happens to use the same ID, later calls overwrite earlier ones. This is an inherent limitation of Pi's widget API (IDs are just strings), not a bug in this extension, but worth noting.

## Files Changed

- **`active-subagents-widget/index.ts`** - Main extension implementation (widget display logic, event handlers, state management)
- **`active-subagents-widget/package.json`** - Package manifest for npm and type-checking dependencies
- **`active-subagents-widget/README.md`** - User-facing documentation (features, installation, usage, troubleshooting)
- **`active-subagents-widget/TEST.md`** - Test plan and manual test cases
- **`active-subagents-widget/VALIDATION_REPORT.md`** - Detailed validation findings
- **`active-subagents-widget/FINAL_REPORT.md`** - This comprehensive report
- **`~/.pi/agent/extensions/active-subagents-widget/index.ts`** - Installed copy for testing
