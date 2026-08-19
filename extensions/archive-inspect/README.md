# archive_inspect

JVM/Android artifact inspector for pi: read `.jar` / `.aar` / `.apk` / `.zip` / `.tar(.gz)` archives,
dump class signatures with `javap`, and find dependency artifacts in the Gradle/Maven caches — in one
tool call each, with no temp directories and no output floods.

It exists because the "what does this third-party dependency actually do, there's no source jar"
investigation is otherwise a 4–7 step bash pipeline (`unzip` → `find` → `javap` → `grep`) that leaves
litter in `/tmp` and pastes hundreds of class names into context.

## Install

Single-file extension, no runtime dependencies (Node builtins only).

```bash
mkdir -p ~/.pi/agent/extensions/archive-inspect
cp index.ts package.json ~/.pi/agent/extensions/archive-inspect/
# or, per project:  .pi/extensions/archive-inspect/
```

Try it without installing:

```bash
pi -e ./extensions/archive-inspect/index.ts -p "what does okhttp-eventsource 4.1.1 expose?"
```

`javap` (any JDK) is optional but recommended — see "Provenance tags" below.

## Parameters

| Param | Used by | Meaning |
|---|---|---|
| `action` | — | `list`, `find_class`, `signatures`, `strings`, `manifest`, `extract`, `locate_artifact` |
| `archive` | all but `locate_artifact` | Path to the archive. `~` is expanded and **one glob segment is resolved**, so the Gradle hash dir can be `.../4.1.1/*/okhttp-eventsource-4.1.1.jar`. If the glob matches several files the tool lists them and asks you to pick. |
| `classPattern` | `find_class`, `signatures` | Dotted or slashed class filter. With `*`/`?` it is a glob against the FQN and the simple name; without wildcards it is a case-insensitive substring match. Anonymous/synthetic classes (`Foo$1`, `Foo$$Lambda$2`) are hidden unless the pattern contains `$`. |
| `memberPattern` | `signatures` | Keep only member lines matching this (substring, or glob if it contains `*`/`?`). |
| `entryGlob` | `list`, `strings`, `extract` | unzip-style entry glob — `*` crosses `/`, so `*.class` matches nested entries. |
| `textPattern` | `strings` | Case-insensitive regex searched inside text entries (binary entries are detected and skipped). |
| `destDir` | `extract` | **Required.** Destination directory. Refused if inside `~/.gradle` / `~/.m2`, or if it is the archive's own directory. |
| `includePrivate` | `signatures` | `javap -p` instead of `-protected` (default: public + protected only). |
| `artifactQuery` | `locate_artifact` | `group:name:version` (any part optional/globbable) or a single free-form fragment matched against the whole coordinate. Two-part queries are tried both as `group:name` and as `name:version`. Omit to list the groups present in the caches. |
| `excludeQuery` | `locate_artifact` | Comma-separated substrings/globs to drop, matched against the coordinate **and** the file name — e.g. `"org.,androidx,com.android"` or `"sources,javadoc"`. |
| `limit` | all | Row cap (defaults: list 200, find_class 100, signatures 12, strings 100, locate 60). The header always reports the true total, so `limit:1` is the cheap way to *count*. |

## Bash idioms it replaces

| Instead of | Use |
|---|---|
| `unzip -l foo.jar` / `unzip -Z1 foo.jar` | `{action:"list", archive:"foo.jar"}` (name-sorted, sizes, capped) |
| `unzip -Z1 foo.jar \| grep -c '\.class$'` | `{action:"list", entryGlob:"*.class", limit:1}` → count in the header |
| `unzip -Z1 foo.jar \| grep -i EventSource` | `{action:"find_class", classPattern:"*EventSource*"}` |
| `mkdir -p /tmp/x && unzip -qo foo.jar -d /tmp/x "*.class" && for f in $(find /tmp/x -name '*.class'); do javap -classpath /tmp/x "$f"; done` | `{action:"signatures", classPattern:"com.foo.Bar"}` (no temp dir, synthetic/lambda noise dropped) |
| `unzip -p bar.aar classes.jar > /tmp/c.jar && javap -cp /tmp/c.jar com.foo.Bar` | `{action:"signatures", archive:"bar.aar", classPattern:"com.foo.Bar"}` (nested `classes.jar` / `libs/*.jar` handled in memory) |
| `unzip -p foo.jar META-INF/MANIFEST.MF`, `aapt2 dump xmltree app.apk --file AndroidManifest.xml` | `{action:"manifest"}` (binary AXML decoded in-process) |
| `unzip -p foo.jar proguard.txt \| grep -i keep` | `{action:"strings", textPattern:"keep", entryGlob:"*.txt"}` |
| `ls ~/.gradle/caches/modules-2/files-2.1 \| grep -viE "^(org\.\|androidx\|com\.android)"` | `{action:"locate_artifact", excludeQuery:"org.,androidx,com.android"}` |
| `find ~/.gradle/caches -path '*okhttp-eventsource*' -name '*.jar'` | `{action:"locate_artifact", artifactQuery:"okhttp-eventsource:4.1.1"}` |
| `unzip foo.zip -d out` (zip-slip risk) | `{action:"extract", destDir:"/tmp/scratch"}` — entries with `..`/absolute paths are refused **and listed** |

## Provenance tags (trust conditionally)

Every degraded path labels itself, so the agent's confidence can be conditional instead of blanket:

| Tag | Meaning |
|---|---|
| `source: javap` (per class block) | Exact: generics, `throws`, annotations included. |
| `source: classfile-parse` | Fallback used when javap is missing/cannot resolve that class. Names, modifiers and arity are right; **types are erased** — no generics, no `throws`, no annotations. |
| `source: none` | The class bytes could not be read/parsed at all (corrupt entry). |
| `source: plain-text XML` | AndroidManifest.xml was already text (typical for `.aar`). |
| `source: axml-decode` | Binary AndroidManifest.xml decoded in-process (validated against `aapt2 dump xmltree`). Resource references show as `@0x…` ids. |
| `source: axml-stringpool-partial` | AXML decode failed; output is an unstructured string dump — not the manifest's structure. |
| `warning: … source: local-header-scan` | The central directory was unreadable (truncated/corrupt archive); entries were recovered by scanning local file headers, so the listing may be incomplete. |

Safety properties (all covered by tests): never writes into `~/.gradle`/`~/.m2`; never decrypts or
prompts for zip passwords (encrypted entries are listed and clearly marked); refuses zip-slip entries
on `extract`; every temp dir it creates is `mkdtemp(arcx-)` and removed in a `finally`; output capped
at 40 KB with an explicit truncation notice.

`ARCX_DISABLE_JAVAP=1` forces the classfile-parse fallback (used for testing the degraded path).
