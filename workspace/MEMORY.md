# MEMORY.md — Long-Term Memory

*Last updated: 2026-02-23*

## Identity
- Name: Axion
- Human: Ugis Springis (CEO, Proof IT)
- Platform: OpenClaw on ubuntu-uuhome (Azure VM, Tailscale)

## Family
- **Emilija** — Ugis's daughter
- **Lizete Dzirnas** — attends dance classes (Riga). Schedule synced weekly to Family calendar via cron (daily 20:00). Source: Google Sheets spreadsheet with weekly tabs.

## Key Projects & Interests
- **Proof IT** — ~100 people, insurance platform (multi-tenant), custom dev for government/enterprises, AI Solutions division (started 2025)
- **Noresca** — Ugis's sailboat. Contact: Linards (yacht valve project)
- **Ingredivo** — Food/recipe management MVP (Next.js 15, built by Claude Code agent on superdev). Completed Jan 2026.
- **Compensa Life** — Insurance client. AI prototype for KYC/customer data gathering in progress.
- **BTA** — Insurance client.

## Infrastructure
- **superdev** — Ugis's dev machine (ssh uspringis@100.80.103.123 via Tailscale)
- **MCP Server** — Remote MCP connecting claude.ai to OpenClaw. OAuth 2.1, Tailscale Funnel for public paths, Serve for tailnet-only WebUI. URL: `https://ubuntu-uuhome.tail22ff7.ts.net/mcp-api/mcp`
- **Exchange (EWS)** — `scripts/email_util.py`, server: services.proofit.lv. TLS cert only covers services.proofit.lv (not mail.proofit.lv). Timezone fixed to Europe/Riga with proper DST handling.
- **Tailscale setup** — Funnel exposes MCP paths (port 3000), Serve exposes WebUI (port 18789) tailnet-only. Don't reset Funnel when changing Serve config.

## Active Cron Jobs
- **AI Twitter Digest** — Daily 8:00 AM. Uses `bird` CLI (cookie auth, may need refresh). Delivers to Telegram. Known issue: bird query ID cache breaks when X reorganizes JS bundles — may need manual fix.
- **Bolt Invoice Processor** — Daily 9:00 AM. Scans Gmail for Bolt Work Profile reports, extracts invoice PDFs, forwards to ugis.springis@proofit.lv. Tracks processed IDs to avoid duplicates.
- **Lizete Dzirnas Schedule** — Daily 20:00. Syncs dance schedule from Google Sheets to Family calendar. Each class as separate event.
- **Daily Maintenance** — Daily 4:00 AM. Runs `openclaw update --no-restart`, `clawhub sync`, then gateway restart LAST (after reporting results to Telegram).

## Lessons Learned
- `openclaw update` restarts gateway by default — use `--no-restart` in cron jobs, restart manually as the last step after reporting
- Cron sessions get killed by gateway restart — always send report before restarting
- Bird CLI uses cookie auth (auth_token + ct0) that expires — check `.bird-credentials` if fetches fail
- X periodically reorganizes JS bundles breaking bird's query ID discovery — may need manual injection
- Telegram message limit is 4096 chars — long digests may fail delivery
- Don't load MEMORY.md in shared/group contexts (security)

## Pending Items
- [ ] Create AI prototype for customer data gathering — Compensa Life (KYC, customer needs)
- [ ] Demonstrate Clawdbot integration — Proof IT
- [ ] Intars Geidans (Metal Expo contact) — call about voice sales
- [ ] Get Riga airport visit materials for AI ideas
- [ ] Prepare presentation for Botswana
- [ ] Nosutit Martai YouTube materialus par AI
- [ ] Write to Linards on yacht valve project — Noresca
- [ ] Zemesgrāmatā reģistrēt būvi
- [x] Emilija sickness tracker — resolved, file deleted 23.02

## Preferences (Ugis)
- Concise, no emojis, no filler
- Technical language OK
- Latvian for personal/family context, English for work/tech
- Prefers plain text over markdown tables in Telegram
