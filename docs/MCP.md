# Using QA-Core as an MCP server

QA-Core ships an MCP (Model Context Protocol) server that exposes its workflows as tools: `qa_explore`, `qa_resume`, `qa_transcribe`, `qa_generate`, `qa_heal`. Once installed, you can drive QA-Core directly from Claude Desktop, Cursor, Cline, Continue, Zed, or anything else that speaks MCP.

## What this unlocks

- **No gateway, no UI, no clone-and-run.** Your AI editor talks to the QA-Core server directly.
- **Composition.** In Claude Desktop you can chain QA-Core with other MCP servers, for example "explore https://staging.example.com against this SRS, then create a Linear ticket for every finding."
- **The same pipeline as the CLI.** Planner, Explorer, Critic with one repair pass, Reality-Check replay, Stability, framework emission and zip. Every `qa_explore` argument maps onto the same request object the CLI builds from its flags, so a tool call and a terminal run with the same ask run the same options (this is locked by a smoke test, `smoke-surface-parity`).

## Prerequisites

- Node.js 20+
- The QA-Core repo checked out somewhere on disk
- `npm install` has been run inside the repo
- `npx playwright install chromium` (the server drives a real browser)
- An `ANTHROPIC_API_KEY`, set in the MCP client's env block (NOT the `.env` file; MCP launches the server in its own env)

## Installing in Claude Desktop

Open `claude_desktop_config.json` and add a `qa-core` entry under `mcpServers`. Replace `/absolute/path/to/qa-core-agent` with the actual checkout path.

```json
{
  "mcpServers": {
    "qa-core": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/qa-core-agent/src/mcp/server.ts"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-...",
        "QA_CORE_PROJECT_ROOT": "/absolute/path/to/qa-core-agent",
        "QA_CORE_COST_CEILING": "2.00"
      }
    }
  }
}
```

**Config locations:**

| Platform | Path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

Restart Claude Desktop. You should see `qa-core` appear in the tools menu.

## Installing in Cursor

Cursor uses `~/.cursor/mcp.json`. Same shape:

```json
{
  "mcpServers": {
    "qa-core": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/qa-core-agent/src/mcp/server.ts"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-...",
        "QA_CORE_PROJECT_ROOT": "/absolute/path/to/qa-core-agent"
      }
    }
  }
}
```

## Installing in Cline (VS Code)

Open the Cline panel, then MCP Servers, then Edit configuration. Same JSON shape as above.

## Tools the server exposes

| Tool | What it does | Typical duration |
|---|---|---|
| `qa_explore` | Drive a real browser through a URL (or a discovered page set), run the full pipeline, emit a Page Object Model framework and zip. Returns the run summary, the reconciliation funnel, rule coverage on SRS runs, and the report and zip paths. | 60s to several minutes |
| `qa_resume` | Continue a run that stopped early (cost ceiling, billing, API failure) from its `checkpoint.json`. Only the remaining scenarios are explored; completed traces and critic verdicts are restored. | depends on what is left |
| `qa_transcribe` | Regenerate the framework and zip from an existing `run-report.json`. No browser, no model call. | 1 to 5s |
| `qa_generate` | Single-shot user story to spec. Faster but UNVERIFIED; run it before trusting it. | 5 to 15s |
| `qa_heal` | Open the live page an existing spec targets, probe every locator, re-resolve the broken ones (same ladder as exploration, same element confirmed). Writes fixes back, reports the rest. Deterministic, no model. | 15 to 40s |

### `qa_explore` arguments

Every argument names its CLI equivalent. Defaults match the CLI.

| Argument | Type | CLI flag | Meaning |
|---|---|---|---|
| `url` | string, required | `<url>` | The entry URL (http:// or https://). |
| `language` | `ts` or `js`, default `ts` | `--lang` | Output language of the generated framework. |
| `features` | string[] | `--features login,cart` | Feature names to steer the Planner. Omit and the Planner infers 2 to 3 flows from the page. |
| `srs` | string | `--srs <file>` | Path to an SRS document (.md/.txt/.pdf/.docx), relative to the project root or absolute. Builds a requirements map for rule-first planning and a rule-coverage report. |
| `srsText` | string | `--srs` (inline form) | The SRS content inline, when the client holds the text rather than a file. Written to `output/.uploads/` and treated like `srs`. Ignored when `srs` is given. |
| `urls` | string[] | `--urls /login,/cart` | Explicit page list for multi-page discovery. |
| `discover` | boolean, default false | `--discover` | Multi-page discovery ladder (sitemap, polite crawl, entry-only). Also activated by `urls` or `srs`. |
| `pom` | boolean, default true | `--no-pom` / `--inline` when false | Page Object Model framework and zip (true) or a single inline spec (false). |
| `name` | string | `--name` | Output basename override. |
| `replay` | boolean, default true | `--no-replay` when false | Reality-check replay pass. |
| `stability` | boolean, default true | `--no-stability` when false | Stability iteration. |
| `stabilityIterations` | integer, default 3 | `--stability N` | Stability re-runs per scenario. |
| `stabilize` | boolean, default true | `--no-stabilize` when false | Stage 5b Stabilizer on flaky scenarios. |
| `stabilizeAttempts` | integer, default 3 | `--stabilize-attempts N` | Max Stabilizer fix attempts per flaky scenario. |
| `ceilingUsd` | number | `--ceiling` (env `QA_CORE_COST_CEILING`, default 2.00) | Per-run cost ceiling. Completed scenarios are salvaged when it is hit, and a checkpoint is left for `qa_resume`. |
| `repairReserve` | number in [0, 1) | `--repair-reserve` (env `QA_CORE_REPAIR_RESERVE`, default 0.15) | Fraction of the ceiling reserved for the critic repair pass. |
| `maxSteps` | integer | `--max-steps` (env `QA_CORE_MAX_STEPS`, default 40) | Hard ceiling on Explorer tool calls. |
| `plannerModel` | string | `--planner-model` (env `QA_CORE_PLANNER_MODEL`) | Planner model id. |
| `explorerModel` | string | `--explorer-model` (env `QA_CORE_EXPLORER_MODEL`) | Explorer model id. |
| `criticModel` | string | `--critic-model` (env `QA_CORE_CRITIC_MODEL`) | Critic model id. |

The setting arguments (`ceilingUsd` through `criticModel`) are applied through the same env names the CLI reads, for that run only.

### `qa_resume` arguments

| Argument | Type | CLI flag | Meaning |
|---|---|---|---|
| `checkpointPath` | string, required | `--resume <path>` | Path to the `checkpoint.json` a stopped run left behind. URL, language, features, page set, requirements map, completed traces and verdicts are restored from it. |
| `ceilingUsd`, `repairReserve`, `maxSteps`, `plannerModel`, `explorerModel`, `criticModel` | as above | as above | Setting overrides for the continuation. Raising `ceilingUsd` is the usual reason to resume. |

### `qa_transcribe` arguments

| Argument | Type | CLI | Meaning |
|---|---|---|---|
| `reportPath` | string, required | `npm run transcribe -- <path>` | Path to an existing `run-report.json`. |
| `outDir` | string | `--out <dir>` | Output directory override. Defaults to the report's own directory. |

### `qa_generate` arguments

| Argument | Type | Meaning |
|---|---|---|
| `story` | string, required | The user story or acceptance criteria. Vague stories produce vague tests; be specific. |
| `language` | `ts` or `js`, default `ts` | Output language of the generated spec. |
| `baseUrl` | string | Optional base URL to bake into the generated spec. |

### `qa_heal` arguments

| Argument | Type | Meaning |
|---|---|---|
| `specPath` | string, required | Path to the spec file (relative to project root or absolute). |
| `baseUrl` | string | Target URL override when the spec has no absolute goto. |

### CLI options without an MCP form

| CLI flag | Why |
|---|---|
| `--review` / `--from-plan` | Review mode pauses for a CSV edit at the terminal. There is no plan-editing round trip over MCP. |
| `--out` | The MCP server writes under `QA_CORE_PROJECT_ROOT/output/` so the dashboard and `qa-core://runs` can find every run. |
| `--env NAME=VALUE` | The generic form of the setting flags. MCP exposes each setting as a typed argument instead. |

## Resources the server exposes

| URI | Contents |
|---|---|
| `qa-core://runs` | Recent run directories under `output/` with status: completed, or stopped with a checkpoint (resume with `qa_resume`), plus report and checkpoint paths |
| `qa-core://memory` | All per-host site fingerprints from `.qa-core/sites/` |

## Trying it out

In Claude Desktop, after restart, just chat:

> "Use qa-core to explore https://www.saucedemo.com/ for login and cart, with a $3 ceiling."

Claude will:

1. Call `qa_explore` with `url=https://www.saucedemo.com/`, `features=["login","cart"]`, `ceilingUsd=3`
2. The server runs Planner, Explorer, Critic (with one repair pass), Reality-Check and Stability
3. The framework is written to `output/saucedemo-automation-framework/` and zipped alongside
4. The tool result includes the run summary and the reconciliation funnel (planned = generated + dropped + incomplete + findings + skipped)
5. If the run stopped at the ceiling, the result names the checkpoint and Claude can call `qa_resume` with a higher `ceilingUsd`

## Configuration env vars

All optional except `ANTHROPIC_API_KEY`. Sensible defaults are baked in. Every setting here can also be overridden per call through the tool arguments above.

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | *(required)* | Your Anthropic API key, used for Planner / Explorer / Critic |
| `QA_CORE_PROJECT_ROOT` | `process.cwd()` | Where `output/` and `.qa-core/` are written |
| `QA_CORE_COST_CEILING` | `2.00` | Cost ceiling per run in USD (older `QA_CORE_MAX_USD` still works) |
| `QA_CORE_REPAIR_RESERVE` | `0.15` | Fraction of the ceiling reserved for the repair pass |
| `QA_CORE_MAX_STEPS` | `40` | Hard ceiling on tool calls per `qa_explore` |
| `QA_CORE_PLANNER_MODEL` | `claude-haiku-4-5` | Override the Planner's model (older `QA_CORE_MODEL_PLANNER` still works) |
| `QA_CORE_EXPLORER_MODEL` | `claude-opus-4-7` | Override the Explorer's model (older `QA_CORE_MODEL_EXPLORE` still works) |
| `QA_CORE_CRITIC_MODEL` | `claude-sonnet-4-6` | Override the Critic's model (older `QA_CORE_MODEL_CRITIC` still works) |
| `QA_CORE_MODEL_TRANSCRIBE` | `claude-sonnet-4-6` | Override the model used by `qa_generate` |

## Troubleshooting

**The server doesn't appear in my client.** Check the client's log. Claude Desktop logs to `~/Library/Logs/Claude/mcp*.log` on macOS. The most common cause is a wrong absolute path in `args`.

**`ANTHROPIC_API_KEY is not set` error.** The MCP client launches the server in an isolated env. The key in your shell's `.zshrc` or the project's `.env` file is **not** inherited. Put it in the `env` block of the MCP config.

**Tool times out.** `qa_explore` legitimately takes a minute or more, longer for multi-page runs. Most clients accept this. If yours doesn't, run `npm run gateway` and use the web UI instead.

**Chromium not found.** Run `npx playwright install chromium` once inside the project root.

## Running the server standalone (for debugging)

```bash
npm run mcp
```

Then pipe MCP-formatted JSON-RPC into stdin. Easier: use the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```bash
npx @modelcontextprotocol/inspector npx tsx src/mcp/server.ts
```

That opens a UI where you can list tools, call them, and inspect resource reads.
