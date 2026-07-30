# Usage Guide

Tyla is an agentic CLI. Running `tyla` with no arguments opens the interactive
TUI; the sub-commands below (`agent`, `ask`, `knowledge`) are the one-shot CLI.

## ⚡ Quick Start (the "Active Session" workflow)

To run or edit R code against a live RStudio session, connect the CLI to RStudio.

**1️⃣ In the RStudio console** — start the listener so RStudio can receive commands:

```r
tyla::start()
```

**2️⃣ In your terminal** — launch Tyla from your R project directory:

```bash
tyla                      # interactive TUI (default)
tyla agent "Add error handling to the data loading functions"
```

> Only `/run` and the R tools (execute / install / library scan) require the
> RStudio listener. Plain `ask` and file edits work without it.

---

## 📖 Command Reference

The CLI exposes three sub-commands. Everything else (running a file, scanning the
project, installing packages) is either a TUI slash command or an agent tool the
LLM invokes for you during `agent` mode — not a stand-alone CLI command.

### `tyla` — Interactive TUI (default)

Launches the full-screen Ink TUI. Type instructions or slash commands directly.

```bash
tyla                                  # open the TUI in the current directory
tyla --tutor                          # start in tutor-guide mode
tyla --assignment ./assignments/HW2   # tutor-guide mode for a specific assignment
```

Common slash commands inside the TUI:

| Command | Description |
|---------|-------------|
| `/status` | Show session ID, turn count, and token usage |
| `/run` | Run the current RStudio file immediately (needs `tyla::start()`) |
| `/new` | Start a new session (previous session is summarized) |
| `/rollback [n]` | Roll back the current session to after turn `n` |
| `/rollback list` | List turns in the current session |
| `/rollback session list` | List recent saved sessions |
| `/rollback session <id> <n>` | Roll back a saved session to after turn `n` |
| `/policy` | Show the policy rules for the current workflow mode |
| `/stress-test` | Run automated red-teaming against the current mode |
| `/help` | List available commands |
| `/exit` | Exit the REPL |

The workflow mode (`default`, `solver`, `tutor-socratic`, `tutor-guide`) is set
via the `workflowMode` field in `.tyla/settings.json`, not by a slash command.

### `tyla agent` — AI-powered file editor

Runs the autonomous agent workflow to edit project files from a natural-language
instruction. Files are scanned and read automatically; every change is presented
as a diff for your approval before anything is written to disk.

```bash
# One-shot instruction
tyla agent "Refactor hw11.R to use tidyverse pipes"

# Specify a workspace directory
tyla agent "Fix the ggplot theme" --directory ./analysis

# Resume the last saved session (agent remembers previous changes)
tyla agent "Now add unit tests" --resume

# Resume a specific session by ID
tyla agent "Continue the refactor" --session <id>

# Force a new session (ignore the last one)
tyla agent "Start fresh" --new
```

Flags: `-d, --directory <path>`, `--resume`, `--session <id>`, `--new`.

The agent's R capabilities (execute a script, install a package, scan installed
libraries) run as tools during the ReAct loop and require `tyla::start()`.

### `tyla ask` — Q&A without editing

Conversational Q&A with streaming output. Reads relevant files automatically to
answer questions about your project; never writes to disk. Shares session memory
with `agent`.

```bash
tyla ask "What does the load_data function do?"
tyla ask "Why is my ggplot not rendering correctly?"
```

### `tyla knowledge` — cross-session memory

Store project-specific notes and conventions that the agent recalls automatically.
Entries live at `.tyla/knowledge.json`.

```bash
tyla knowledge add "ggplot theme" "Always use theme_minimal()" --tags ggplot2,style
tyla knowledge add "data conventions"      # interactive: omit content to be prompted
tyla knowledge list
tyla knowledge search "ggplot"
tyla knowledge remove <id>
```

---

## Configuration

Set your LLM credentials in a `.env` file in your project directory (the first
provider key found is used automatically):

```env
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_API_KEY=...
AZURE_OPENAI_API_KEY=...
OLLAMA_HOST=http://localhost:11434

# Optional overrides
LLM_PROVIDER=anthropic
LLM_MODEL=claude-3-5-sonnet-20241022
LLM_MAX_TOKENS=8192
```

Project data (sessions, knowledge, settings) is stored under `.tyla/` in the
working directory; plugin tools are global at `~/.tyla/plugins/`.
