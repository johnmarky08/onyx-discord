import { MessageFlags } from "discord.js";
import { EVENT, trackLabel } from "../config/event.js";
import { STYLE } from "../config/style.js";
import { GuildConfig, Team } from "../models/index.js";
import { logEvent } from "../lib/logs.js";
import { memberKey, mute } from "../lib/quiet.js";
import { refreshBoard } from "../lib/board.js";
import { rateLimited, withLock } from "../lib/guards.js";
import { error } from "../lib/logger.js";
import {
  buildNickname,
  cleanPersonName,
  cleanTeamName,
  normalizeKey,
  personKey,
  suggestTeams,
} from "../lib/names.js";
import { IDS } from "../lib/panels.js";
import { ensureTeamResources } from "../lib/teams.js";
import {
  avatarOf,
  bigSep,
  container,
  footer,
  heading,
  kv,
  notice,
  respond,
  sep,
  text,
  textModal,
  ts,
  v2,
  withThumb,
} from "../lib/ui.js";

const NOT_READY = notice(
  "error",
  "Verification isn't open yet",
  "The server hasn't been set up by the organizers. Please try again in a moment or ask a facilitator.",
);

/** Verify button -> show the modal (prefilled if this person was verified before and came back). */
export const onVerifyButton = async (interaction) => {
  const config = await GuildConfig.findOne({ guildId: interaction.guildId });
  if (!config?.isComplete()) return interaction.reply(NOT_READY);

  const existing = await Team.findOne({
    guildId: interaction.guildId,
    "members.userId": interaction.user.id,
  });
  const member = existing?.members.find(
    (m) => m.userId === interaction.user.id,
  );

  if (
    existing &&
    interaction.member.roles.cache.has(config.participantRoleId) &&
    interaction.member.roles.cache.has(existing.roleId)
  ) {
    return interaction.reply(
      notice(
        "info",
        "You're already verified",
        `You're part of **${existing.name}**.\n\n${spaceLine(existing) || "Ask a facilitator for your team space."}`,
      ),
    );
  }

  return interaction.showModal(
    textModal({
      id: IDS.verifyModal,
      title: "Participant Verification",
      intro:
        "Enter your details **exactly as your team registered them**. Your server nickname will be set to `[ Team Name ] Last Name, First Name`.",
      fields: [
        {
          id: "team",
          label: "Team Name",
          placeholder: "e.g. Byte Busters",
          min: 2,
          max: 60,
          value: existing?.name,
        },
        {
          id: "last",
          label: "Last Name",
          placeholder: "e.g. Dela Cruz",
          min: 1,
          max: 40,
          value: member?.lastName,
        },
        {
          id: "first",
          label: "First Name",
          placeholder: "e.g. Juan",
          min: 1,
          max: 40,
          value: member?.firstName,
        },
      ],
    }),
  );
};

const spaceLine = (team) => {
  const parts = [];
  if (team.textChannelId) parts.push(`💬 <#${team.textChannelId}>`);
  if (team.voiceChannelId) parts.push(`🔊 <#${team.voiceChannelId}>`);
  return parts.join("\n");
};

const teamSpacesExist = (guild, team) =>
  Boolean(
    team.roleId &&
    guild.roles.cache.has(team.roleId) &&
    team.categoryId &&
    guild.channels.cache.has(team.categoryId) &&
    team.textChannelId &&
    guild.channels.cache.has(team.textChannelId) &&
    team.voiceChannelId &&
    guild.channels.cache.has(team.voiceChannelId),
  );

/** Modal submit: look the team up, enrol the member, rename them, hand out roles, welcome them. */
export const onVerifyModal = async (interaction) => {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const { guild, user } = interaction;

  if (rateLimited(`verify:${guild.id}:${user.id}`, 6)) {
    return respond(
      interaction,
      notice(
        "warn",
        "Too many attempts",
        "Please wait a few minutes and try again, or ask a facilitator for help.",
      ),
    );
  }

  const config = await GuildConfig.findOne({ guildId: guild.id });
  if (!config?.isComplete()) return respond(interaction, NOT_READY);

  const teamInput = cleanTeamName(interaction.fields.getTextInputValue("team"));
  const last = cleanPersonName(interaction.fields.getTextInputValue("last"));
  const first = cleanPersonName(interaction.fields.getTextInputValue("first"));
  if (
    !normalizeKey(teamInput) ||
    !/\p{L}/u.test(last) ||
    !/\p{L}/u.test(first)
  ) {
    return respond(
      interaction,
      notice(
        "error",
        "Please check your details",
        "Team name, last name and first name are all required (letters only for names).",
      ),
    );
  }

  const reject = (reason, payload) => {
    logEvent(guild, "verify.fail", {
      user,
      summary: `<@${user.id}> · **${user.username}**`,
      fields: [
        ["Reason", reason],
        ["Team entered", teamInput],
        ["Name entered", `${first} ${last}`],
      ],
    });
    return respond(interaction, payload);
  };

  return withLock(`verify:${guild.id}:${user.id}`, async () => {
    // 1. Is the team registered?
    const nameKey = normalizeKey(teamInput);
    let team = await Team.findOne({ guildId: guild.id, nameKey });
    if (!team) {
      const all = await Team.find({ guildId: guild.id }).select("name nameKey");
      const close = suggestTeams(nameKey, all);
      const hint = close.length
        ? `\n\nDid you mean: ${close.map((t) => `**${t.name}**`).join(", ")}?`
        : "";
      return reject(
        "Team not found",
        notice(
          "error",
          "Team not found",
          `I couldn't find a registered team called **${teamInput}**. Check the spelling against your registration.${hint}\n\nStill stuck? Ask a facilitator.`,
        ),
      );
    }

    // 2. Already in some other team?
    const other = await Team.findOne({
      guildId: guild.id,
      "members.userId": user.id,
      _id: { $ne: team._id },
    });
    if (other) {
      return reject(
        "Already verified with another team",
        notice(
          "error",
          "Already verified with another team",
          `You're registered under **${other.name}**. If that's a mistake, please notify a facilitator.`,
        ),
      );
    }

    // 3. Is this person on the team's registered roster? (names come from /team add)
    if (!team.roster?.length) {
      return reject(
        "This team has no registered members yet",
        notice(
          "error",
          "This team has no registered members yet",
          "Please ask a facilitator to finish registering your team.",
        ),
      );
    }
    const key = personKey(last, first);
    const entry = team.roster.find((r) => r.key === key);
    if (!entry) {
      return reject(
        "Name not found on this team",
        notice(
          "error",
          "Name not found on this team",
          `I couldn't find **${first} ${last}** on the roster of **${team.name}**. Check the spelling against your registration, or ask a facilitator.`,
        ),
      );
    }
    if (entry.userId && entry.userId !== user.id) {
      return reject(
        "That name is already claimed",
        notice(
          "error",
          "That name is already claimed",
          "Another Discord account already verified as this person. If that's wrong, notify a facilitator.",
        ),
      );
    }

    // 4. Claim the roster spot (atomic: one account per person, never twice).
    const person = {
      userId: user.id,
      lastName: entry.lastName,
      firstName: entry.firstName,
    };
    const already = team.members.find((m) => m.userId === user.id);
    let joinedNow = false;
    if (!already) {
      const { nickname } = buildNickname(
        team.name,
        person.lastName,
        person.firstName,
      );
      const updated = await Team.findOneAndUpdate(
        {
          _id: team._id,
          roster: { $elemMatch: { key, userId: null } },
          "members.userId": { $ne: user.id },
        },
        {
          $set: { "roster.$.userId": user.id },
          $push: { members: { ...person, nickname, verifiedAt: new Date() } },
        },
        { new: true },
      );
      if (!updated) {
        return reject(
          "That name is already claimed",
          notice(
            "error",
            "That name is already claimed",
            "Someone just verified as this person. If that's wrong, notify a facilitator.",
          ),
        );
      }
      team = updated;
      joinedNow = true;
    }

    const rollback = async () => {
      if (joinedNow) {
        await Team.updateOne(
          { _id: team._id, "roster.userId": user.id },
          {
            $set: { "roster.$.userId": null },
            $pull: { members: { userId: user.id } },
          },
        ).catch(() => null);
      }
    };

    try {
      // 4. Make sure the team's role/category/channels exist (normally created by /team add or /onyx setup).
      if (!teamSpacesExist(guild, team)) {
        const res = await ensureTeamResources(guild, team, config);
        team = res.team;
      }

      // 5. Roles: participant + team.
      const member = await guild.members.fetch(user.id);
      mute(memberKey(guild.id, user.id)); // the verification log below already covers these role/nickname changes
      await member.roles.add(
        [config.participantRoleId, team.roleId],
        "Onyx: verified participant",
      );

      // 6. Nickname (non-fatal if it fails, e.g. server owner).
      const { nickname, truncated } = buildNickname(
        team.name,
        person.lastName,
        person.firstName,
      );
      let nickNote = "";
      try {
        await member.setNickname(nickname, "Onyx: verified participant");
        await Team.updateOne(
          { _id: team._id, "members.userId": user.id },
          { $set: { "members.$.nickname": nickname } },
        );
        if (truncated)
          nickNote = `\n-# Your nickname was shortened to fit Discord's 32-character limit.`;
      } catch {
        nickNote = `\n-# ⚠️ I couldn't change your nickname (Discord doesn't let bots rename the owner or members above my role). You can set it to \`${nickname}\` yourself.`;
      }

      logEvent(guild, joinedNow ? "verify.ok" : "verify.again", {
        user: member,
        summary: `<@${user.id}> → **${team.name}**`,
        fields: [
          ["Name", `${person.lastName}, ${person.firstName}`],
          ["Nickname", `\`${nickname}\``],
          [
            "Team",
            `**${team.name}**${team.track ? ` · ${trackLabel(team.track)}` : ""}`,
          ],
          [
            "Team progress",
            `${team.members.length}/${team.roster.length} verified`,
          ],
        ],
      });
      await refreshBoard(guild, { teamId: team._id });

      // 7. Welcome (ephemeral).
      return respond(
        interaction,
        v2(
          [
            container(
              [
                withThumb(
                  `-# ✅  VERIFIED\n# Welcome, ${person.firstName}!\nYou're officially part of **${team.name}** at ${EVENT.name}.`,
                  avatarOf(member),
                ),
                bigSep(),
                heading("🪪", "Your Details"),
                text(
                  kv([
                    ["Name:", `${person.lastName}, ${person.firstName}`],
                    ["Team:", team.name],
                    ["Track:", team.track ? trackLabel(team.track) : ""],
                    ["Nickname:", `\`${nickname}\``],
                  ]) + nickNote,
                ),
                sep(),
                heading("🏠", "Your Team Space"),
                text(
                  `${spaceLine(team)}\n-# Only your team and the facilitators can see these channels.`,
                ),
                sep(),
                heading("🧭", "What's next"),
                text(
                  kv([
                    ["Kickoff:", ts(EVENT.kickoff), "🚀"],
                    [
                      "Submit in",
                      `<#${config.submissionChannelId}> before ${ts(config.deadline)}`,
                      "📦",
                    ],
                  ]),
                ),
                footer(),
              ],
              STYLE.ok,
            ),
          ],
          { ephemeral: true },
        ),
      );
    } catch (e) {
      await rollback();
      error(
        `Verification failed for ${user.id} in ${guild.id}: ${e.message}`,
        e,
      );
      logEvent(guild, "verify.fail", {
        user,
        summary: `<@${user.id}> → **${team.name}**`,
        fields: [["Reason", `Discord error: ${e.message}`]],
      });
      const hierarchy = /Missing Permissions|Missing Access/i.test(e.message);
      return respond(
        interaction,
        notice(
          "error",
          "I couldn't finish verifying you",
          hierarchy
            ? "I don't have permission to give you your roles. A facilitator needs to move my role above the participant and team roles. Nothing was saved — please try again afterwards."
            : "Something went wrong on my side. Nothing was saved — please try again, or ask a facilitator.",
        ),
      );
    }
  });
};
