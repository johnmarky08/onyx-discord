// Server log: every important event, as a small aesthetic card in the log channel.
import { GuildConfig } from "../models/index.js";
import { STYLE } from "../config/style.js";
import {
  container,
  sep,
  text,
  titleCase,
  ts,
  v2,
  withThumb,
  avatarOf,
  kv,
} from "./ui.js";
import { warn } from "./logger.js";

/** Every kind of log entry: icon, title, accent colour and the group shown in the footer. */
export const KINDS = {
  // members
  "member.join": {
    emoji: "📥",
    title: "Member joined",
    color: STYLE.ok,
    group: "Members",
  },
  "member.leave": {
    emoji: "📤",
    title: "Member left",
    color: STYLE.error,
    group: "Members",
  },
  "member.nick": {
    emoji: "✏️",
    title: "Nickname changed",
    color: STYLE.warn,
    group: "Members",
  },
  "member.roles": {
    emoji: "🏷️",
    title: "Roles updated",
    color: STYLE.warn,
    group: "Members",
  },
  "member.timeout": {
    emoji: "⏳",
    title: "Timeout changed",
    color: STYLE.warn,
    group: "Moderation",
  },
  "member.ban": {
    emoji: "🔨",
    title: "Member banned",
    color: STYLE.error,
    group: "Moderation",
  },
  "member.unban": {
    emoji: "🕊️",
    title: "Member unbanned",
    color: STYLE.ok,
    group: "Moderation",
  },
  // verification
  "verify.ok": {
    emoji: "✅",
    title: "Participant verified",
    color: STYLE.ok,
    group: "Verification",
  },
  "verify.again": {
    emoji: "🔁",
    title: "Participant re-verified",
    color: STYLE.cyan,
    group: "Verification",
  },
  "verify.fail": {
    emoji: "🚫",
    title: "Verification failed",
    color: STYLE.rose,
    group: "Verification",
  },
  "verify.undo": {
    emoji: "↩️",
    title: "Participant unverified",
    color: STYLE.warn,
    group: "Verification",
  },
  // submissions
  "submit.repo": {
    emoji: "🗂️",
    title: "Repository submitted",
    color: STYLE.gold,
    group: "Submissions",
  },
  "submit.ppt": {
    emoji: "🎞️",
    title: "Presentation submitted",
    color: STYLE.gold,
    group: "Submissions",
  },
  "submit.reset": {
    emoji: "♻️",
    title: "Submission reset",
    color: STYLE.warn,
    group: "Submissions",
  },
  // teams
  "team.add": {
    emoji: "🧩",
    title: "Team registered",
    color: STYLE.color,
    group: "Teams",
  },
  "team.edit": {
    emoji: "🛠️",
    title: "Team edited",
    color: STYLE.warn,
    group: "Teams",
  },
  "team.remove": {
    emoji: "🗑️",
    title: "Team removed",
    color: STYLE.error,
    group: "Teams",
  },
  "team.import": {
    emoji: "📥",
    title: "Teams imported",
    color: STYLE.color,
    group: "Teams",
  },
  // bot / setup
  "setup.deploy": {
    emoji: "🚀",
    title: "Onyx deployed",
    color: STYLE.color,
    group: "Setup",
  },
  "setup.sync": {
    emoji: "🔄",
    title: "Onyx synced",
    color: STYLE.color,
    group: "Setup",
  },
  "setup.deadline": {
    emoji: "⏰",
    title: "Deadline changed",
    color: STYLE.warn,
    group: "Setup",
  },
  "setup.closed": {
    emoji: "🔒",
    title: "Submissions closed",
    color: STYLE.rose,
    group: "Setup",
  },
  error: {
    emoji: "🛑",
    title: "Onyx error",
    color: STYLE.error,
    group: "System",
  },
  // server structure
  "channel.create": {
    emoji: "➕",
    title: "Channel created",
    color: STYLE.ok,
    group: "Channels",
  },
  "channel.delete": {
    emoji: "➖",
    title: "Channel deleted",
    color: STYLE.error,
    group: "Channels",
  },
  "channel.update": {
    emoji: "🧱",
    title: "Channel updated",
    color: STYLE.warn,
    group: "Channels",
  },
  "role.create": {
    emoji: "🎨",
    title: "Role created",
    color: STYLE.ok,
    group: "Roles",
  },
  "role.delete": {
    emoji: "🗑️",
    title: "Role deleted",
    color: STYLE.error,
    group: "Roles",
  },
  "role.update": {
    emoji: "🎭",
    title: "Role updated",
    color: STYLE.warn,
    group: "Roles",
  },
  "server.update": {
    emoji: "🏠",
    title: "Server updated",
    color: STYLE.warn,
    group: "Server",
  },
  "invite.create": {
    emoji: "🔗",
    title: "Invite created",
    color: STYLE.blue,
    group: "Invites",
  },
  "invite.delete": {
    emoji: "✂️",
    title: "Invite deleted",
    color: STYLE.slate,
    group: "Invites",
  },
  // voice
  "voice.join": {
    emoji: "🔊",
    title: "Joined voice",
    color: STYLE.blue,
    group: "Voice",
  },
  "voice.leave": {
    emoji: "🔇",
    title: "Left voice",
    color: STYLE.slate,
    group: "Voice",
  },
  "voice.move": {
    emoji: "🔀",
    title: "Moved voice channel",
    color: STYLE.blue,
    group: "Voice",
  },
  // messages (optional)
  "message.delete": {
    emoji: "🧹",
    title: "Message deleted",
    color: STYLE.error,
    group: "Messages",
  },
  "message.edit": {
    emoji: "📝",
    title: "Message edited",
    color: STYLE.warn,
    group: "Messages",
  },
  "message.bulk": {
    emoji: "🧼",
    title: "Messages purged",
    color: STYLE.error,
    group: "Messages",
  },
};

// ---- which channel? (cached so noisy events don't hit the database every time) ----
const cache = new Map();
export const invalidateLogConfig = (guildId) => cache.delete(guildId);
const logChannelId = async (guildId) => {
  const hit = cache.get(guildId);
  if (hit && Date.now() - hit.at < 60_000) return hit.id;
  const query = GuildConfig.findOne({ guildId });
  const cfg = await (query?.select ? query.select("logChannelId") : query);
  const id = cfg?.logChannelId ?? null;
  cache.set(guildId, { id, at: Date.now() });
  return id;
};

// ---- build the card ----
export const buildLog = (
  kind,
  { user, summary, fields = [], note, id } = {},
) => {
  const k = KINDS[kind] ?? KINDS.error;
  const head = `### ${k.emoji} ${titleCase(k.title)}${summary ? `\n${summary}` : ""}`;
  const parts = [withThumb(head, avatarOf(user))];
  const body = kv(fields);
  if (body) parts.push(sep(false), text(body));
  if (note) parts.push(text(`>>> ${String(note).slice(0, 900)}`));
  const refId = id ?? user?.id ?? user?.user?.id;
  parts.push(
    text(
      `-# ${k.group}  ·  ${ts(new Date(), "f")}${refId ? `  ·  ID ${refId}` : ""}`,
    ),
  );
  return v2([container(parts, k.color)]);
};

// ---- send queue: 1 message per ~1.2s per server so bursts never hit Discord's rate limit ----
const queues = new Map();
const drain = async (guildId) => {
  const q = queues.get(guildId);
  if (!q || q.running) return;
  q.running = true;
  while (q.items.length) {
    const { guild, payload } = q.items.shift();
    try {
      const id = await logChannelId(guildId);
      if (id) {
        const ch = await guild.channels.fetch(id).catch(() => null);
        if (ch) await ch.send(payload);
      }
    } catch (e) {
      warn(`Log send failed in ${guildId}: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, q.delay));
  }
  q.running = false;
};

/** Fire-and-forget: log an event. Never throws. */
export const logEvent = (guild, kind, data = {}) => {
  try {
    if (!guild?.id) return;
    const q = queues.get(guild.id) ?? {
      items: [],
      running: false,
      delay: 1200,
    };
    queues.set(guild.id, q);
    if (q.items.length > 300) q.items.shift(); // never grow without bound
    q.items.push({ guild, payload: buildLog(kind, data) });
    drain(guild.id);
  } catch (e) {
    warn(`logEvent failed: ${e.message}`);
  }
};

export const setLogDelay = (ms) => {
  for (const q of queues.values()) q.delay = ms;
};
export const _queues = queues;
