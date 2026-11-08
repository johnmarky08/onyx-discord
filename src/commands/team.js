import { ButtonStyle, MessageFlags, SlashCommandBuilder } from "discord.js";
import { EVENT, trackLabel } from "../config/event.js";
import { GuildConfig, Submission, Team } from "../models/index.js";
import { logEvent } from "../lib/logs.js";
import { memberKey, mute } from "../lib/quiet.js";
import { refreshBoard, removeTeamCard } from "../lib/board.js";
import { error } from "../lib/logger.js";
import {
  buildNickname,
  cleanPersonName,
  cleanTeamName,
  normalizeKey,
  parseRoster,
  personKey,
} from "../lib/names.js";
import { isStaff } from "../lib/perms.js";
import { refreshSubmissionPanel } from "../lib/panels.js";
import { deleteTeamResources, ensureTeamResources } from "../lib/teams.js";
import {
  bar,
  bigSep,
  button,
  container,
  footer,
  heading,
  kv,
  notice,
  respond,
  row,
  sep,
  text,
  ts,
  update,
  v2,
} from "../lib/ui.js";
import { findTeamByName, requireStaff, teamAutocomplete } from "./_shared.js";

const trackChoices = EVENT.tracks.map((t) => ({ name: t.label, value: t.key }));

export const data = new SlashCommandBuilder()
  .setName("team")
  .setDescription("Manage hackathon teams (facilitators)")
  .setDMPermission(false)
  .addSubcommand((s) =>
    s
      .setName("add")
      .setDescription("Register a team and build its private space")
      .addStringOption((o) =>
        o
          .setName("name")
          .setDescription("Team name exactly as registered")
          .setRequired(true)
          .setMaxLength(60),
      )
      .addStringOption((o) =>
        o
          .setName("members")
          .setDescription(
            '3-5 members as "Last, First; Last, First; ..." (e.g. Dela Cruz, Juan; Santos, Maria)',
          )
          .setRequired(true)
          .setMaxLength(600),
      )
      .addStringOption((o) =>
        o
          .setName("track")
          .setDescription("Challenge track")
          .addChoices(...trackChoices),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName("edit")
      .setDescription("Rename a team, change its track, or add/remove members")
      .addStringOption((o) =>
        o
          .setName("name")
          .setDescription("Team to edit")
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addStringOption((o) =>
        o.setName("new_name").setDescription("New team name").setMaxLength(60),
      )
      .addStringOption((o) =>
        o
          .setName("track")
          .setDescription("New challenge track")
          .addChoices(...trackChoices),
      )
      .addStringOption((o) =>
        o
          .setName("add_members")
          .setDescription('Add: "Last, First; Last, First"')
          .setMaxLength(600),
      )
      .addStringOption((o) =>
        o
          .setName("remove_members")
          .setDescription(
            'Remove: "Last, First; Last, First" (also unverifies them)',
          )
          .setMaxLength(600),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName("import")
      .setDescription(
        "Register many teams from a CSV file: one member per row = team,last name,first name[,track]",
      )
      .addAttachmentOption((o) =>
        o.setName("file").setDescription(".csv or .txt file").setRequired(true),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName("remove")
      .setDescription("Delete a team, its role, channels and submissions")
      .addStringOption((o) =>
        o
          .setName("name")
          .setDescription("Team")
          .setRequired(true)
          .setAutocomplete(true),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName("list")
      .setDescription(
        "List all teams with member counts and submission status",
      ),
  )
  .addSubcommand((s) =>
    s
      .setName("info")
      .setDescription("Show one team's members, channels and submissions")
      .addStringOption((o) =>
        o
          .setName("name")
          .setDescription("Team")
          .setRequired(true)
          .setAutocomplete(true),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName("unverify")
      .setDescription(
        "Remove a member from their team (fix a wrong verification)",
      )
      .addUserOption((o) =>
        o.setName("user").setDescription("The participant").setRequired(true),
      ),
  );

export const autocomplete = teamAutocomplete;

export const execute = async (interaction) => {
  const config = await requireStaff(interaction);
  if (!config) return;
  const sub = interaction.options.getSubcommand();
  if (sub === "add") return add(interaction, config);
  if (sub === "import") return bulkImport(interaction, config);
  if (sub === "edit") return edit(interaction, config);
  if (sub === "remove") return remove(interaction);
  if (sub === "list") return list(interaction, config);
  if (sub === "info") return info(interaction, config);
  if (sub === "unverify") return unverify(interaction, config);
};

const parseTrack = (raw) => {
  if (!raw) return null;
  const k = normalizeKey(raw);
  const t = EVENT.tracks.find(
    (x) =>
      x.key === k ||
      normalizeKey(x.label) === k ||
      normalizeKey(x.label).startsWith(k) ||
      (k.length >= 3 && normalizeKey(x.label).includes(k)),
  );
  return t?.key ?? null;
};

const buildRoster = (people) =>
  people.map((p) => ({
    ...p,
    key: personKey(p.lastName, p.firstName),
    userId: null,
  }));

/** Returns an error string, or null when the roster is acceptable for a team. */
const rosterProblem = (roster) => {
  const { min, max } = EVENT.teamSize;
  if (roster.length < min || roster.length > max)
    return `A team needs ${min}-${max} members (got ${roster.length}).`;
  if (new Set(roster.map((r) => r.key)).size !== roster.length)
    return "The same person is listed twice.";
  return null;
};

const createTeam = async (guildId, rawName, track, people) => {
  const name = cleanTeamName(rawName);
  const nameKey = normalizeKey(name);
  if (!nameKey) return { error: "empty name" };
  const roster = buildRoster(people);
  const problem = rosterProblem(roster);
  if (problem) return { error: problem };
  // a person can only be on one team
  const clash = await Team.findOne({
    guildId,
    "roster.key": { $in: roster.map((r) => r.key) },
  });
  if (clash) {
    const who = clash.roster.find((r) => roster.some((x) => x.key === r.key));
    return {
      error: `${who.lastName}, ${who.firstName} is already on team ${clash.name}`,
    };
  }
  try {
    const team = await Team.create({
      guildId,
      name,
      nameKey,
      track: track ?? null,
      roster,
    });
    return { team };
  } catch (e) {
    if (e?.code === 11000) return { error: "already exists" };
    throw e;
  }
};

const rosterText = (team) =>
  team.roster
    .map(
      (r) =>
        `• ${r.lastName}, ${r.firstName}${r.userId ? ` — <@${r.userId}>` : ""}`,
    )
    .join("\n");

const add = async (interaction, config) => {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const { people, errors } = parseRoster(
    interaction.options.getString("members"),
  );
  if (errors.length) {
    return respond(
      interaction,
      notice(
        "error",
        "Couldn't read the members",
        `Use \`Last, First; Last, First; ...\`. Problem with:\n${errors.map((e) => `- ${e}`).join("\n")}`,
      ),
    );
  }
  const res = await createTeam(
    interaction.guildId,
    interaction.options.getString("name"),
    interaction.options.getString("track"),
    people,
  );
  if (res.error)
    return respond(
      interaction,
      notice(
        "error",
        "Couldn't add the team",
        res.error === "already exists"
          ? "A team with that name already exists."
          : res.error,
      ),
    );

  if (!config.isComplete()) {
    return respond(
      interaction,
      notice(
        "warn",
        `Team "${res.team.name}" registered`,
        `${rosterText(res.team)}\n\nThe server isn't set up yet, so no channels were created. Run \`/onyx setup\` — I'll build every team's space then.`,
      ),
    );
  }
  try {
    const { team } = await ensureTeamResources(
      interaction.guild,
      res.team,
      config,
    );
    logEvent(interaction.guild, "team.add", {
      user: interaction.member,
      summary: `**${team.name}** · by <@${interaction.user.id}>`,
      fields: [
        ["Track", team.track ? trackLabel(team.track) : ""],
        ["Members", `${team.roster.length}`],
        ["Space", `💬 <#${team.textChannelId}> · 🔊 <#${team.voiceChannelId}>`],
      ],
      note: team.roster.map((r) => `${r.lastName}, ${r.firstName}`).join("\n"),
    });
    refreshBoard(interaction.guild, { teamId: team._id });
    return respond(
      interaction,
      v2(
        [
          container(
            [
              text(
                `-# 🧩  TEAM REGISTERED\n# ${team.name}${team.track ? `\n${trackLabel(team.track)}` : ""}`,
              ),
              sep(),
              heading("👥", `Roster (${team.roster.length})`),
              text(rosterText(team)),
              sep(),
              heading("🏠", "Team space"),
              text(
                `<@&${team.roleId}>\n💬 <#${team.textChannelId}>\u2002·\u2002🔊 <#${team.voiceChannelId}>`,
              ),
              footer(),
            ],
            0x4ade80,
          ),
        ],
        { ephemeral: true },
      ),
    );
  } catch (e) {
    error(`/team add failed to build space: ${e.message}`, e);
    return respond(
      interaction,
      notice(
        "warn",
        `Team "${res.team.name}" registered, but the space failed`,
        `${e.message}\nFix the problem and run \`/onyx sync\`.`,
      ),
    );
  }
};

const bulkImport = async (interaction, config) => {
  const file = interaction.options.getAttachment("file");
  if (file.size > 200_000)
    return interaction.reply(
      notice("error", "File too large", "Keep it under 200 KB."),
    );
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let raw;
  try {
    const res = await fetch(file.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    raw = await res.text();
  } catch (e) {
    return respond(
      interaction,
      notice("error", "Couldn't read the file", e.message),
    );
  }

  const rows = raw
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, "")));
  if (rows.length && /^(team|team name|name)$/i.test(rows[0][0])) rows.shift();
  if (!rows.length)
    return respond(
      interaction,
      notice(
        "error",
        "The file is empty",
        "One member per row: `Team name,Last name,First name,Track` (track optional).",
      ),
    );
  if (rows.length > 800)
    return respond(
      interaction,
      notice("error", "Too many rows", "Max 800 rows per import."),
    );

  // group member rows by team
  const groups = new Map();
  const skipped = [];
  for (const [teamRaw, last, first, trackRaw] of rows) {
    const key = normalizeKey(teamRaw ?? "");
    if (!key || !last || !first) {
      skipped.push(
        `${teamRaw || "(blank)"} — row needs team, last name and first name`,
      );
      continue;
    }
    if (!groups.has(key))
      groups.set(key, { name: teamRaw, track: null, people: [] });
    const g = groups.get(key);
    g.track ??= parseTrack(trackRaw);
    g.people.push({
      lastName: cleanPersonName(last),
      firstName: cleanPersonName(first),
    });
  }

  const created = [];
  const failed = [];
  for (const g of groups.values()) {
    const res = await createTeam(
      interaction.guildId,
      g.name,
      g.track,
      g.people,
    );
    if (res.error) {
      skipped.push(`${g.name} — ${res.error}`);
      continue;
    }
    if (config.isComplete()) {
      try {
        await ensureTeamResources(interaction.guild, res.team, config);
      } catch (e) {
        failed.push(`${res.team.name} — ${e.message}`);
        continue;
      }
    }
    created.push(res.team.name);
  }

  const parts = [
    `✅ **${created.length}** team(s) registered${config.isComplete() ? " with spaces" : ""}.`,
  ];
  if (!config.isComplete())
    parts.push(
      "ℹ️ The server isn't set up yet — spaces will be created when you run `/onyx setup`.",
    );
  if (skipped.length)
    parts.push(
      `⏭️ **Skipped ${skipped.length}:**\n${skipped
        .slice(0, 10)
        .map((x) => `- ${x}`)
        .join("\n")}${skipped.length > 10 ? "\n- …" : ""}`,
    );
  if (failed.length)
    parts.push(
      `❌ **Space failed for ${failed.length}** (run \`/onyx sync\`):\n${failed
        .slice(0, 10)
        .map((x) => `- ${x}`)
        .join("\n")}`,
    );
  refreshSubmissionPanel(interaction.client, interaction.guildId);
  logEvent(interaction.guild, "team.import", {
    user: interaction.member,
    summary: `by <@${interaction.user.id}>`,
    fields: [
      ["Registered", String(created.length)],
      ["Skipped", skipped.length ? String(skipped.length) : ""],
      ["Space failed", failed.length ? String(failed.length) : ""],
    ],
    note: created.slice(0, 25).join(", "),
  });
  refreshBoard(interaction.guild); // builds a card for every new team
  return respond(
    interaction,
    v2(
      [
        container(
          [
            text(
              `-# 📥  IMPORT FINISHED\n# ${created.length} team(s) registered`,
            ),
            sep(),
            text(parts.join("\n\n").slice(0, 3400)),
            footer(),
          ],
          failed.length ? 0xfbbf24 : 0x4ade80,
        ),
      ],
      { ephemeral: true },
    ),
  );
};

/** Take a verified person off the team: roles, nickname, member record and roster claim. */
const releaseMember = async (guild, config, team, userId, reason) => {
  const member = await guild.members.fetch(userId).catch(() => null);
  if (member) {
    mute(memberKey(guild.id, userId));
    await member.roles
      .remove([config.participantRoleId, team.roleId].filter(Boolean), reason)
      .catch(() => null);
    await member.setNickname(null, reason).catch(() => null);
  }
};

const edit = async (interaction, config) => {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const team = await findTeamByName(
    interaction.guildId,
    interaction.options.getString("name"),
  );
  if (!team)
    return respond(
      interaction,
      notice("error", "Team not found", "Pick a team from the list."),
    );

  const newName = interaction.options.getString("new_name");
  const track = interaction.options.getString("track");
  const addRaw = interaction.options.getString("add_members");
  const removeRaw = interaction.options.getString("remove_members");
  if (!newName && !track && !addRaw && !removeRaw) {
    return respond(
      interaction,
      notice(
        "warn",
        "Nothing to change",
        "Give at least one of: `new_name`, `track`, `add_members`, `remove_members`.",
      ),
    );
  }

  const changes = [];
  let renamed = false;

  // --- roster changes (validated before anything is saved) ---
  let roster = team.roster.map((r) => r.toObject?.() ?? { ...r });
  const toRelease = [];
  if (removeRaw) {
    const { people, errors } = parseRoster(removeRaw);
    if (errors.length)
      return respond(
        interaction,
        notice(
          "error",
          "Couldn't read remove_members",
          `Use \`Last, First; Last, First\`. Problem with: ${errors.join("; ")}`,
        ),
      );
    for (const p of people) {
      const key = personKey(p.lastName, p.firstName);
      const found = roster.find((r) => r.key === key);
      if (!found)
        return respond(
          interaction,
          notice(
            "error",
            "Member not on the roster",
            `**${p.lastName}, ${p.firstName}** isn't on ${team.name}.`,
          ),
        );
      if (found.userId) toRelease.push(found.userId);
      roster = roster.filter((r) => r.key !== key);
      changes.push(`➖ ${found.lastName}, ${found.firstName}`);
    }
  }
  if (addRaw) {
    const { people, errors } = parseRoster(addRaw);
    if (errors.length)
      return respond(
        interaction,
        notice(
          "error",
          "Couldn't read add_members",
          `Use \`Last, First; Last, First\`. Problem with: ${errors.join("; ")}`,
        ),
      );
    const added = buildRoster(people);
    roster = [...roster, ...added];
    const clash = await Team.findOne({
      guildId: interaction.guildId,
      _id: { $ne: team._id },
      "roster.key": { $in: added.map((r) => r.key) },
    });
    if (clash)
      return respond(
        interaction,
        notice(
          "error",
          "Already on another team",
          `One of those people is already on **${clash.name}**.`,
        ),
      );
    for (const a of added) changes.push(`➕ ${a.lastName}, ${a.firstName}`);
  }
  if (addRaw || removeRaw) {
    if (
      roster.length > EVENT.teamSize.max ||
      new Set(roster.map((r) => r.key)).size !== roster.length
    ) {
      return respond(
        interaction,
        notice(
          "error",
          "Invalid roster",
          `A team can have at most ${EVENT.teamSize.max} members, with no duplicates.`,
        ),
      );
    }
    if (roster.length < EVENT.teamSize.min)
      changes.push(
        `⚠️ team now has only ${roster.length} members (rules say ${EVENT.teamSize.min}-${EVENT.teamSize.max})`,
      );
  }

  // --- rename ---
  if (newName) {
    const name = cleanTeamName(newName);
    const nameKey = normalizeKey(name);
    if (!nameKey)
      return respond(
        interaction,
        notice("error", "Invalid name", "The new name is empty."),
      );
    if (nameKey !== team.nameKey) {
      const dupe = await Team.findOne({
        guildId: interaction.guildId,
        nameKey,
        _id: { $ne: team._id },
      });
      if (dupe)
        return respond(
          interaction,
          notice(
            "error",
            "Name already used",
            `Another team is already called **${dupe.name}**.`,
          ),
        );
    }
    changes.push(`✏️ Renamed **${team.name}** → **${name}**`);
    team.name = name;
    team.nameKey = nameKey;
    renamed = true;
  }
  if (track) {
    team.track = track;
    changes.push(`🧭 Track → ${trackLabel(track)}`);
  }

  // --- release removed members, then save ---
  for (const userId of toRelease)
    await releaseMember(
      interaction.guild,
      config,
      team,
      userId,
      "Onyx: removed from team",
    );
  team.members = team.members.filter((m) => !toRelease.includes(m.userId));
  team.roster = roster;
  await team.save();

  // --- Discord side: names/channels and member nicknames ---
  const notes = [];
  if (config.isComplete() && renamed) {
    try {
      await ensureTeamResources(interaction.guild, team, config);
    } catch (e) {
      notes.push(
        `⚠️ Couldn't rename the role/channels (${e.message}) — try \`/onyx sync\`.`,
      );
    }
  }
  if (renamed) {
    for (const m of team.members) {
      const gm = await interaction.guild.members
        .fetch(m.userId)
        .catch(() => null);
      mute(memberKey(interaction.guildId, m.userId));
      const { nickname } = buildNickname(team.name, m.lastName, m.firstName);
      await gm?.setNickname(nickname, "Onyx: team renamed").catch(() => null);
      m.nickname = nickname;
    }
    await team.save();
  }

  logEvent(interaction.guild, "team.edit", {
    user: interaction.member,
    summary: `**${team.name}** · by <@${interaction.user.id}>`,
    note: changes.join("\n"),
  });
  refreshSubmissionPanel(interaction.client, interaction.guildId);
  refreshBoard(interaction.guild, { teamId: team._id });
  return respond(
    interaction,
    v2(
      [
        container(
          [
            text(`-# 🛠️  TEAM UPDATED\n# ${team.name}`),
            sep(),
            heading("📝", "What changed"),
            text([...changes, ...notes].join("\n") || "—"),
            sep(),
            heading("👥", "Roster"),
            text(rosterText(team)),
            footer(),
          ],
          0xfbbf24,
        ),
      ],
      { ephemeral: true },
    ),
  );
};

const remove = async (interaction) => {
  const team = await findTeamByName(
    interaction.guildId,
    interaction.options.getString("name"),
  );
  if (!team)
    return interaction.reply(
      notice("error", "Team not found", "Pick a team from the list."),
    );
  return interaction.reply(
    v2(
      [
        container(
          [
            text(`### 🗑️ Delete team "${team.name}"?`),
            sep(),
            text(
              `This permanently deletes the team's **role, category, text and voice channels** and its **submissions**, ` +
                `removes the participant role and resets nicknames for its ${team.members.length} verified member(s).\n**This can't be undone.**`,
            ),
            row(
              button({
                id: `onyx:team-remove:confirm:${team._id}`,
                label: "Delete team",
                emoji: "🗑️",
                style: ButtonStyle.Danger,
              }),
              button({
                id: "onyx:team-remove:cancel",
                label: "Cancel",
                style: ButtonStyle.Secondary,
              }),
            ),
          ],
          0xed4245,
        ),
      ],
      { ephemeral: true },
    ),
  );
};

export const onTeamRemoveButton = async (interaction, action, teamId) => {
  const config = await GuildConfig.findOne({ guildId: interaction.guildId });
  if (!isStaff(interaction.member, config))
    return interaction.reply(
      notice("error", "Facilitators only", "You can't do that."),
    );
  if (action === "cancel")
    return update(
      interaction,
      notice("info", "Cancelled", "Nothing was deleted."),
    );

  await interaction.deferUpdate();
  const team = await Team.findOne({
    _id: teamId,
    guildId: interaction.guildId,
  });
  if (!team)
    return interaction.editReply({
      ...notice("warn", "Already gone", "That team no longer exists."),
      flags: MessageFlags.IsComponentsV2,
    });

  // Free the members first (while the roles still exist).
  for (const m of team.members) {
    const member = await interaction.guild.members
      .fetch(m.userId)
      .catch(() => null);
    if (!member) continue;
    mute(memberKey(interaction.guildId, m.userId));
    if (config?.participantRoleId)
      await member.roles
        .remove(config.participantRoleId, "Onyx: team removed")
        .catch(() => null);
    await member.setNickname(null, "Onyx: team removed").catch(() => null);
  }
  const problems = await deleteTeamResources(interaction.guild, team);
  await removeTeamCard(interaction.guild, team);
  await Submission.deleteMany({
    guildId: interaction.guildId,
    teamId: team._id,
  });
  await Team.deleteOne({ _id: team._id });
  logEvent(interaction.guild, "team.remove", {
    user: interaction.member,
    summary: `**${team.name}** · by <@${interaction.user.id}>`,
    fields: [["Members released", String(team.members.length)]],
  });
  refreshSubmissionPanel(interaction.client, interaction.guildId);
  return interaction.editReply({
    ...notice(
      problems.length ? "warn" : "ok",
      `Team "${team.name}" deleted`,
      problems.length
        ? `Some leftovers couldn't be removed:\n${problems.join("\n")}`
        : "Role, channels, submissions and record are gone.",
    ),
    flags: MessageFlags.IsComponentsV2,
  });
};

const list = async (interaction, config) => {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const [teams, subs] = await Promise.all([
    Team.find({ guildId: interaction.guildId }).sort({ name: 1 }),
    Submission.find({ guildId: interaction.guildId }).select("teamId type"),
  ]);
  if (!teams.length)
    return respond(
      interaction,
      notice(
        "info",
        "No teams yet",
        "Add some with `/team add` or `/team import`.",
      ),
    );
  const has = (team, type) =>
    subs.some((s) => String(s.teamId) === String(team._id) && s.type === type);
  const max = config.maxTeamSize ?? EVENT.teamSize.max;
  const lines = [];
  let used = 0;
  for (const t of teams) {
    const verified = `${t.members.length}/${t.roster.length || max}`;
    const state =
      has(t, "repository") && has(t, "presentation")
        ? "🟢"
        : has(t, "repository") || has(t, "presentation")
          ? "🟡"
          : "⚪";
    const line = `${state} **${t.name}**\u2002👥 ${verified}\u2002🗂️${has(t, "repository") ? "✅" : "▫️"}\u2002🎞️${has(t, "presentation") ? "✅" : "▫️"}${t.roleId && t.categoryId ? "" : "\u2002⚠️ no space"}`;
    if (used + line.length > 3200) {
      lines.push(
        `…and ${teams.length - lines.length} more — use \`/submissions export\` for the full list.`,
      );
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  const verifiedTotal = teams.reduce((n, t) => n + t.members.length, 0);
  const rosterTotal = teams.reduce((n, t) => n + t.roster.length, 0);
  return respond(
    interaction,
    v2(
      [
        container([
          text(
            `-# 👥  TEAMS\n# ${teams.length} registered\n${bar(verifiedTotal, rosterTotal)}  **${verifiedTotal}/${rosterTotal}** participants verified`,
          ),
          sep(),
          text(lines.join("\n")),
          text(
            "-# 🟢 complete  ·  🟡 partial  ·  ⚪ waiting  ·  🗂️ repository  ·  🎞️ presentation",
          ),
          footer(),
        ]),
      ],
      { ephemeral: true },
    ),
  );
};

const info = async (interaction, config) => {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const team = await findTeamByName(
    interaction.guildId,
    interaction.options.getString("name"),
  );
  if (!team)
    return respond(
      interaction,
      notice("error", "Team not found", "Pick a team from the list."),
    );
  const subs = await Submission.find({
    guildId: interaction.guildId,
    teamId: team._id,
  });
  const sub = (type, label) => {
    const s = subs.find((x) => x.type === type);
    return s
      ? `${label}: ✅ ${s.url}\n-# by ${s.submittedByName ?? "?"} · ${ts(s.createdAt, "R")}`
      : `${label}: ⏳ not submitted`;
  };
  const members = team.roster.length
    ? team.roster
        .map(
          (r) =>
            `${r.userId ? "✅" : "⏳"} ${r.lastName}, ${r.firstName}${r.userId ? ` — <@${r.userId}>` : ""}`,
        )
        .join("\n")
    : "*no roster*";
  return respond(
    interaction,
    v2(
      [
        container([
          text(
            `-# 🧩  TEAM\n# ${team.name}${team.track ? `\n${trackLabel(team.track)}` : ""}`,
          ),
          bigSep(),
          heading(
            "👥",
            `Roster · ${team.members.length}/${team.roster.length} verified`,
          ),
          text(members),
          sep(),
          heading("🏠", "Team space"),
          text(
            `${team.roleId ? `<@&${team.roleId}>\n` : ""}${team.textChannelId ? `💬 <#${team.textChannelId}>` : ""}\u2002${team.voiceChannelId ? `🔊 <#${team.voiceChannelId}>` : ""}`,
          ),
          bigSep(),
          heading("📦", "Submissions"),
          text(
            `${sub("repository", "🗂️ Repository")}\n${sub("presentation", "🎞️ Presentation")}`,
          ),
          footer(),
        ]),
      ],
      { ephemeral: true },
    ),
  );
};

const unverify = async (interaction, config) => {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const user = interaction.options.getUser("user");
  const team = await Team.findOneAndUpdate(
    { guildId: interaction.guildId, "members.userId": user.id },
    {
      $pull: { members: { userId: user.id } },
      $set: { "roster.$[r].userId": null },
    },
    { new: false, arrayFilters: [{ "r.userId": user.id }] },
  );
  if (!team)
    return respond(
      interaction,
      notice("warn", "Not verified", `${user} isn't verified with any team.`),
    );

  const member = await interaction.guild.members
    .fetch(user.id)
    .catch(() => null);
  if (member) {
    mute(memberKey(interaction.guildId, user.id));
    const ids = [config.participantRoleId, team.roleId].filter(Boolean);
    await member.roles
      .remove(ids, "Onyx: unverified by facilitator")
      .catch(() => null);
    await member
      .setNickname(null, "Onyx: unverified by facilitator")
      .catch(() => null);
  }
  logEvent(interaction.guild, "verify.undo", {
    user,
    summary: `<@${user.id}> removed from **${team.name}**`,
    fields: [["By", `<@${interaction.user.id}>`]],
  });
  refreshBoard(interaction.guild, { teamId: team._id });
  return respond(
    interaction,
    notice(
      "ok",
      "Member removed",
      `${user} was removed from **${team.name}** and can verify again.`,
    ),
  );
};
