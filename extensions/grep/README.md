# Grep Extension for Pi

A Pi extension that wraps the grep command to provide powerful text search capabilities across codebases.

## Features

- Fast text pattern matching across files
- Support for regex patterns
- Case insensitive search
- Line number output
- Context lines support
- `filesOnly` — return just matching file paths (like `rg -l` / `grep -rl`)
- `filenamePattern` — search by file name/path glob (replaces `find -iname ...`), optionally combined
  with `pattern` to search only inside name-matching files (replaces `find ... | xargs grep`)
- `include` / `exclude` — scope content search by glob (maps to `rg -g` / `grep --include`/`--exclude`)
- `andPattern` — a second required pattern, applied as a narrowing filter (replaces `grep pat | grep pat2`)
- `queries` — run several related searches in one call with labeled sections in the result, instead of
  chaining shell commands with `echo "---"` separators
- Integration with Pi's tool system

## Installation

```bash
cp -r bash-grep ~/.pi/agent/extensions/
```

## Usage

Once installed, the `grep` tool becomes available to the Pi agent for searching text patterns in your codebase.

The extension registers a `grep` tool that can be used to:
- Search for text or regex patterns in files
- Perform recursive searches in directories
- Show line numbers for matches
- Provide context around matches
- Perform case insensitive searches

## Example Usage

```bash
# Search for a pattern recursively in the current directory
grep({ pattern: "function.*myFunction" })

# Search for an exact string with line numbers
grep({ pattern: "myString", lineNumbers: true })

# Search case insensitive
grep({ pattern: "myPattern", caseSensitive: false })

# Search with context around matches
grep({ pattern: "error", context: 2 })

# Just want file paths? Use filesOnly instead of parsing match lines yourself.
grep({ pattern: "TODO", filesOnly: true })

# Search by file name/path glob (replaces `find -iname "*Jenkinsfile*"`)
grep({ filenamePattern: "*Jenkinsfile*" })

# Find files by name, then search inside them (replaces `find ... | xargs grep -l ...`)
grep({ filenamePattern: "*Jenkinsfile*", pattern: "docker build", filesOnly: true })

# Scope a content search to certain file types (maps to rg -g / grep --include)
grep({ pattern: "TODO", include: "*.ts", exclude: "*.test.ts" })

# Narrow results with a second required pattern (replaces `grep pat dir | grep pat2`)
grep({ pattern: "Analytics", include: "*.kt", filesOnly: true, andPattern: "legal" })

# Run several related searches in one call instead of chaining shell commands
grep({
  queries: [
    { label: "jenkins files", filenamePattern: "*Jenkinsfile*", filesOnly: true },
    { label: "docker files", filenamePattern: "*Dockerfile*", filesOnly: true },
  ],
})
```