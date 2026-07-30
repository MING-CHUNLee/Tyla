# Installation Guide

## Prerequisites

Before using Mindy CLI, ensure you have the following installed:

- **RStudio IDE** (v2023.03+ recommended)
- **Bun** (v1.0+) — used instead of npm for all package management. Install via: `curl -fsSL https://bun.sh/install | bash`
- **Node.js** (v18.0.0+) — runtime for the built CLI
- **R Package**: `mindy` (The bridge between CLI and RStudio)

## Step 1: Install the R Bridge Package

You need the `mindy` R package installed to allow the CLI to communicate with RStudio.
Run this in your R console:

```r
# Install from GitHub
remotes::install_github("MING-CHUNLee/MindyRtd-CLI", subdir = "tyla-r")
```

## Step 2: Install the CLI

Currently, the CLI is installed from source (local installation).

```bash
# 1. Clone the repository
git clone https://github.com/MING-CHUNLee/MindyRtd-CLI.git
cd MindyRtd-CLI/cli

# 2. Install dependencies & build
bun install
bun run build

# 3. Link globally
bun link
```

Now you can use the command `mindy-cli` or the alias `mrc` from anywhere.

## Step 3: Configuration (Required for LLM)

To use the intelligent features (context building & analysis), you need to configure your LLM provider.

1. Create a `.env` file in the directory where you run the CLI (or in the CLI installation folder).
2. Add your API keys:

```env
# Example .env file

# Provider: openai, anthropic, azure, or ollama
LLM_PROVIDER=openai

# API Keys
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...

# Optional: Custom Model
LLM_MODEL=gpt-4-turbo
```
