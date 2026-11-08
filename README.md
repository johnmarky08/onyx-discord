# Onyx — Hack4Success 2026 Discord bot

Verification, private team spaces and final submissions for the COESC x OCTA hackathon.
Node 20+, discord.js 14 (Components V2 everywhere), MongoDB via mongoose.

**Intents:** in Developer Portal → Bot → Privileged Gateway Intents turn on **Server Members Intent** (joins/leaves/nicknames). Optional: **Message Content Intent** if you set `ENABLE_MESSAGE_LOGS=true`.

## 1. Create the bot

1. Discord Developer Portal → New Application → Bot → copy the **token**.
2. Invite with scopes `bot` + `applications.commands` and the **Administrator** permission
   (or at least Manage Roles, Manage Channels, Manage Nicknames, View Channels, Send Messages).
3. In the server, drag the **Onyx role above** the participant role and the team roles
   (Server Settings → Roles). Bots can't assign or rename anything above their own role.

## 2. Run

```bash
npm install
cp .env.example .env     # fill DISCORD_TOKEN and MONGODB_URI
npm start                # npm run dev for auto-reload
npm test                 # 46 tests (logic, payload validation, mocked flows)
```

Set `DEV_GUILD_ID` while testing so slash commands appear instantly.

## 3. Set up the server (one command)

Run **`/onyx setup`** and pick, from the dropdowns: participant role, facilitator role, welcome channel,
submission channel, a **facilitators-only submissions board channel**, an optional **server log channel**, and whether to lock the server until verified. Press **Deploy**.
Onyx then: locks permissions, posts the welcome panel and the submission panel, and builds every team's space.

Register teams with **`/team add name: members: track:`**, e.g. `members: Dela Cruz, Juan; Santos, Maria; Reyes, Ana` (3–5 people),
or in bulk with **`/team import file:`** (CSV, one member per row: `Team name,Last name,First name,Track`).

## Participant flow

Welcome panel → **Verify** → modal (team name, last name, first name) → team looked up in MongoDB and the name
matched against that team's roster (from `/team add`; word order doesn't matter, each name can be claimed once) →
nickname `[ Team Name ] Last Name, First Name` → participant role + team role → ephemeral welcome.
Nicknames over Discord's 32-char limit are trimmed with `…`.

## Team space (per team)

```
⊂⊃  ﹕  team name  !  ୧            ← category (lower-cased team name)
  ．💬．𓂃．team-chat                ← text
  ．🔊．𓂃．team-collab              ← voice
```

Visible only to that team's role, the facilitator role and the bot.

## Submissions

Submission panel: **Submit Repository** (GitHub link), **Submit Presentation** (upload a **PDF or PPTX** file, max 25 MB), **My Team's Status**. Everything is ephemeral. A confirm step precedes saving; the first confirmed
submission per team per item is locked (MongoDB unique index), teammates are told to notify facilitators.
Deadline: Nov 12 2026, 12:00 NN PHT — panel buttons disable automatically and submits are refused after it.

## Submissions board (facilitators only)

In the board channel Onyx keeps one header (progress bars + deadline) and **one live card per team**. A card updates the
moment the team submits: the GitHub link (with an _Open repository_ button) and the **PDF/PPTX attached right on the card**,
so judges can open it without leaving the channel. Cards are colour-coded: ⚪ waiting · 🟡 1 of 2 · 🟢 complete.
Resets (`/submissions reset`), team edits and unverifies refresh the card too.

## Server log (facilitators only)

Everything is logged as a compact card with the member's avatar: joins, leaves, nickname/role changes, timeouts, bans,
channel/role/server changes, invites, voice join/leave/move, verification (successes **and** failed attempts),
submissions, team add/edit/remove/import, setup/sync/deadline changes and bot errors.
Changes Onyx makes itself are logged once (by the purpose-built entry), not twice. Deleted/edited messages are opt-in
via `ENABLE_MESSAGE_LOGS=true`.

## Facilitator commands

| Command                                                       | What it does                                                                                         |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `/onyx setup` / `status` / `sync`                             | wizard · health check · repair/re-apply everything                                                   |
| `/onyx deadline when:2026-11-12 12:00`                        | change the deadline (PHT)                                                                            |
| `/team add` `edit` `import` `remove` `list` `info` `unverify` | manage teams: `edit` renames (role, category, nicknames follow), changes track, adds/removes members |
| `/submissions list` `export` `reset`                          | review, CSV export, unlock a team to resubmit                                                        |

## Collections

`guildconfigs`, `teams` (the participants model: team + members), `submissions`.

## Editing event details / looks

`src/config/event.js` (dates, tracks, file types/size) · `src/config/style.js` (names, colours).

## Presentation files

The file is checked (extension _and_ real PDF/PPTX bytes), then copied into the team's private text channel by Onyx
(so teammates can't delete it). The stored link is a permanent Discord message link; `/submissions export` lists it.
The size cap is also limited by your server's upload limit (10 MB unless boosted).
