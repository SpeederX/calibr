# Specs

One small, atomic feature or decision per file, named after the behavior
(`config-cli.md`, `vram-headroom-indicator.md`). A spec answers **what**:

1. **Goal** — one sentence.
2. **Background** — why this matters (link out to design or roadmap).
3. **Behavior** — what the user sees / what the API does.
4. **Acceptance criteria** — testable, verifiable.
5. **Out of scope** — explicit non-goals.

A spec is implementable on its own. Larger work that spans multiple specs
gets a plan in `../plans/`. See `../architecture/README.md`.

## Index

- [config-cli.md](config-cli.md) — `llm-lab config <list|get|set|unset|detect>`
