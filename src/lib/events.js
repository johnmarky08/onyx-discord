// Listens to Discord events and turns them into log cards (see logs.js).
import { ChannelType } from "discord.js";
import { Team } from "../models/index.js";
import { logEvent } from "./logs.js";
import { isMuted, memberKey } from "./quiet.js";
import { ts } from "./ui.js";
import { error } from "./logger.js";

const safe =
  (fn) =>
  async (...args) => {
    try {
      await fn(...args);
    } catch (e) {
      error(`Event log handler failed: ${e.message}`);
    }
  };

const roleNames = (member) =>
  [...(member.roles?.cache?.values?.() ?? [])]
    .filter((r) => r.id !== member.guild.id)
    .sort((a, b) => b.position - a.position)
    .map((r) => `<@&${r.id}>`)
    .join(" ") || "*none*";

const channelKind = (ch) =>
  ({
    [ChannelType.GuildText]: "Text",
    [ChannelType.GuildVoice]: "Voice",
    [ChannelType.GuildCategory]: "Category",
    [ChannelType.GuildAnnouncement]: "Announcement",
    [ChannelType.GuildForum]: "Forum",
    [ChannelType.GuildStageVoice]: "Stage",
  })[ch.type] ?? "Channel";
const mentionCh = (ch) =>
  ch.type === ChannelType.GuildCategory ? `**${ch.name}**` : `<#${ch.id}>`;

const overwriteSig = (ch) =>
  new Map(
    [...(ch.permissionOverwrites?.cache?.values?.() ?? [])].map((o) => [
      o.id,
      `${o.allow.bitfield}:${o.deny.bitfield}`,
    ]),
  );

export const registerEventLogs = (client, { messageLogs = false } = {}) => {
  // ---------- members ----------
  client.on(
    "guildMemberAdd",
    safe(async (m) => {
      if (m.user.bot) return;
      logEvent(m.guild, "member.join", {
        user: m,
        summary: `${m} · **${m.user.username}**`,
        fields: [
          ["Account created", ts(m.user.createdAt, "R")],
          ["Member count", `#${m.guild.memberCount}`],
          ["Status", "⏳ Waiting to verify"],
        ],
      });
    }),
  );

  client.on(
    "guildMemberRemove",
    safe(async (m) => {
      const team = await Team.findOne({
        guildId: m.guild.id,
        "members.userId": m.id,
      });
      logEvent(m.guild, "member.leave", {
        user: m,
        summary: `<@${m.id}> · **${m.user?.username ?? m.id}**`,
        fields: [
          ["Team", team ? `**${team.name}**` : "—"],
          ["Roles", m.roles ? roleNames(m) : "—"],
          ["Joined", m.joinedAt ? ts(m.joinedAt, "R") : "—"],
        ],
      });
    }),
  );

  client.on(
    "guildMemberUpdate",
    safe(async (oldM, newM) => {
      if (
        newM.user.bot ||
        oldM.partial ||
        isMuted(memberKey(newM.guild.id, newM.id))
      )
        return;
      if (oldM.nickname !== newM.nickname) {
        logEvent(newM.guild, "member.nick", {
          user: newM,
          summary: `<@${newM.id}>`,
          fields: [
            ["Before", oldM.nickname ? `\`${oldM.nickname}\`` : "*none*"],
            ["After", newM.nickname ? `\`${newM.nickname}\`` : "*none*"],
          ],
        });
      }
      const before = new Set(oldM.roles.cache.keys());
      const after = new Set(newM.roles.cache.keys());
      const added = [...after].filter((r) => !before.has(r));
      const removed = [...before].filter((r) => !after.has(r));
      if (added.length || removed.length) {
        logEvent(newM.guild, "member.roles", {
          user: newM,
          summary: `<@${newM.id}>`,
          fields: [
            ["Added", added.map((r) => `<@&${r}>`).join(" ")],
            ["Removed", removed.map((r) => `<@&${r}>`).join(" ")],
          ],
        });
      }
      if (
        (oldM.communicationDisabledUntilTimestamp ?? 0) !==
        (newM.communicationDisabledUntilTimestamp ?? 0)
      ) {
        const until = newM.communicationDisabledUntilTimestamp;
        logEvent(newM.guild, "member.timeout", {
          user: newM,
          summary: `<@${newM.id}>`,
          fields: [
            [
              "Status",
              until && until > Date.now()
                ? `Timed out until ${ts(until, "f")}`
                : "Timeout removed",
            ],
          ],
        });
      }
    }),
  );

  client.on(
    "guildBanAdd",
    safe(async (ban) => {
      logEvent(ban.guild, "member.ban", {
        user: ban.user,
        summary: `<@${ban.user.id}> · **${ban.user.username}**`,
        fields: [["Reason", ban.reason ?? "No reason given"]],
      });
    }),
  );
  client.on(
    "guildBanRemove",
    safe(async (ban) => {
      logEvent(ban.guild, "member.unban", {
        user: ban.user,
        summary: `<@${ban.user.id}> · **${ban.user.username}**`,
      });
    }),
  );

  // ---------- channels ----------
  client.on(
    "channelCreate",
    safe(async (ch) => {
      if (!ch.guild || isMuted(ch.id)) return;
      logEvent(ch.guild, "channel.create", {
        id: ch.id,
        summary: mentionCh(ch),
        fields: [
          ["Type", channelKind(ch)],
          ["Category", ch.parent ? `**${ch.parent.name}**` : "—"],
        ],
      });
    }),
  );
  client.on(
    "channelDelete",
    safe(async (ch) => {
      if (!ch.guild || isMuted(ch.id)) return;
      logEvent(ch.guild, "channel.delete", {
        id: ch.id,
        summary: `**${ch.name}**`,
        fields: [
          ["Type", channelKind(ch)],
          ["Category", ch.parent ? `**${ch.parent.name}**` : "—"],
        ],
      });
    }),
  );
  client.on(
    "channelUpdate",
    safe(async (a, b) => {
      if (!b.guild || isMuted(b.id)) return;
      const fields = [];
      if (a.name !== b.name)
        fields.push(["Name", `\`${a.name}\` → \`${b.name}\``]);
      if (a.parentId !== b.parentId)
        fields.push([
          "Category",
          `${a.parent?.name ?? "none"} → ${b.parent?.name ?? "none"}`,
        ]);
      if (a.topic !== b.topic)
        fields.push([
          "Topic",
          `${a.topic || "*none*"} → ${b.topic || "*none*"}`,
        ]);
      const sa = overwriteSig(a);
      const sb = overwriteSig(b);
      const changed = [...new Set([...sa.keys(), ...sb.keys()])].filter(
        (id) => sa.get(id) !== sb.get(id),
      );
      if (changed.length) {
        fields.push([
          "Permissions",
          changed
            .slice(0, 6)
            .map((id) =>
              b.guild.roles.cache.has(id) ? `<@&${id}>` : `<@${id}>`,
            )
            .join(" ") + (changed.length > 6 ? ` +${changed.length - 6}` : ""),
        ]);
      }
      if (fields.length)
        logEvent(b.guild, "channel.update", {
          id: b.id,
          summary: mentionCh(b),
          fields,
        });
    }),
  );

  // ---------- roles ----------
  client.on(
    "roleCreate",
    safe(async (r) => {
      if (isMuted(r.id)) return;
      logEvent(r.guild, "role.create", { id: r.id, summary: `<@&${r.id}>` });
    }),
  );
  client.on(
    "roleDelete",
    safe(async (r) => {
      if (isMuted(r.id)) return;
      logEvent(r.guild, "role.delete", { id: r.id, summary: `**${r.name}**` });
    }),
  );
  client.on(
    "roleUpdate",
    safe(async (a, b) => {
      if (isMuted(b.id)) return;
      const fields = [];
      if (a.name !== b.name)
        fields.push(["Name", `\`${a.name}\` → \`${b.name}\``]);
      if (a.color !== b.color)
        fields.push([
          "Colour",
          `#${a.color.toString(16).padStart(6, "0")} → #${b.color.toString(16).padStart(6, "0")}`,
        ]);
      if (a.permissions.bitfield !== b.permissions.bitfield) {
        const added = a.permissions.missing(b.permissions);
        const removed = b.permissions.missing(a.permissions);
        if (added.length)
          fields.push([
            "Permissions added",
            added.map((p) => p.replace(/([a-z])([A-Z])/g, "$1 $2")).join(", "),
          ]);
        if (removed.length)
          fields.push([
            "Permissions removed",
            removed
              .map((p) => p.replace(/([a-z])([A-Z])/g, "$1 $2"))
              .join(", "),
          ]);
      }
      if (fields.length)
        logEvent(b.guild, "role.update", {
          id: b.id,
          summary: `<@&${b.id}>`,
          fields,
        });
    }),
  );

  // ---------- server / invites ----------
  client.on(
    "guildUpdate",
    safe(async (a, b) => {
      const fields = [];
      if (a.name !== b.name)
        fields.push(["Name", `\`${a.name}\` → \`${b.name}\``]);
      if (a.icon !== b.icon) fields.push(["Icon", "changed"]);
      if (a.description !== b.description)
        fields.push([
          "Description",
          `${a.description ?? "*none*"} → ${b.description ?? "*none*"}`,
        ]);
      if (a.ownerId !== b.ownerId)
        fields.push(["Owner", `<@${a.ownerId}> → <@${b.ownerId}>`]);
      if (fields.length)
        logEvent(b, "server.update", {
          id: b.id,
          summary: `**${b.name}**`,
          fields,
        });
    }),
  );
  client.on(
    "inviteCreate",
    safe(async (i) => {
      if (!i.guild) return;
      logEvent(i.guild, "invite.create", {
        user: i.inviter,
        id: i.code,
        summary: `\`${i.code}\``,
        fields: [
          ["By", i.inviter ? `<@${i.inviter.id}>` : "—"],
          ["Channel", i.channel ? `<#${i.channel.id}>` : "—"],
          ["Max uses", i.maxUses || "∞"],
          ["Expires", i.expiresAt ? ts(i.expiresAt, "R") : "never"],
        ],
      });
    }),
  );
  client.on(
    "inviteDelete",
    safe(async (i) => {
      if (!i.guild) return;
      logEvent(i.guild, "invite.delete", {
        id: i.code,
        summary: `\`${i.code}\``,
        fields: [["Channel", i.channel ? `<#${i.channel.id}>` : "—"]],
      });
    }),
  );

  // ---------- voice ----------
  client.on(
    "voiceStateUpdate",
    safe(async (a, b) => {
      const member = b.member ?? a.member;
      if (!member || member.user.bot || a.channelId === b.channelId) return;
      const kind = !a.channelId
        ? "voice.join"
        : !b.channelId
          ? "voice.leave"
          : "voice.move";
      const fields =
        kind === "voice.move"
          ? [
              ["From", `<#${a.channelId}>`],
              ["To", `<#${b.channelId}>`],
            ]
          : [["Channel", `<#${b.channelId ?? a.channelId}>`]];
      logEvent(member.guild, kind, {
        user: member,
        summary: `<@${member.id}>`,
        fields,
      });
    }),
  );

  // ---------- messages (opt-in: needs the Message Content intent) ----------
  if (messageLogs) {
    client.on(
      "messageDelete",
      safe(async (m) => {
        if (!m.guild || m.author?.bot) return;
        logEvent(m.guild, "message.delete", {
          user: m.author,
          summary: `${m.author ? `<@${m.author.id}>` : "Unknown author"} in <#${m.channelId}>`,
          fields: [
            [
              "Attachments",
              m.attachments?.size ? String(m.attachments.size) : "",
            ],
          ],
          note: m.content || "*content not cached*",
        });
      }),
    );
    client.on(
      "messageUpdate",
      safe(async (a, b) => {
        if (!b.guild || b.author?.bot || a.content === b.content || !a.content)
          return;
        logEvent(b.guild, "message.edit", {
          user: b.author,
          summary: `<@${b.author.id}> in <#${b.channelId}> · [jump](${b.url})`,
          fields: [
            ["Before", a.content.slice(0, 400)],
            ["After", b.content.slice(0, 400)],
          ],
        });
      }),
    );
    client.on(
      "messageDeleteBulk",
      safe(async (msgs, channel) => {
        logEvent(channel.guild, "message.bulk", {
          id: channel.id,
          summary: `**${msgs.size}** messages in <#${channel.id}>`,
        });
      }),
    );
  }
};
