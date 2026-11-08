// Everything that creates / repairs / removes the Discord side of a team.
import { ChannelType } from "discord.js";
import { STYLE } from "../config/style.js";
import { Team } from "../models/index.js";
import { withLock } from "./guards.js";
import { teamOverwrites } from "./perms.js";
import { log, warn } from "./logger.js";
import { mute, muteMany } from "./quiet.js";

const fetchRole = (guild, id) =>
  id ? guild.roles.fetch(id).catch(() => null) : null;
const fetchChannel = (guild, id) =>
  id ? guild.channels.fetch(id).catch(() => null) : null;

/**
 * Make sure the team has: a role, a private category, one text channel and one voice channel.
 * Safe to call repeatedly (used for /team add, /team import, /onyx sync and setup).
 * Returns { team, created: string[], repaired: string[] }.
 */
export const ensureTeamResources = (guild, teamDoc, config) =>
  withLock(`team:${teamDoc._id}`, async () => {
    const team = await Team.findById(teamDoc._id);
    if (!team) throw new Error("Team no longer exists");
    const created = [];
    const repaired = [];
    const reason = `Onyx: team ${team.name}`;
    muteMany([
      team.roleId,
      team.categoryId,
      team.textChannelId,
      team.voiceChannelId,
    ]);

    // --- role ---
    let role = await fetchRole(guild, team.roleId);
    if (!role) {
      const index = await Team.countDocuments({
        guildId: guild.id,
        createdAt: { $lt: team.createdAt },
      });
      role = await guild.roles.create({
        name: team.name.slice(0, 100),
        color: STYLE.roleColors[index % STYLE.roleColors.length],
        mentionable: false,
        hoist: false,
        permissions: [],
        reason,
      });
      team.roleId = role.id;
      mute(role.id);
      created.push("role");
    } else if (role.name !== team.name.slice(0, 100)) {
      await role.setName(team.name.slice(0, 100), reason).catch(() => null);
    }

    const mk = (kind) =>
      teamOverwrites({
        guild,
        teamRoleId: role.id,
        facilitatorRoleId: config.facilitatorRoleId,
        kind,
      });

    // --- category ---
    const catName = STYLE.category(team.name);
    let category = await fetchChannel(guild, team.categoryId);
    if (!category || category.type !== ChannelType.GuildCategory) {
      category = await guild.channels.create({
        name: catName,
        type: ChannelType.GuildCategory,
        permissionOverwrites: mk("category"),
        reason,
      });
      team.categoryId = category.id;
      mute(category.id);
      created.push("category");
    } else {
      await category
        .edit({ name: catName, permissionOverwrites: mk("category"), reason })
        .catch(() => null);
      repaired.push("category");
    }

    // --- text channel ---
    let text = await fetchChannel(guild, team.textChannelId);
    if (!text || text.type !== ChannelType.GuildText) {
      text = await guild.channels.create({
        name: STYLE.textChannel,
        type: ChannelType.GuildText,
        parent: category.id,
        topic: `Private team chat for ${team.name}. Only your team and the facilitators can see this.`,
        permissionOverwrites: mk("text"),
        reason,
      });
      team.textChannelId = text.id;
      mute(text.id);
      created.push("text channel");
    } else {
      await text
        .edit({ parent: category.id, permissionOverwrites: mk("text"), reason })
        .catch(() => null);
      repaired.push("text channel");
    }

    // --- voice channel ---
    let voice = await fetchChannel(guild, team.voiceChannelId);
    if (!voice || voice.type !== ChannelType.GuildVoice) {
      voice = await guild.channels.create({
        name: STYLE.voiceChannel,
        type: ChannelType.GuildVoice,
        parent: category.id,
        permissionOverwrites: mk("voice"),
        reason,
      });
      team.voiceChannelId = voice.id;
      mute(voice.id);
      created.push("voice channel");
    } else {
      await voice
        .edit({
          parent: category.id,
          permissionOverwrites: mk("voice"),
          reason,
        })
        .catch(() => null);
      repaired.push("voice channel");
    }

    await team.save();
    log(
      `Team "${team.name}" ready (${created.length ? "created: " + created.join(", ") : "verified"})`,
    );
    return { team, created, repaired };
  });

/** Delete a team's role + channels (database record is removed by the caller). */
export const deleteTeamResources = async (guild, team) => {
  const reason = `Onyx: team ${team.name} removed`;
  muteMany([
    team.roleId,
    team.categoryId,
    team.textChannelId,
    team.voiceChannelId,
  ]);
  const results = [];
  for (const id of [team.textChannelId, team.voiceChannelId, team.categoryId]) {
    const ch = await fetchChannel(guild, id);
    if (ch)
      await ch
        .delete(reason)
        .catch((e) => results.push(`channel ${id}: ${e.message}`));
  }
  const role = await fetchRole(guild, team.roleId);
  if (role)
    await role
      .delete(reason)
      .catch((e) => results.push(`role ${team.roleId}: ${e.message}`));
  if (results.length)
    warn(`Partial team cleanup for ${team.name}: ${results.join("; ")}`);
  return results;
};
