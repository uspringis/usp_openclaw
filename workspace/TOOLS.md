# TOOLS.md - Local Notes

Skills define *how* tools work. This file is for *your* specifics — the stuff that's unique to your setup.

## Twitter/X

- **bird CLI** for reading Twitter (installed globally)
- Credentials: `/home/uspringis/clawd/.bird-credentials`
- AI List ID: `1896301018171777201` (https://x.com/i/lists/1896301018171777201)
- To fetch list: `source .bird-credentials && bird list-timeline $BIRD_LIST_ID -n 50 --auth-token "$BIRD_AUTH_TOKEN" --ct0 "$BIRD_CT0"`

## Google Workspace (gws)

**CLI:** `gws` v0.22.3 — official Google Workspace CLI (https://github.com/googleworkspace/cli)
**Account:** `ugis.springis@gmail.com` (OAuth, keyring backend)

### Gmail
- List: `gws gmail users messages list --params '{"userId": "me", "maxResults": 10, "q": "is:unread"}'`
- Read: `gws gmail users messages get --params '{"userId": "me", "id": "<msgId>", "format": "full"}'`
- Search: `gws gmail users messages list --params '{"userId": "me", "q": "<gmail query>"}'`
- Send: `gws gmail users messages send --params '{"userId": "me"}' --json '{"raw": "<base64>"}'`
- Schema: `gws schema gmail.users.messages.<method>`

### Calendar
Query all three calendars:
- `primary` (ugis.springis@gmail.com — personal)
- `0sujs5vl4o2c5tsatu54ei6v50@group.calendar.google.com` (BUS)
- `family10512579686066508808@group.calendar.google.com` (Family)

- List events: `gws calendar events list --params '{"calendarId": "primary", "timeMin": "<iso>", "timeMax": "<iso>", "singleEvents": true, "orderBy": "startTime"}'`
- Create event: `gws calendar events insert --params '{"calendarId": "primary"}' --json '{"summary": "...", "start": {"dateTime": "..."}, "end": {"dateTime": "..."}}'`
- Update event: `gws calendar events patch --params '{"calendarId": "primary", "eventId": "<id>"}' --json '{"summary": "..."}'`
- Delete event: `gws calendar events delete --params '{"calendarId": "primary", "eventId": "<id>"}'`

### Other services
- Drive, Sheets, Docs, Tasks, People, Chat — all available via `gws <service> <resource> <method>`
- Workflows: `gws workflow +standup-report`, `+meeting-prep`, `+weekly-digest`, etc.
- Schema discovery: `gws schema <service.resource.method>`

**"Work calendar" = Proof IT Exchange calendar** (not Google). Use `email_util.py` for work calendar events.

## SSH Hosts

### superdev
- **Host:** `uspringis@100.80.103.123`
- **Command:** `ssh uspringis@100.80.103.123`
- **Notes:** Ugis's dev machine alias

## Exchange (EWS)

- **Script:** `scripts/email_util.py`
- **Run with:** `~/clawd/.venv/bin/python ~/clawd/scripts/email_util.py <command>`
- **Server:** `services.proofit.lv`
- **Email:** `Ugis.Springis@proofit.lv`
- **Commands:** check, read [N], send TO SUBJ BODY, search QUERY, calendar [DAYS], pending [DAYS], freebusy EMAIL [DAYS], meeting SUBJ "YYYY-MM-DD HH:MM" DURATION EMAILS [BODY]

## What Goes Here

Things like:
- Camera names and locations
- SSH hosts and aliases  
- Preferred voices for TTS
- Speaker/room names
- Device nicknames
- Anything environment-specific

## Examples

```markdown
### Cameras
- living-room → Main area, 180° wide angle
- front-door → Entrance, motion-triggered

### SSH
- home-server → 192.168.1.100, user: admin

### TTS
- Preferred voice: "Nova" (warm, slightly British)
- Default speaker: Kitchen HomePod
```

## Why Separate?

Skills are shared. Your setup is yours. Keeping them apart means you can update skills without losing your notes, and share skills without leaking your infrastructure.

---

Add whatever helps you do your job. This is your cheat sheet.
