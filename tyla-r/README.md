# tyla

RStudio Bridge for the Tyla CLI - Execute R code in your RStudio session via the command line.

## How It Works

```
┌─────────────────────────────────────────┐
│           RStudio                        │
│                                          │
│  1. Run: tyla::start()                   │
│         ↓                                │
│  2. Listener watches ~/.tyla/commands/   │
│         ↓                                │
│  3. Executes code via sendToConsole()    │
│                                          │
└─────────────────────────────────────────┘
                    ▲
                    │ file-based
                    │ communication
                    ▼
┌─────────────────────────────────────────┐
│           Terminal                       │
│                                          │
│  $ tyla            (open the TUI)         │
│    → /run runs the current RStudio file  │
│                                          │
│  $ tyla agent "..."                      │
│    → edits files via the agent workflow  │
│                                          │
└─────────────────────────────────────────┘
```

## Installation

```r
# Install dependencies
install.packages(c("jsonlite", "later", "uuid"))

# Install from local source
install.packages("path/to/tyla-r", repos = NULL, type = "source")
```

## Quick Start

### Step 1: Start the Listener in RStudio

```r
library(tyla)
tyla::start()
```

You'll see:
```
Tyla listener started
Watching: ~/.tyla/commands
Use tyla::stop() to stop
```

### Step 2: Use the CLI from the Terminal

```bash
# Open the interactive TUI; /run executes the file open in RStudio
tyla

# Or run the agent workflow directly
tyla agent "Add error handling to the data loading functions"
```

## R Functions

| Function | Description |
|----------|-------------|
| `tyla::start()` | Start the listener |
| `tyla::stop()` | Stop the listener |
| `tyla::status()` | Show listener status |

## RStudio Addins

The package also provides RStudio Addins:

- **Start Tyla Server** - Start the listener
- **Stop Tyla Server** - Stop the listener
- **Tyla Server Status** - Show status

Access via: RStudio menu → Addins → Tyla

## How Communication Works

1. CLI writes command to `~/.tyla/commands/pending.json`
2. R listener detects the file (polling every 0.5s)
3. R executes the command via `rstudioapi::sendToConsole()`
4. R writes result to `~/.tyla/commands/result.json`
5. CLI reads the result and displays it

## License

MIT
