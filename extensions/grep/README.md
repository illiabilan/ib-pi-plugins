# Grep Extension for Pi

A Pi extension that wraps the grep command to provide powerful text search capabilities across codebases.

## Features

- Fast text pattern matching across files
- Support for regex patterns
- Case insensitive search
- Line number output
- Context lines support
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
```