# Pi Code Search Extension

A powerful code navigation tool for Pi dev that uses tree-sitter for fast, syntax-aware code search across your codebase.

## Features

- 🚀 **Syntax-Aware Parsing**: Uses tree-sitter for accurate code parsing
- 🔍 **Fuzzy Search**: Smart matching with partial names and wildcards
- 📚 **Symbol Indexing**: Automatically indexes functions, classes, types, variables, methods, and more
- 🎯 **Type Filtering**: Filter results by symbol type (functions, classes, interfaces, etc.)
- 📂 **File Type Filtering**: Search within specific languages (TypeScript, Python, Rust, Go, etc.)
- 🌐 **Multi-Language Support**: TypeScript, JavaScript, Python, Rust, Go, Java, C++, Ruby, PHP
- ⚡ **Performance**: Debounced auto-indexing for large codebases

## Installation

### Option 1: Copy to Extensions Directory

```bash
# From the pi-plugins repo root
cp -r tools/code-search ~/.pi/agent/extensions/

# Install dependencies
cd ~/.pi/agent/extensions/code-search
npm install

# Start Pi and it will auto-load
cd /path/to/your/project
pi
```

### Option 2: Use with --extension Flag

```bash
# From the pi-plugins repo root
cd tools/code-search
npm install

# Run Pi with the extension
pi -e ./code-search.ts
```

### Option 3: Project-Local

```bash
# From the pi-plugins repo root, inside your target project
cp -r tools/code-search /path/to/your/project/.pi/extensions/
cd /path/to/your/project/.pi/extensions/code-search
npm install
```

## Usage

### Interactive Search

Type `/code-search` in Pi to open the interactive symbol search interface. Type to filter symbols - supports fuzzy matching.

```bash
/code-search
# Type to filter, e.g., "auth" or "render*"
```

### Rebuild Index Manually

Force a re-index of your codebase:

```bash
/code-index
```

### LLM Tool Usage

The LLM can call the `code_search` tool directly:

```typescript
{
  "name": "code_search",
  "parameters": {
    "query": "authenticate",
    "symbolType": "function",
    "fileType": "typescript",
    "limit": 20
  }
}
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | string | Search query. Supports partial matches and `*` wildcards |
| `symbolType` | string | Filter by type: `function`, `class`, `interface`, `type`, `variable`, `method`, `import`, `export`, `const`, `let` |
| `fileType` | string | Filter by language: `typescript`, `javascript`, `python`, `rust`, `go`, `java`, `cpp`, `ruby`, `php` |
| `limit` | number | Maximum results (default: 50) |

### Example Queries

```bash
# Search for auth-related functions
/code-search authenticate

# Use wildcards
/code-search render*

# The LLM can search like this:
# tool: code_search({ query: "UserModel", symbolType: "class" })
```

## How It Works

1. **Indexing**: On session start, the extension scans your project for source files and parses them using tree-sitter (or regex fallback)

2. **Symbol Extraction**: Extracts functions, classes, interfaces, types, variables, methods, imports, and exports

3. **Search**: Uses a combination of:
   - Exact matching
   - Prefix matching
   - Contains matching
   - Fuzzy matching (skip characters)
   - Wildcard patterns

4. **Ranking**: Results are sorted by relevance score (exact match > startsWith > contains > fuzzy)

## Supported Languages

- TypeScript (`.ts`, `.mts`, `.cts`)
- TSX (`.tsx`)
- JavaScript (`.js`, `.mjs`, `.cjs`, `.jsx`)
- Python (`.py`, `.pyi`)
- Rust (`.rs`)
- Go (`.go`)
- Java (`.java`)
- C++ (`.cpp`, `.cc`, `.cxx`, `.hpp`, `.hh`, `.hxx`)
- C (`.c`, `.h`)
- Ruby (`.rb`)
- PHP (`.php`)
- Kotlin (`.kt`, `.kts`)

Adding another language is just a matter of adding an entry to `queries.ts` — the `tree-sitter-wasms` package we depend on bundles ~30 prebuilt grammars (Swift, C#, Scala, Dart, Elixir, Bash, etc.) beyond the ones wired up here.

## Configuration

The extension automatically ignores these directories:
- `node_modules/`
- `dist/`
- `build/`
- `.git/`
- `.next/`
- `coverage/`
- `*.min.js` files
- Source map files (`.map`)

## Tips

1. **Initial Index**: The first index build may take a moment for large codebases
2. **Auto-Index**: The index is rebuilt automatically on `/reload`
3. **Manual Index**: Use `/code-index` to force a re-index after adding new files
4. **Fuzzy Search**: `rend` will match `renderComponent`, `renderToString`, etc.
5. **Wildcards**: `use*` matches `useState`, `useEffect`, `useMemo`, etc.

## Troubleshooting

### Symbols Not Found

1. Run `/code-index` to rebuild the index
2. Check that your files aren't in an ignored directory
3. Verify the file extension is supported

### Performance Issues

- The extension uses debounced indexing (2 second delay)
- Large codebases may take longer for initial index
- Consider adding more ignore patterns to `ignorePatterns` in the source

### "No API key" Error

This extension doesn't require any API keys - it runs entirely locally using tree-sitter.

## License

MIT
