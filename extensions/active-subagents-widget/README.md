# Active Subagents Widget

A Pi extension that displays a real-time widget showing currently executing subagent tasks.

## Features

- **Real-time display:** Widget appears above the editor when subagents are running
- **Live updates:** Elapsed time updates as the subagent executes (via tool_execution_update events)
- **Multiple modes supported:**
  - Single agent: Shows agent name and specific task
  - Parallel mode: Shows "parallel" with task count
  - Chain mode: Shows "chain" with step count
- **Automatic cleanup:** Widget disappears when all subagents complete
- **Session-aware:** Clears on session changes to prevent stale data

## Installation

### User-level (recommended)
```bash
mkdir -p ~/.pi/agent/extensions/active-subagents-widget
cp index.ts ~/.pi/agent/extensions/active-subagents-widget/
```

### Project-level
```bash
mkdir -p .pi/extensions/active-subagents-widget
cp index.ts .pi/extensions/active-subagents-widget/
```

## Usage

The widget activates automatically when a subagent tool is called. No configuration needed.

**Example prompts that trigger the widget:**
- "Use code_writer to list all TypeScript files"
- "Run 2 scouts in parallel: one to find models, one to find providers"
- "Use a chain: scout → planner → worker to implement feature X"

**Widget display:**
```
Active Subagents (1)
  ● code_writer (5s)
    list all TypeScript files
```

**Multi-agent display:**
```
Active Subagents (1)
  ● parallel (12s)
    2 tasks in parallel
```

## Widget Layout

- **Header:** Shows count of active subagents
- **Per-agent entry:**
  - Spinner indicator (●)
  - Agent name (colored with accent theme)
  - Elapsed time in seconds (or "Xm Ys" for >60s)
  - Task description (truncated to 60 chars if longer)

## Requirements

- Pi coding agent with subagent extension installed
- TUI mode (widget doesn't display in print/JSON modes)

## How It Works

The extension listens to three tool execution events:

1. **tool_execution_start:** Adds subagent to active Map, shows widget
2. **tool_execution_update:** Refreshes elapsed time display
3. **tool_execution_end:** Removes subagent from Map, hides widget if empty

**State management:**
- Uses a Map to track active subagents by toolCallId
- Stores agent name, task, and start timestamp
- Cleared on session_start and session_shutdown for clean state

## Customization

To modify the widget appearance, edit `index.ts`:

- **Widget placement:** Change `setWidget` call to use `{ placement: "belowEditor" }`
- **Time format:** Modify the time calculation in `updateWidget`
- **Task truncation:** Adjust `maxTaskLength` variable (default: 60 chars)
- **Theme colors:** Modify `theme.fg()` calls for different colors

## Troubleshooting

**Widget doesn't appear:**
- Verify subagent extension is installed: `ls ~/.pi/agent/extensions/subagent`
- Check extension loaded: Look for it in extension list
- Ensure you're in TUI mode (not `--mode json` or `-p`)

**Stale data after session change:**
- Extension should auto-clear on session events
- Try `/reload` to reset extension state

**Timer not updating:**
- Timer updates only when tool_execution_update events fire
- Subagents with infrequent updates may show stale time briefly

## Known Limitations

1. Widget only updates when tool events fire (not continuously)
2. Aborted/killed subagents may leave stale entries until session cleanup
3. Task text truncated to 60 characters
4. Multi-line tasks show only first line

## License

MIT (or whatever license your Pi installation uses)

## See Also

- [Pi Documentation](https://github.com/earendil-works/pi-coding-agent)
- [Subagent Extension](https://github.com/earendil-works/pi-coding-agent/tree/main/examples/extensions/subagent)
- [TUI Components Guide](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/tui.md)
