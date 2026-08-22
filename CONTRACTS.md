# Contracts

The interfaces the packages build against. Change these deliberately, in one
commit, with every consumer updated.

## Ghost home (`ghost-home/v1`)

One directory per ghost. Plain files; anything derivable (memory index, note
catalog) is derived per session and never stored.

```
~/Ghosts/<name>/
  character.md                 persona → system prompt (frontmatter: public: true, title)
  notes/**/*.md                YAML frontmatter: public: false by default; optional
                               title, tags, archived, path (pre-sanitization app path)
  memory/*.md                  atomic memory files: frontmatter description + updated,
                               body = the fact
  memory/.visitors/<id>/*.md   per-visitor memory, same format; dot-folder keeps it
                               out of the creator's default view but inspectable
  conversations/*.json         transcripts (import fixture from the hosted export;
                               the daemon's own sessions live in pi session storage)
  export-manifest.json         present in imported archives; counts, pathRewrites,
                               notIncluded
```

Terminology: **visitors**, never "callers".

## Daemon HTTP API (localhost only)

- `GET  /api/ghosts` → `[{ name, dir, createdAt }]`
- `POST /api/ghosts` `{ name }` → creates `~/Ghosts/<name>/` with a seeded
  `character.md`
- `POST /api/ghosts/:name/messages` — the **pi-messages wire protocol**
  (request `{ model, context, options }` → SSE stream of pi-messages events).
  The pinned client in the summon-ghost repo is the normative spec
  (`~/github.com/ferdousbhai/summon-ghost`, read-only reference).
- `GET  /api/ghosts/:name/sessions` → pi session listing for that ghost.

Bind to `127.0.0.1`. No auth in v1 (localhost trust); revisit before any
non-local exposure.

## Package boundaries

- `packages/extensions` — pure pi extensions + ghost-home fs helpers. No HTTP,
  no daemon lifecycle. Exports the extension factories and the ghost-home
  reader/writer.
- `packages/daemon` — per-ghost `AgentSession` lifecycle, env scrubbing,
  credential injection, the HTTP API, systemd unit. Depends on `extensions`.
- UI package: TBD (Omarchy shell technology decision pending).

## Known pi 0.84.2 gotchas (from the spike, scratchpad pi-spike-report.md)

- `createAgentSession({ agentDir })` does NOT redirect session storage — use
  `SessionManager.create(cwd, sessionDir)` or sessions land in global `~/.pi`.
- Scrub inherited env before session creation: stray provider API keys
  (e.g. `GEMINI_API_KEY`) silently add cloud models to a sovereign ghost.
- Parallel tool calls: wrap shared-file mutations in a file mutation queue.
- Tools should throw structured errors, not return `isError` payloads.
