import { PermissionFlagsBits as P, SlashCommandBuilder } from "discord.js";
import { EVENT } from "../config/event.js";
import { GuildConfig, Submission, Team } from "../models/index.js";
import { deployGuild, validateConfig } from "../lib/deploy.js";
import { missingBotPerms } from "../lib/perms.js";
import { refreshSubmissionPanel } from "../lib/panels.js";
import {
  bar,
  bigSep,
  container,
  footer,
  heading,
  kv,
  publicNotice,
  respond,
  sep,
  text,
  ts,
  v2,
} from "../lib/ui.js";
import { logEvent } from "../lib/logs.js";
import { refreshBoard } from "../lib/board.js";
import { startSetup } from "../interactions/setup.js";
import { requireStaff } from "./_shared.js";

export const data = new SlashCommandBuilder()
  .setName("onyx")
  .setDescription("Onyx hackathon bot controls")
  .setDMPermission(false)
  .addSubcommand((s) =>
    s
      .setName("setup")
      .setDescription(
        "Interactive setup: pick roles & channels and deploy everything",
      ),
  )
  .addSubcommand((s) =>
    s
      .setName("status")
      .setDescription("Show the current configuration and health checks"),
  )
  .addSubcommand((s) =>
    s
      .setName("sync")
      .setDescription(
        "Re-apply permissions, refresh panels and repair any missing team spaces",
      ),
  )
  .addSubcommand((s) =>
    s
      .setName("deadline")
      .setDescription("Change the submission deadline")
      .addStringOption((o) =>
        o
          .setName("when")
          .setDescription(
            "Philippine time, format YYYY-MM-DD HH:mm (e.g. 2026-11-12 12:00)",
          )
          .setRequired(true),
      ),
  );

export const execute = async (interaction) => {
  const sub = interaction.options.getSubcommand();
  if (sub === "setup") return startSetup(interaction);

  const config = await requireStaff(interaction);
  if (!config) return;

  if (sub === "status") return status(interaction, config);
  if (sub === "sync") return sync(interaction, config);
  if (sub === "deadline") return deadline(interaction, config);
};

const sync = async (interaction, config) => {
  if (!config.isComplete())
    return interaction.reply(
      publicNotice("error", "Not set up yet", "Run `/onyx setup` first."),
    );
  await interaction.deferReply();
  const problems = await validateConfig(interaction.guild, config);
  if (problems.length)
    return respond(
      interaction,
      publicNotice(
        "error",
        "Can't sync yet",
        problems.map((p) => `- ${p}`).join("\n"),
      ),
    );
  const { lines, warnings } = await deployGuild(interaction.guild, config);
  logEvent(interaction.guild, "setup.sync", {
    user: interaction.member,
    summary: `by <@${interaction.user.id}>`,
    note: [...lines, ...warnings].join("\n").slice(0, 700),
  });
  return respond(
    interaction,
    v2(
      [
        container(
          [
            text("-# 🔄  SYNC\n# Everything is up to date"),
            sep(),
            text([...lines, ...warnings].join("\n").slice(0, 3000)),
            footer(),
          ],
          warnings.length ? 0xfbbf24 : 0x4ade80,
        ),
      ],
      { ephemeral: false },
    ),
  );
};

const deadline = async (interaction, config) => {
  if (!config.isComplete())
    return interaction.reply(
      publicNotice("error", "Not set up yet", "Run `/onyx setup` first."),
    );
  const raw = interaction.options.getString("when").trim();
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})$/);
  const date = m
    ? new Date(`${m[1]}T${m[2].padStart(2, "0")}:${m[3]}:00+08:00`)
    : null;
  if (!date || Number.isNaN(date.getTime())) {
    return interaction.reply(
      publicNotice(
        "error",
        "I couldn't read that date",
        "Use `YYYY-MM-DD HH:mm` in Philippine time, e.g. `2026-11-12 12:00`.",
      ),
    );
  }
  await interaction.deferReply();
  config.deadline = date;
  config.panelClosed = date.getTime() <= Date.now();
  await config.save();
  await refreshSubmissionPanel(interaction.client, interaction.guildId, {
    immediate: true,
  });
  await refreshBoard(interaction.guild);
  logEvent(interaction.guild, "setup.deadline", {
    user: interaction.member,
    summary: `by <@${interaction.user.id}>`,
    fields: [["New deadline", `${ts(date)} (${ts(date, "R")})`]],
  });
  return respond(
    interaction,
    notice(
      "ok",
      "Deadline updated",
      `Submissions ${date.getTime() <= Date.now() ? "are now closed" : `close ${ts(date)} (${ts(date, "R")})`}.`,
    ),
  );
};

const status = async (interaction, config) => {
  await interaction.deferReply();
  const { guild } = interaction;
  const [teams, repos, ppts] = await Promise.all([
    Team.find({ guildId: guild.id }).select(
      "members roster roleId categoryId textChannelId voiceChannelId",
    ),
    Submission.countDocuments({ guildId: guild.id, type: "repository" }),
    Submission.countDocuments({ guildId: guild.id, type: "presentation" }),
  ]);
  const participants = teams.reduce((n, t) => n + t.members.length, 0);
  const rosterTotal = teams.reduce((n, t) => n + (t.roster?.length ?? 0), 0);
  const noSpace = teams.filter(
    (t) => !(t.roleId && t.categoryId && t.textChannelId && t.voiceChannelId),
  ).length;
  const missing = missingBotPerms(guild);

  const mention = (kind, id) =>
    id ? (kind === "role" ? `<@&${id}>` : `<#${id}>`) : "*not set*";
  const closed = new Date(config.deadline).getTime() <= Date.now();
  const config_ = kv([
    ["Participant role", mention("role", config.participantRoleId), "🎟️"],
    ["Facilitator role", mention("role", config.facilitatorRoleId), "🛡️"],
    ["Welcome", mention("ch", config.welcomeChannelId), "👋"],
    ["Submissions", mention("ch", config.submissionChannelId), "📦"],
    ["Submissions board", mention("ch", config.boardChannelId), "📬"],
    ["Server log", mention("ch", config.logChannelId), "🧾"],
    ["Lock until verified", config.lockServer ? "ON" : "OFF", "🔒"],
    [
      "Deadline",
      `${ts(config.deadline)} (${ts(config.deadline, "R")})${closed ? " — closed" : ""}`,
      "⏰",
    ],
  ]);
  const stats = kv([
    [
      "Teams",
      `${teams.length}${noSpace ? `  ⚠️ ${noSpace} without a full space → \`/onyx sync\`` : ""}`,
      "🧩",
    ],
    [
      "Verified",
      `${bar(participants, rosterTotal)}  **${participants}/${rosterTotal}**`,
      "✅",
    ],
    [
      "Repositories",
      `${bar(repos, teams.length)}  **${repos}/${teams.length}**`,
      "🗂️",
    ],
    [
      "Presentations",
      `${bar(ppts, teams.length)}  **${ppts}/${teams.length}**`,
      "🎞️",
    ],
  ]);
  const health = [
    config.isComplete()
      ? "✅ Setup complete"
      : "⚠️ Setup incomplete — run `/onyx setup`",
    missing.length
      ? `⚠️ Missing bot permissions: ${missing.join(", ")}`
      : "✅ Bot permissions OK",
    config.logChannelId
      ? "✅ Server log active"
      : "ℹ️ No log channel set — events aren't being logged",
  ].join("\n");
  return respond(
    interaction,
    v2(
      [
        container([
          text(`-# 🪨  ONYX\n# Status\n${EVENT.name}`),
          bigSep(),
          heading("⚙️", "Configuration"),
          text(config_),
          bigSep(),
          heading("📊", "Progress"),
          text(stats),
          bigSep(),
          heading("🩺", "Health"),
          text(health),
          footer(),
        ]),
      ],
      { ephemeral: false },
    ),
  );
};
