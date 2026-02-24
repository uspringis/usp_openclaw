# MCP Server OAuth - COMPLETED

**Date:** 2026-01-26 22:20 UTC

## Summary
Successfully connected claude.ai to Clawdbot via remote MCP server with OAuth 2.1.

## Key Issues Solved

1. **Tailscale Funnel path stripping** - Funnel strips path prefix when routing. Fixed by:
   - Adding routes for `/.well-known/*`, `/authorize`, `/token`, `/register` at root
   - Using full BASE_URL in form actions

2. **RFC8414/RFC9728 metadata paths** - Claude.ai expects metadata at:
   - `/.well-known/oauth-authorization-server/mcp-api` (not `/mcp-api/.well-known/...`)
   - Added wildcard routes: `/oauth-authorization-server/*`, `/openid-configuration/*`

3. **Form action paths** - Changed from relative `/authorize` to `${BASE_URL}/authorize`

## Final Configuration

**Tailscale Funnel:**
```
/            → 18789 (Gateway)
/mcp-api     → 3000 (MCP Server)
/.well-known → 3000
/authorize   → 3000
/token       → 3000
/register    → 3000
```

**MCP Server URL for claude.ai:**
```
https://ubuntu-uuhome.tail22ff7.ts.net/mcp-api/mcp
```

**Tools exposed:**
- `list_sessions` - List active Clawdbot conversations
- `send_message` - Send message to a conversation
- `get_history` - Get conversation history

## Service Setup
```bash
sudo systemctl enable clawdbot-mcp
sudo systemctl start clawdbot-mcp
```
