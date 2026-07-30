# Tyla — Agentic CLI for Code Analysis and Editing

**Tyla** is an agentic CLI tool that brings LLM-powered code editing, analysis, and tutoring directly into your terminal. It understands your project structure, reads relevant files automatically, and executes multi-step instructions — with a diff review before any file is touched.

```
tyla                                  # Interactive TUI (default)
tyla agent "Add error handling to the data loading pipeline"
```

---

## Features

- **Interactive TUI** — full-screen Ink-based terminal UI; the default entry point when you run `tyla` with no arguments
- **Agent mode** — give a natural language instruction; Tyla scans your files, reasons with ReAct loops, proposes edits, and applies them after you review the diff
- **Ask mode** — conversational Q&A with streaming output; automatically reads relevant files to answer questions about your project
- **Workflow modes** — `default`, `solver`, `tutor-socratic`, and `tutor-guide`, selected via the `workflowMode` field in `.tyla/settings.json` (tutor-guide can also be launched with `tyla --tutor`)
- **Guard agent** — probability-based LLM safety judge; screens user input in tutor modes before processing
- **Session memory** — conversations persist across calls; resume previous sessions with `--resume`
- **Rollback** — revert to any earlier session checkpoint via TUI slash command
- **Knowledge base** — store project-specific notes and conventions that the agent recalls automatically
- **Plugin system** — drop custom tools into `~/.tyla/plugins/` to extend agent capabilities
- **Multi-provider LLM** — OpenAI, Anthropic Claude, Azure OpenAI, Google Gemini, or local Ollama; auto-detected from API keys

---

## Requirements

- [Bun](https://bun.sh/) >= 1.0 (used instead of npm for all package management and script execution)
- Node.js >= 18 (runtime for the built CLI)
- R installed (for `run` and R-adapter tools)
- An API key for at least one supported LLM provider

---

## Installation

> **This project uses [Bun](https://bun.sh/) instead of npm.** Install Bun first if you haven't: `curl -fsSL https://bun.sh/install | bash`

```bash
cd tyla
bun install
bun run build

# Link globally (optional)
bun link
```

After linking, `tyla` is available as a global command.

---

## Configuration

Create a `.env` file in your R project directory:

```env
# Pick one provider — the first key found is used automatically
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_API_KEY=...
AZURE_OPENAI_API_KEY=...
OLLAMA_HOST=http://localhost:11434   # no key needed for local Ollama

# Optional overrides
LLM_PROVIDER=anthropic               # force a specific provider
LLM_MODEL=claude-3-5-sonnet-20241022 # override default model (this is the Anthropic default)
LLM_MAX_TOKENS=8192
```

Project data (sessions, knowledge base, settings) is stored in `.tyla/` inside your working directory. Plugin tools are global at `~/.tyla/plugins/`.

### Status bar

Customize the status bar items shown at the bottom of the TUI by editing `.tyla/settings.json`:

```json
{
  "statusBar": {
    "items": ["mode", "model", "context", "rpm"]
  }
}
```

Available items: `mode`, `model`, `context`, `rpm`, `cost`, `turn`, `duration`, `tps`, `latency`.

---

## Usage

### Interactive TUI (default)

```bash
tyla
```

Launches a full-screen terminal UI. Type instructions or slash commands directly.

```bash
# Start in tutor-guide mode (for assignment walkthroughs)
tyla --tutor

# Point to a specific assignment directory
tyla --assignment ./assignments/HW2
```

#### TUI slash commands

| Command | Description |
|---------|-------------|
| `/status` | Show current session ID, turn count, and token usage |
| `/run` | Run the current file in RStudio immediately (requires `tyla::start()` in RStudio) |
| `/new` | Start a new session (previous session is summarized) |
| `/rollback [n]` | Roll back the current session to after turn `n` (default: last turn) |
| `/rollback list` | List turns in the current session |
| `/rollback session list` | List recent saved sessions |
| `/rollback session <id> <n>` | Roll back a saved session to after turn `n` |
| `/policy` | Show the policy rules for the current workflow mode |
| `/stress-test` | Run automated red-teaming against the current mode |
| `/help` | List available commands |
| `/exit` | Exit the REPL |

---

### Agent mode — edit files

```bash
# One-shot instruction
tyla agent "Refactor hw11.R to use tidyverse pipes"

# Specify a workspace directory
tyla agent "Fix the ggplot theme" --directory ./analysis

# Resume the previous session (agent remembers prior changes)
tyla agent "Now add unit tests" --resume

# Resume a specific session by ID
tyla agent "Continue the refactor" --session <id>

# Force a new session
tyla agent "Start fresh" --new
```

The agent will:
1. Scan R files in the workspace
2. Read relevant files automatically
3. Reason step-by-step (ReAct loop)
4. Propose a diff for your review
5. Apply edits only after your confirmation

---

### Ask mode — Q&A without editing

```bash
tyla ask "What does the load_data function do?"
tyla ask "Why is my ggplot not rendering correctly?"
```

Streams the answer in real time. Uses the same session memory as agent mode.

---

### Knowledge base — cross-session memory

```bash
# Add a note
tyla knowledge add "ggplot theme" "Always use theme_minimal() in this project" --tags ggplot2,style

# Add interactively (omit content)
tyla knowledge add "data conventions"

# List all entries
tyla knowledge list

# Search
tyla knowledge search "ggplot"

# Remove
tyla knowledge remove <id>
```

Entries are stored at `.tyla/knowledge.json` and injected into agent context automatically.

---

## Architecture

The CLI follows Clean Architecture with dependency flowing inward:

```
tyla/src/
├── domain/           # Entities, interfaces, lib, policies, repositories, types, values (no external deps)
├── application/
│   ├── orchestration/  # Orchestrator, ReAct loop, ToolRegistry
│   ├── ports/          # R-bridge port interface
│   ├── prompts/        # Prompt templates & section builders
│   ├── services/       # AgentService, SlashCommandRouter, DiffEngine, ModeManager, IntentRouter, ...
│   ├── tools/          # FileScanTool, FileReadTool, FileEditTool, PdfReadTool,
│   │                   # RExecTool, RInstallTool, RRenderTool, LibraryScanTool
│   └── use-cases/      # execute-ask, execute-instruction, execute-tutor, execute-run, execute-install
├── infrastructure/
│   ├── api/          # LLM gateway (llm/) + guard/, tutor/, logging/, shared/ helpers
│   │                 # Providers: OpenAI / Anthropic / Azure / Gemini / Ollama
│   ├── bootstrap/    # AgentFactory (wires all deps together)
│   ├── config/       # Paths, settings, constants, policy-loader, profile
│   ├── filesystem/   # File scanner, finder, resolver, plugin-loader
│   ├── pdf/          # PDF text extractor
│   ├── persistence/  # Session + knowledge repositories
│   └── r-adapter/    # R path detection, script runner, package installer, library scanner
├── cli/              # Commander-based one-shot CLI
│   ├── index.ts      # CLI composition root (startCLI)
│   ├── controller/   # CliAgentController
│   └── presentation/ # Agent, ask, knowledge, rollback presenters + views
├── tui/              # Ink-based interactive TUI
│   ├── index.tsx     # TUI entry point (startTUI)
│   ├── controller/   # AppController (React/Ink state machine)
│   └── presentation/ # App, ChatHistory, DiffReview, StatusBar, Footer, ...
├── tutors/           # Per-mode prompt definitions (default, solver, tutor-guide, tutor-socratic)
├── composition/      # createAgentController factory
└── shared/           # Cross-cutting types, utils, i18n, view-models
```

**Key flows:**

| Mode | Pipeline |
|------|----------|
| `agent` | Intent classify → Orchestrator → ReAct loop → Evaluator → Diff review → Apply |
| `ask` | File scan → Read relevant files → Stream LLM response |
| `solver` | Orchestrator → ReAct loop with solver prompt → Diff review → Apply |
| `tutor-*` | Guard check → File scan → Stream tutor response (no file writes) |
| Multi-step | Triggered by keywords (`then`, `also`, `first`, `each`) → sequential Orchestrator steps |

**Entry dispatch** (`src/index.ts`):
- `tyla` (no args) → TUI
- `tyla --tutor` or `tyla --assignment <path>` → TUI in tutor-guide mode
- `tyla agent/ask/knowledge ...` → CLI (Commander)

---

## Development

> **This project uses [Bun](https://bun.sh/) instead of npm.**

```bash
cd tyla

# Run without building
bun run dev -- agent "your instruction"
bun run tyla -- agent "your instruction"

# Build
bun run build

# Run tests (must be inside tyla/)
bun run test

# Run a single test file
bun run test -- path/to/test.test.ts
```

---

## Project structure (full repo)

```
project-root/
├── tyla/           # TypeScript CLI (this tool)
├── tyla-r/         # R package — RStudio-side bridge (tyla::start())
├── test-r-project/ # Sample R project used for manual/e2e testing
├── config/         # Shared secrets / environment config
├── db/             # Database migrations
├── docs/           # Architecture notes, API and usage docs
├── plans/          # Planning documents (architecture plans, gap analyses)
├── skills/         # Agent skill definitions
├── config.ru, Gemfile, Rakefile   # Optional Ruby backend (Roda) harness
```

The Ruby backend is optional — the CLI talks directly to LLM APIs by default.

---

## License

MIT
