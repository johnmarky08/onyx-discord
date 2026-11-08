import {
  AttachmentBuilder,
  ComponentType as C,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import { EVENT, trackLabel } from "../config/event.js";
import { Submission, Team } from "../models/index.js";
import { logEvent } from "../lib/logs.js";
import { refreshBoard } from "../lib/board.js";
import { refreshSubmissionPanel } from "../lib/panels.js";
import {
  bar,
  bigSep,
  container,
  footer,
  notice,
  respond,
  sep,
  text,
  ts,
  v2,
} from "../lib/ui.js";
import { findTeamByName, requireStaff, teamAutocomplete } from "./_shared.js";

export const data = new SlashCommandBuilder()
  .setName("submissions")
  .setDescription("Review and manage final submissions (facilitators)")
  .setDMPermission(false)
  .addSubcommand((s) =>
    s.setName("list").setDescription("Show who has and hasn't submitted"),
  )
  .addSubcommand((s) =>
    s
      .setName("export")
      .setDescription("Download every submission as a CSV file"),
  )
  .addSubcommand((s) =>
    s
      .setName("reset")
      .setDescription(
        "Delete a team's submission so they can submit again (fixing an error)",
      )
      .addStringOption((o) =>
        o
          .setName("team")
          .setDescription("Team")
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addStringOption((o) =>
        o
          .setName("type")
          .setDescription("Which submission to reset")
          .setRequired(true)
          .addChoices(
            { name: "Repository", value: "repository" },
            { name: "Presentation", value: "presentation" },
          ),
      ),
  );

export const autocomplete = teamAutocomplete;

export const execute = async (interaction) => {
  const config = await requireStaff(interaction);
  if (!config) return;
  const sub = interaction.options.getSubcommand();
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (sub === "list") return list(interaction, config);
  if (sub === "export") return exportCsv(interaction);
  if (sub === "reset") return reset(interaction, config);
};

const load = async (guildId) => {
  const [teams, subs] = await Promise.all([
    Team.find({ guildId }).sort({ name: 1 }),
    Submission.find({ guildId }),
  ]);
  const by = (team, type) =>
    subs.find((s) => String(s.teamId) === String(team._id) && s.type === type);
  return { teams, by };
};

const list = async (interaction, config) => {
  const { teams, by } = await load(interaction.guildId);
  if (!teams.length)
    return respond(
      interaction,
      notice("info", "No teams yet", "Nothing to show."),
    );
  const done = teams.filter(
    (t) => by(t, "repository") && by(t, "presentation"),
  ).length;
  const lines = [];
  let used = 0;
  for (const t of teams) {
    const r = by(t, "repository");
    const p = by(t, "presentation");
    const line = `${r && p ? "🟢" : r || p ? "🟡" : "⚪"} **${t.name}**\u2002🗂️${r ? "✅" : "▫️"}\u2002🎞️${p ? "✅" : "▫️"}`;
    if (used + line.length > 3000) {
      lines.push(
        `…and ${teams.length - lines.length} more — use \`/submissions export\`.`,
      );
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  const repos = teams.filter((t) => by(t, "repository")).length;
  const ppts = teams.filter((t) => by(t, "presentation")).length;
  return respond(
    interaction,
    v2(
      [
        container([
          text(
            `-# 📦  SUBMISSIONS\n# ${done}/${teams.length} teams complete\n${bar(done, teams.length)}`,
          ),
          text(
            `🗂️ Repositories **${repos}/${teams.length}**\u2002·\u2002🎞️ Presentations **${ppts}/${teams.length}**`,
          ),
          sep(),
          text(lines.join("\n")),
          sep(),
          text(
            `⏰ Deadline ${ts(config.deadline)} (${ts(config.deadline, "R")})`,
          ),
          footer(),
        ]),
      ],
      { ephemeral: true },
    ),
  );
};

const csvCell = (v) => {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@]/.test(s)) s = `'${s}`; // neutralise spreadsheet formula injection
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const exportCsv = async (interaction) => {
  const { teams, by } = await load(interaction.guildId);
  const header = [
    "Team",
    "Track",
    "Members",
    "Repository",
    "Repository submitted by",
    "Repository time (PHT)",
    "Presentation",
    "Presentation submitted by",
    "Presentation time (PHT)",
  ];
  const pht = (d) =>
    d
      ? new Date(d).toLocaleString("en-PH", {
          timeZone: "Asia/Manila",
          hour12: false,
        })
      : "";
  const rows = teams.map((t) => {
    const r = by(t, "repository");
    const p = by(t, "presentation");
    return [
      t.name,
      t.track
        ? (EVENT.tracks.find((x) => x.key === t.track)?.label ?? t.track)
        : "",
      t.members.map((m) => `${m.lastName}, ${m.firstName}`).join("; "),
      r?.url,
      r?.submittedByName,
      pht(r?.createdAt),
      p?.url,
      p?.submittedByName,
      pht(p?.createdAt),
    ];
  });
  const csv =
    "﻿" + [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
  const file = new AttachmentBuilder(Buffer.from(csv, "utf8"), {
    name: "onyx-submissions.csv",
  });
  return interaction.editReply({
    components: [
      container([
        text(
          `-# 📤  EXPORT\n# Ready — ${teams.length} team(s)\nOpen it in Excel / Google Sheets.`,
        ),
        { type: C.File, file: { url: "attachment://onyx-submissions.csv" } },
        footer(),
      ]),
    ],
    files: [file],
    flags: MessageFlags.IsComponentsV2,
  });
};

const reset = async (interaction, config) => {
  const team = await findTeamByName(
    interaction.guildId,
    interaction.options.getString("team"),
  );
  if (!team)
    return respond(
      interaction,
      notice("error", "Team not found", "Pick a team from the list."),
    );
  const type = interaction.options.getString("type");
  const removed = await Submission.findOneAndDelete({
    guildId: interaction.guildId,
    teamId: team._id,
    type,
  });
  if (!removed)
    return respond(
      interaction,
      notice(
        "warn",
        "Nothing to reset",
        `**${team.name}** hasn't submitted a ${type}.`,
      ),
    );
  logEvent(interaction.guild, "submit.reset", {
    user: interaction.member,
    summary: `**${team.name}** · ${type} · by <@${interaction.user.id}>`,
    fields: [["Old link", removed.url]],
  });
  refreshBoard(interaction.guild, { teamId: team._id });
  refreshSubmissionPanel(interaction.client, interaction.guildId);
  return respond(
    interaction,
    notice(
      "ok",
      "Submission reset",
      `**${team.name}** can submit their ${type} again.\nOld link: ${removed.url}`,
    ),
  );
};
