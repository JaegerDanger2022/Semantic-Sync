# Semantic Sync Extension

Semantic Sync indexes your local project files into an Elasticsearch Serverless backend and lets you chat with an Elastic AI agent from a VS Code sidebar.

## Commands

- `Semantic Sync: Authenticate` - shows your persistent user ID.
- `Semantic Sync: Index Workspace` - scans the workspace and sends content to the ingest API.

## Backend

The extension sends POST requests to:

- `http://localhost:8000/api/ingest`
- `http://localhost:8000/api/chat`
