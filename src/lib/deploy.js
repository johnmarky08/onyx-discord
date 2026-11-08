// Applies a saved GuildConfig to the server: permissions, public panels, and every team's space.
import { PermissionFlagsBits as P } from "discord.js";
import { GuildConfig, Team } from "../models/index.js";
import { ensureTeamResources } from "./teams.js";
import {
  publishPanel,
  submissionPanel,
  submissionStats,
  welcomePanel,
} from "./panels.js";
import { missingBotPerms } from "./perms.js";
import { error } from "./logger.js";
import { muteMany } from "./quiet.js";
import { refreshBoard } from "./board.js";

const fetchChannel = (guild, id) => guild.channels.fetch(id).catch(() => null);

/** Validate the wizard choices. Returns an array of human-readable problems (empty = good). */
export const validateConfig = async (guild, cfg) => {
  const problems = [];
  await guild.members.fetchMe().catch(() => null);
  const missing = missingBotPerms(guild);
  if (missing.length)
    problems.push(
      `I'm missing permissions: **${missing.join(", ")}**. Give my role these (or Administrator).`,
    );

  const [participant, facilitator] = await Promise.all([
    guild.roles.fetch(cfg.participantRoleId).catch(() => null),
    guild.roles.fetch(cfg.facilitatorRoleId).catch(() => null),
  ]);
  const botTop = guild.members.me?.roles?.highest;

  for (const [label, role] of [
    ["Participant role", participant],
    ["Facilitator role", facilitator],
  ]) {
    if (!role) problems.push(`${label} no longer exists.`);
    else if (role.id === guild.id)
      problems.push(`${label} can't be @everyone.`);
    else if (role.managed)
      problems.push(
        `${label} (${role.name}) is managed by an integration — pick a normal role.`,
      );
    else if (
      botTop &&
      role.position >= botTop.position &&
      !guild.members.me.permissions.has(P.Administrator)
    )
      problems.push(
        `${label} **${role.name}** is above my highest role. Drag my role above it in Server Settings → Roles.`,
      );
  }
  if (participant && facilitator && participant.id === facilitator.id)
    problems.push("The participant and facilitator roles must be different.");
  if (cfg.welcomeChannelId === cfg.submissionChannelId)
    problems.push("Welcome and submission must be two different channels.");
  if (
    [cfg.welcomeChannelId, cfg.submissionChannelId].includes(cfg.boardChannelId)
  )
    problems.push(
      "The submissions board channel must be separate from the welcome and submission channels (it is facilitators-only).",
    );

  const me = guild.members.me;
  for (const [label, id] of [
    ["Welcome channel", cfg.welcomeChannelId],
    ["Submission channel", cfg.submissionChannelId],
    ["Log channel", cfg.logChannelId],
    ["Submissions board channel", cfg.boardChannelId],
  ]) {
    if (!id) continue;
    const ch = await fetchChannel(guild, id);
    if (!ch) problems.push(`${label} no longer exists.`);
    else if (me && !ch.permissionsFor(me)?.has([P.ViewChannel, P.SendMessages]))
      problems.push(`I can't view/send in ${label.toLowerCase()} <#${id}>.`);
  }
  return problems;
};

/** Run the full deployment. Returns { lines: string[], warnings: string[] }. */
export const deployGuild = async (
  guild,
  config,
  { createTeamSpaces = true } = {},
) => {
  const lines = [];
  const warnings = [];
  const step = async (label, fn) => {
    try {
      const out = await fn();
      lines.push(`✅ ${label}${out ? ` — ${out}` : ""}`);
    } catch (e) {
      error(`Deploy step failed (${label}): ${e.message}`, e);
      warnings.push(`❌ ${label}: ${e.message}`);
    }
  };

  const everyone = guild.roles.everyone;
  muteMany([
    guild.id,
    config.participantRoleId,
    config.facilitatorRoleId,
    config.welcomeChannelId,
    config.submissionChannelId,
    config.boardChannelId,
    config.logChannelId,
  ]);
  const me = await guild.members.fetchMe().catch(() => guild.members.me);
  const participantRole = await guild.roles
    .fetch(config.participantRoleId)
    .catch(() => null);
  const facilitatorRole = await guild.roles
    .fetch(config.facilitatorRoleId)
    .catch(() => null);
  if (!participantRole || !facilitatorRole) {
    return {
      lines,
      warnings: [
        "❌ The participant or facilitator role no longer exists. Run `/onyx setup` again.",
      ],
    };
  }

  if (config.lockServer) {
    await step("Locked the server until verification", async () => {
      await everyone.setPermissions(
        everyone.permissions.remove(P.ViewChannel),
        "Onyx: lock until verified",
      );
      await participantRole.setPermissions(
        participantRole.permissions.add(P.ViewChannel),
        "Onyx: verified participants can see the server",
      );
      await facilitatorRole.setPermissions(
        facilitatorRole.permissions.add(P.ViewChannel),
        "Onyx: facilitators can see the server",
      );
      return "@everyone can only see the welcome channel";
    });
  }

  // Welcome channel: visible to everybody, read-only.
  await step("Welcome channel permissions", async () => {
    const ch = await guild.channels.fetch(config.welcomeChannelId);
    await ch.permissionOverwrites.edit(everyone, {
      ViewChannel: true,
      ReadMessageHistory: true,
      SendMessages: false,
      SendMessagesInThreads: false,
      CreatePublicThreads: false,
      CreatePrivateThreads: false,
      AddReactions: false,
    });
    await ch.permissionOverwrites.edit(facilitatorRole, {
      ViewChannel: true,
      SendMessages: true,
    });
    await ch.permissionOverwrites.edit(me, {
      ViewChannel: true,
      SendMessages: true,
      EmbedLinks: true,
    });
  });

  // Submission channel: participants read, only the bot posts.
  await step("Submission channel permissions", async () => {
    const ch = await guild.channels.fetch(config.submissionChannelId);
    await ch.permissionOverwrites.edit(everyone, {
      SendMessages: false,
      SendMessagesInThreads: false,
      CreatePublicThreads: false,
      CreatePrivateThreads: false,
      AddReactions: false,
    });
    await ch.permissionOverwrites.edit(participantRole, {
      ViewChannel: true,
      ReadMessageHistory: true,
    });
    await ch.permissionOverwrites.edit(facilitatorRole, {
      ViewChannel: true,
      SendMessages: true,
    });
    await ch.permissionOverwrites.edit(me, {
      ViewChannel: true,
      SendMessages: true,
      EmbedLinks: true,
    });
  });

  // Facilitators-only channels: the submissions board and (if set) the server log.
  for (const [label, id] of [
    ["Submissions board", config.boardChannelId],
    ["Server log", config.logChannelId],
  ]) {
    if (!id) continue;
    await step(`${label} channel is facilitators-only`, async () => {
      const ch = await guild.channels.fetch(id);
      await ch.permissionOverwrites.edit(everyone, { ViewChannel: false });
      await ch.permissionOverwrites.edit(participantRole, {
        ViewChannel: false,
      });
      await ch.permissionOverwrites.edit(facilitatorRole, {
        ViewChannel: true,
        ReadMessageHistory: true,
        SendMessages: false,
      });
      await ch.permissionOverwrites.edit(me, {
        ViewChannel: true,
        SendMessages: true,
        EmbedLinks: true,
        AttachFiles: true,
      });
      return `<#${ch.id}>`;
    });
  }

  await step("Welcome panel posted", async () => {
    const id = await publishPanel(
      guild,
      config.welcomeChannelId,
      config.welcomeMessageId,
      welcomePanel(),
      config.welcomeChannelId,
    );
    config.welcomeMessageId = id;
    return `<#${config.welcomeChannelId}>`;
  });

  await step("Submission panel posted", async () => {
    const stats = await submissionStats(guild.id);
    const id = await publishPanel(
      guild,
      config.submissionChannelId,
      config.submissionMessageId,
      submissionPanel(config, stats),
      config.submissionChannelId,
    );
    config.submissionMessageId = id;
    return `<#${config.submissionChannelId}>`;
  });

  await config.save();

  if (createTeamSpaces) {
    const teams = await Team.find({ guildId: guild.id }).sort({ createdAt: 1 });
    if (teams.length === 0) {
      lines.push(
        "ℹ️ No teams registered yet — add them with `/team add` or `/team import`.",
      );
    } else {
      let ok = 0;
      for (const team of teams) {
        try {
          await ensureTeamResources(guild, team, config);
          ok += 1;
        } catch (e) {
          error(`Team space failed for ${team.name}: ${e.message}`, e);
          warnings.push(`❌ Team **${team.name}**: ${e.message}`);
        }
      }
      lines.push(`✅ Team spaces ready — ${ok}/${teams.length}`);
    }
  }

  if (config.boardChannelId) {
    await step("Submissions board built", async () => {
      const { cards, error: err } = await refreshBoard(guild);
      if (err) throw new Error(err);
      return `${cards} team card(s) in <#${config.boardChannelId}>`;
    });
  }

  return { lines, warnings };
};

export const getConfig = (guildId) => GuildConfig.findOne({ guildId });
