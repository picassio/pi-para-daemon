# pi-para-daemon

Background knowledge capture daemon for [pi-para](https://github.com/picassio/pi-para). Processes pi session files into wiki pages using an Agent with session exploration tools.

## How it works

1. The pi-para extension registers completed sessions in `~/.pi/wiki/.completed-sessions`
2. The daemon watches this file for new entries
3. For each session, it spins up an Agent that explores the session using tools:
   - `session_stats` — overview of the session (message count, topics)
   - `session_search` — search for keywords
   - `session_slice` — read specific sections
4. The Agent writes wiki pages via `wiki_write`, `wiki_query`, `wiki_read`
5. Pages are deduplicated against existing wiki content

## Install

```bash
cd pi-para-daemon
npm install
```

Requires `@picassio/pi-para` and `@picassio/qmd` as local dependencies.

## Usage

```bash
# Start daemon (foreground)
npx tsx src/cli.ts start

# Process a specific session
npx tsx src/cli.ts process <session.jsonl>

# Process all recent unprocessed sessions
npx tsx src/cli.ts process-recent --hours 24

# Check status
npx tsx src/cli.ts status

# Show history
npx tsx src/cli.ts history
npx tsx src/cli.ts history --scope pi-mono

# Retry failed sessions
npx tsx src/cli.ts retry-failed
```

## Configuration

Uses the same LLM providers as `@picassio/qmd` from `~/.config/qmd/index.yml`:

```yaml
providers:
  chat:
    url: https://api.minimaxi.com/anthropic
    key: sk-cp-...
    model: MiniMax-M2.7-highspeed
    api: anthropic
```

## Architecture

```
pi session (.jsonl)
  → extension registers in .completed-sessions on /quit
  → daemon picks up via file watch (5s poll)
  → Agent explores session with session_slice/search/stats tools
  → Agent writes wiki pages via wiki_write
  → SQLite state DB tracks processed sessions (dedup by content hash)
```

The daemon reuses `@picassio/pi-para` modules (wiki.ts, store.ts, frontmatter.ts) — no duplication.

## License

MIT
