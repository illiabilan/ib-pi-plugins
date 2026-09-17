# figma

Figma design context for Pi, bridged through a headless Claude Code subprocess.

## Why a bridge and not an MCP server

Pi's MCP adapter cannot connect to Figma's hosted server:

```
GET  https://mcp.figma.com/.well-known/oauth-protected-resource  -> 200
POST https://api.figma.com/v1/oauth/mcp/register                 -> 403 Forbidden
```

Figma allow-lists OAuth client registration by `client_name` and only grants the
`mcp:connect` scope to clients in the Figma MCP Catalog. Claude Code is in that
catalog and ships a pre-registered client id (`j0TWr6EUpxlvY8yi4WpU6h`), so it
can hold a valid session where pi cannot.

The desktop (Dev Mode) server at `http://127.0.0.1:3845/mcp` needs no OAuth, but
its "Enable desktop MCP server" toggle was not available on this account.

So this tool shells out to `claude -p` and returns its answer. Claude is used as
an authenticated transport, not as a coding agent.

## Setup

```bash
claude mcp add --transport http --scope user figma https://mcp.figma.com/mcp
claude mcp login figma        # needs a TTY + browser
```

Verify from pi: `figma {"action":"status"}`.

## Usage

```jsonc
// read-only (default)
{"prompt":"Exact colors, spacing, font sizes and radii of the header, as tokens",
 "figmaUrl":"https://figma.com/design/abc/Encore?node-id=12-34"}

// cheap lookup
{"prompt":"List every component in this file with its variants","model":"haiku","figmaUrl":"..."}

// write image assets into cwd
{"prompt":"Download the icons used in this frame as SVG","mode":"assets","figmaUrl":"..."}

// canvas mutation — opt in per call
{"prompt":"Create a frame with these three states","mode":"write","figmaUrl":"..."}
```

## Safety

The child process runs with:

- `--tools "Read,Grep,Glob"` + `--restricted` — no Bash/Edit/Write/WebFetch, and the
  read-only file tools are confined to the working directory plus
  `~/.claude/projects`. Verified: a prompt asking to read
  `~/.pi/agent/mcp.json` was refused with
  *"is outside ... --restricted confines the file tools to the working directory"*
  and appeared in `permission_denials`.

  The file tools are required, not a convenience: when a Figma response exceeds
  Claude's output limit (`get_metadata` on a whole section is ~1M chars / 339k
  tokens) Claude Code saves it to
  `~/.claude/projects/<slug>/<session>/tool-results/` and only tells the model
  the path. With no file tool the bridge can only answer "the response was too
  large" — which is exactly how its first real query failed.
- `--strict-mcp-config` + inline `--mcp-config` — only the `figma` server is
  loaded; other configured MCP servers never start.
- `--allowedTools <explicit read-only list>` in the default `mode:"read"`.
  `create_new_file`, `generate_figma_design`, `upload_assets`, `update_shader`
  and `send_code_connect_mappings` are simply absent from the allow-list, so
  prompt injection through design content cannot reach them.
- `--no-session-persistence` — no conversation is written to disk.

Verified: with `mode:"read"`, a prompt explicitly asking to create a Figma file
produced `permission_denials: [mcp__figma__create_new_file]` and created nothing.
Denials are surfaced in the result footer.

The child is spawned `detached` so a timeout kills the whole process group
(`claude` starts its own children), leaving no orphans.

## Link granularity matters

The hosted server is link-based and has no depth control: `get_metadata` takes
only `fileKey` + `nodeId` and always returns the full subtree.

- A link to a **section** (e.g. a 14702×9744 canvas region holding dozens of
  screens) produces a 1M-char dump, and `get_design_context` answers
  *"You currently have nothing selected"*.
- A link to a **single frame** (e.g. a 390×844 screen) returns full layout, text,
  colors, variables and component variants in one call.

So: right-click the screen -> *Copy link to selection*. If the caller only has a
section link, ask the bridge to list that node's direct children first, then
re-ask about one child.

## Cost

Figma's 37 tool definitions cost ~31–40k prompt tokens on every cold call:

| model | observed cost/call |
|---|---|
| `haiku` | ~$0.016–0.049 |
| `sonnet` (default) | ~$0.10 |

Prompt caching makes calls within ~5 minutes cheaper. Ask for everything about a
frame in one call rather than several narrow ones.
