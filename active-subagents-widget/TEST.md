# Active Subagents Widget - Test Plan

## Falsifiable Claim
The active subagents widget correctly displays currently executing subagent tasks in real-time, updating when subagents start and complete, and clearing when all subagents finish.

## Test Cases

### Test 1: Basic Single Subagent
**Setup:** Extension loaded, subagent extension available
**Action:** Run a simple subagent task
**Command:** Use scout to list all TypeScript files
**Expected:**
- Widget appears when subagent starts
- Shows "Active Subagents (1)"
- Displays agent name "scout"
- Shows task text
- Shows elapsed time that increments
- Widget disappears when complete

### Test 2: Parallel Mode
**Action:** Run multiple subagents in parallel
**Command:** Run 2 scouts in parallel: one to find all .ts files, one to find all .md files
**Expected:**
- Widget shows "Active Subagents (2)" or updates count
- Shows "parallel" as agent name
- Shows "2 tasks in parallel" as task description
- Widget disappears when all complete

### Test 3: Chain Mode
**Action:** Run subagents in a chain
**Command:** Use a chain: first have scout find TypeScript files, then have planner summarize findings
**Expected:**
- Widget shows "Active Subagents (1)" initially
- Shows "chain" as agent name
- Shows "N steps chained" as task description
- Widget updates/persists through chain steps
- Widget disappears when chain completes

### Test 4: Long Task (Time Display)
**Action:** Run a subagent task that takes >60 seconds
**Expected:**
- Time display shows seconds for <60s
- Time display shows "Xm Ys" format after 60s
- Time updates continuously

### Test 5: Task Text Truncation
**Action:** Run a subagent with a very long task description (>60 chars)
**Expected:**
- Task text is truncated to ~60 chars with "..." ellipsis
- Widget doesn't overflow or break layout

### Test 6: Session Events
**Action:** Start a subagent task, then trigger session events
**Expected:**
- Widget clears on session_start
- Widget clears on session_shutdown
- No crashes or stale data

### Test 7: Widget Placement
**Action:** Run with other widgets present
**Expected:**
- Widget appears above editor (default placement)
- Doesn't conflict with other extensions' widgets
- Clears properly when no active subagents

### Test 8: Error Handling
**Action:** Manually trigger tool_execution_end without prior start
**Expected:**
- No crash
- Widget handles missing data gracefully

## Adversarial Cases

### A1: Malformed Arguments
**Action:** Subagent tool called with unexpected/missing parameters
**Expected:**
- extractAgentInfo returns null
- No widget appears (graceful degradation)
- No crash

### A2: Concurrent Overlapping Executions
**Action:** Multiple subagent tool calls in rapid succession
**Expected:**
- Widget shows all active subagents
- Correct count displayed
- Each completes and is removed independently

### A3: Session Reload During Execution
**Action:** Start long subagent task, then /reload
**Expected:**
- Widget clears on reload
- No stale state persists
- No crash

## Manual Test Run Log

Date: 2026-07-31
Tester: pi-builder agent

### Test 1: Basic Single Subagent
Result: [TO BE FILLED]

### Test 2: Parallel Mode
Result: [TO BE FILLED]

### Test 3: Chain Mode
Result: [TO BE FILLED]

### Test 4: Long Task
Result: [TO BE FILLED]

### Test 5: Task Text Truncation
Result: [TO BE FILLED]

### Test 6: Session Events
Result: [TO BE FILLED]

### Test 7: Widget Placement
Result: [TO BE FILLED]

### Test 8: Error Handling
Result: [TO BE FILLED]

### A1: Malformed Arguments
Result: [TO BE FILLED]

### A2: Concurrent Overlapping
Result: [TO BE FILLED]

### A3: Session Reload During Execution
Result: [TO BE FILLED]

## Bugs Found and Fixed
[TO BE FILLED]

## Known Unverified Risks
[TO BE FILLED]
