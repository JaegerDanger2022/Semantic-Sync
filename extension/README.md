# Semantic Sync

Chat with your codebase using AI. Semantic Sync indexes your project files and lets you ask questions about your code from a VS Code sidebar — powered by an Elastic AI agent with semantic search.

## Features

- **AI chat sidebar** — Ask questions about your codebase in natural language
- **Semantic search** — The agent retrieves the most relevant files to answer your question, with source citations
- **Automatic sync** — Files are re-indexed on save so your index stays current
- **Multi-project support** — Index multiple repos and filter chat by project
- **Usage tracking** — See how many tokens and files you've indexed

## Getting Started

1. Open a workspace that has a GitHub remote configured
2. Click the Semantic Sync icon in the Activity Bar
3. Sign in with GitHub
4. Click **Index Workspace** to index your files
5. Ask questions about your code in the chat input

> A `.gitignore` file is required in your workspace root to control which files get indexed.

## Commands

| Command | Description |
|---|---|
| `Semantic Sync: Authenticate` | Sign in with GitHub |
| `Semantic Sync: Index Workspace` | Index (or re-index) your workspace |
| `Semantic Sync: Sign Out` | Sign out and clear local auth state |

## Requirements

- A GitHub remote must be configured on your workspace (`git remote add origin ...`)
- A `.gitignore` file in the workspace root (the extension will offer to create one if missing)

## Privacy

Only files matching `.md`, `.ts`, `.js`, `.json`, and `.py` extensions are indexed. Files and folders matched by your `.gitignore` are excluded, along with `node_modules`, `.git`, `dist`, `build`, and `.next`.
