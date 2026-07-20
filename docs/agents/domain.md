# Domain docs

How engineering skills consume this repository's domain documentation while exploring the codebase.

## Before exploring

- Read `CONTEXT.md` at the repository root when it exists.
- Read relevant accepted decisions under `docs/adr/`.
- If a future `CONTEXT-MAP.md` exists, follow it to the context documents relevant to the task.

If a context file does not exist, proceed silently. Domain-document producer workflows create it when terminology or decisions are resolved.

## Layout

This is a single-context repository:

```text
/
├── CONTEXT.md       # optional, created when domain language is resolved
├── docs/adr/        # system-wide architectural decisions
└── src/
```

## Vocabulary and decisions

- Use the domain vocabulary defined in `CONTEXT.md`; do not replace explicit terms with synonyms.
- When a required concept is absent, record the gap for a domain-document workflow rather than inventing terminology silently.
- Surface any conflict with an accepted ADR explicitly instead of overriding it implicitly.
