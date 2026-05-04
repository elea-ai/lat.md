# Parser

Markdown parsing built on unified/remark v11. Entry point: [[src/parser.ts]]. Parse → render fidelity is verified by [[tests/roundtrip]].

## Wiki Links

Custom micromark + mdast extension implementing [[markdown#Wiki Links]]. Located in `src/extensions/wiki-link/` (see [[src/extensions/wiki-link/syntax.ts]] for the tokenizer).

Built in-house because third-party packages (`mdast-util-wiki-link`, `@portaljs/remark-wiki-link`) are broken with remark v11 / mdast-util-from-markdown v2.

### Wiki Link Node

A `wikiLink` node has `value` (the target string) and `data.alias` (string or null). Registered into mdast's `RootContentMap`, `PhrasingContentMap`, micromark's `TokenTypeMap`, and mdast-util-to-markdown's `ConstructNameMap` via module augmentation.

## Sections

A section is a heading plus everything under it until the next same-or-higher-depth heading. Parsed by [[src/lattice.ts#parseSections]].

Each section has:
- `id` — hierarchical path: `file#H1#H2#...` where the first segment is the project-root-relative file path (without `.md`) and every heading level is included: `lat.md/dev-process#Dev Process#Testing#Running Tests`, `lat.md/tests/search#Search Tests#RAG Replay Tests`
- `heading` — the heading text
- `depth` — markdown heading level (1–6)
- `file` — project-root-relative file path without `.md` (e.g. `lat.md/dev-process`, `lat.md/tests/search`)
- `filePath` — project-root-relative file path with extension (e.g. `lat.md/dev-process.md`, `src/config.ts`)
- `children` — nested subsections forming a tree
- `startLine` / `endLine` — source positions in the original file
- `firstParagraph` — first paragraph text (used by [[cli#Section Preview]])

[[markdown#Frontmatter]] is handled by `remark-frontmatter`, which parses it as a `yaml` AST node so heading positions reflect the original file.

## Short Ref Resolution

References can use just the file name (without directory path) when the name is unique across the vault. Short refs only work for markdown files in `lat.md/`; source code references always require the full path.

For example, `[[search#Provider Detection]]` resolves to `lat.md/tests/search#Search Tests#Provider Detection` if there's only one `search.md` in the vault. If multiple files share the same name, the full path is required — `lat check` reports ambiguous refs as errors.

The root (h1) heading can be omitted in references: `[[backend#CORS]]` resolves to `lat.md/backend#Backend#CORS` because the h1 heading is implicit from the file. Both `resolveRef()` and `findSections()` handle this by trying to insert root headings when a direct match fails.

The file index ([[src/lattice.ts#buildFileIndex]]) maps all trailing path suffixes to their full paths. For `lat.md/guides/setup`, both `guides/setup` and `setup` are indexed. All keys are lowercase for case-insensitive lookup.

Resolution is handled by [[src/lattice.ts#resolveRef]] for strict contexts (`lat check`, `lat refs`) where authored links must resolve unambiguously. Lenient contexts (`lat locate`, `lat expand`) use [[src/lattice.ts#findSections]] directly, which has its own file stem expansion built in — it does not call `resolveRef`.

## Refs Extraction

[[src/lattice.ts#extractRefs]] walks the AST for [[parser#Wiki Links#Wiki Link Node]] nodes and returns the target, enclosing section id, file, and line number.

## Source Symbol Extraction

Source symbols are resolved by [[src/source-parser.ts#parseSourceSymbols]]. Most languages use tree-sitter (via `web-tree-sitter`); SQL uses a regex-based scanner because no prebuilt WASM SQL grammar ships with the bundled set.

The SQL scanner in [[src/source-parser.ts#extractSqlSymbols]] walks every top-level `CREATE [OR REPLACE] ...` declaration, captures the declared name (supporting `"quoted"`, `` `backtick` ``, `[bracket]`, and `schema.name` forms), and records the statement's line range. For `CREATE TABLE`, [[src/source-parser.ts#extractSqlTableColumns]] parses the parenthesized column list and emits each column as a child symbol parented to the table. Comments, single-quoted strings, and Postgres dollar-quoted bodies are skipped by [[src/source-parser.ts#skipSqlToken]] so their contents don't terminate statements or confuse paren balancing.

`@lat:` code comments in SQL use the `--` line-comment prefix — [[src/code-refs.ts#LAT_REF_RE]] accepts any of `//`, `#`, or `--` before the marker.
