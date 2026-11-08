import { randomBytes } from "node:crypto";
import {
  AttachmentBuilder,
  ButtonStyle,
  ComponentType as C,
  MessageFlags,
} from "discord.js";
import { STYLE } from "../config/style.js";
import { trackLabel } from "../config/event.js";
import { GuildConfig, Submission, Team } from "../models/index.js";
import { logEvent } from "../lib/logs.js";
import { refreshBoard } from "../lib/board.js";
import { TtlMap } from "../lib/guards.js";
import { error } from "../lib/logger.js";
import { IDS, isClosed, refreshSubmissionPanel } from "../lib/panels.js";
import {
  checkPresentationFile,
  parseRepoUrl,
  safeFileName,
  sniffPresentation,
} from "../lib/validate.js";
import {
  bar,
  bigSep,
  button,
  container,
  fileModal,
  footer,
  heading,
  kv,
  notice,
  respond,
  row,
  sep,
  text,
  textModal,
  ts,
  update,
  v2,
} from "../lib/ui.js";

const LABEL = {
  repository: { name: "repository", title: "Repository", emoji: "🗂️" },
  presentation: { name: "presentation", title: "Presentation", emoji: "🎞️" },
};

const downloadFile = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};

// Pending confirmations (in memory, 10 minutes). Nothing is saved until the user presses Confirm.
const pending = new TtlMap(10 * 60 * 1000);

const FACILITATOR_NOTE =
  "If you think something went wrong, please **notify the facilitators** — don't try to resubmit.";

const alreadySubmitted = (sub, type) =>
  notice(
    "warn",
    `Your team already submitted the ${LABEL[type].name}`,
    `**${sub.submittedByName ?? "A teammate"}** submitted it ${ts(sub.createdAt, "R")}:\n${sub.fileName ? `📎 ${sub.fileName} — ` : ""}${sub.url}\n\n` +
      `Each item can only be submitted once per team. ${FACILITATOR_NOTE}`,
  );

const closedNotice = (config) =>
  notice(
    "error",
    "Submissions are closed",
    `The deadline was ${ts(config.deadline)}. ${FACILITATOR_NOTE}`,
  );

/** Common checks for both buttons and modals. Returns { config, team } or { fail: payload }. */
const gate = async (interaction) => {
  const config = await GuildConfig.findOne({ guildId: interaction.guildId });
  if (!config?.isComplete())
    return {
      fail: notice(
        "error",
        "Submissions aren't set up yet",
        "Please let a facilitator know.",
      ),
    };
  const team = await Team.findOne({
    guildId: interaction.guildId,
    "members.userId": interaction.user.id,
  });
  if (!team) {
    return {
      fail: notice(
        "error",
        "Verify first",
        "Only verified team members can submit. Head to the welcome channel and press **Verify**.",
      ),
    };
  }
  return { config, team };
};

/** "Submit Repository" / "Submit Presentation" button -> modal. */
export const onSubmitButton = async (interaction, type) => {
  const g = await gate(interaction);
  if (g.fail) return interaction.reply(g.fail);
  if (isClosed(g.config)) return interaction.reply(closedNotice(g.config));

  const existing = await Submission.findOne({
    guildId: interaction.guildId,
    teamId: g.team._id,
    type,
  });
  if (existing) return interaction.reply(alreadySubmitted(existing, type));

  const title = `Submit ${LABEL[type].title} — ${g.team.name}`.slice(0, 45);
  if (type === "presentation") {
    return interaction.showModal(
      fileModal({
        id: IDS.submitModal + type,
        title,
        intro:
          "Upload your team's **presentation** as a **PDF or PPTX** file (max 25 MB).",
        label: "Presentation File",
        description: "PDF or PPTX only",
      }),
    );
  }
  return interaction.showModal(
    textModal({
      id: IDS.submitModal + type,
      title,
      intro:
        "Paste your team's **GitHub repository** link. It must be public or shared with the judging committee, and the README.md must be complete.",
      fields: [
        {
          id: "url",
          label: "GitHub Repository Link",
          placeholder: "https://github.com/your-team/your-repo",
          min: 8,
          max: 400,
        },
      ],
    }),
  );
};

/** Modal submit -> validate -> ask for confirmation. */
export const onSubmitModal = async (interaction, type) => {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const g = await gate(interaction);
  if (g.fail) return respond(interaction, g.fail);
  if (isClosed(g.config)) return respond(interaction, closedNotice(g.config));

  const existing = await Submission.findOne({
    guildId: interaction.guildId,
    teamId: g.team._id,
    type,
  });
  if (existing) return respond(interaction, alreadySubmitted(existing, type));

  let entry;
  let shown;
  if (type === "repository") {
    const parsed = parseRepoUrl(interaction.fields.getTextInputValue("url"));
    if (!parsed.ok)
      return respond(
        interaction,
        notice("error", "That link can't be accepted", parsed.reason),
      );
    entry = { url: parsed.url };
    shown = parsed.url;
  } else {
    const file = interaction.fields.getUploadedFiles("file")?.first();
    if (!file)
      return respond(
        interaction,
        notice(
          "error",
          "No file received",
          "Please upload a PDF or PPTX file.",
        ),
      );
    const check = checkPresentationFile(file);
    if (!check.ok)
      return respond(
        interaction,
        notice("error", "That file can't be accepted", check.reason),
      );
    let buf;
    try {
      buf = await downloadFile(file.url);
    } catch (e) {
      return respond(
        interaction,
        notice("error", "I couldn't read that file", "Please upload it again."),
      );
    }
    if (!sniffPresentation(buf, check.ext)) {
      return respond(
        interaction,
        notice(
          "error",
          "That file isn't a real " + check.ext.toUpperCase(),
          "The file looks corrupted or was renamed. Export it again as PDF or PPTX and re-upload.",
        ),
      );
    }
    entry = {
      file: {
        url: file.url,
        name: safeFileName(file.name, check.ext),
        size: file.size,
        ext: check.ext,
      },
    };
    shown = `📎 **${entry.file.name}** (${(file.size / 1024 / 1024).toFixed(1)} MB)`;
  }

  const token = randomBytes(6).toString("hex");
  pending.set(token, {
    guildId: interaction.guildId,
    userId: interaction.user.id,
    teamId: String(g.team._id),
    type,
    ...entry,
  });

  return respond(
    interaction,
    v2(
      [
        container(
          [
            text(
              `-# ${LABEL[type].emoji}  ALMOST DONE\n# Confirm Your ${LABEL[type].title}\nTeam **${g.team.name}**`,
            ),
            sep(),
            heading(
              LABEL[type].emoji,
              type === "repository" ? "Your Repository:" : "Your File:",
            ),
            text(shown),
            bigSep(),
            text(
              `⚠️ **This is final.** Once confirmed it's locked for your whole team — nobody, including you, can change it. ` +
                `If it needs fixing later, a facilitator has to do it.`,
            ),
            row(
              button({
                id: IDS.submitConfirm + token,
                label: "Confirm & Submit",
                emoji: "✅",
                style: ButtonStyle.Success,
              }),
              button({
                id: IDS.submitCancel + token,
                label: "Cancel",
                style: ButtonStyle.Secondary,
              }),
            ),
          ],
          STYLE.warn,
        ),
      ],
      { ephemeral: true },
    ),
  );
};

export const onSubmitCancel = async (interaction, token) => {
  pending.delete(token);
  return update(
    interaction,
    notice(
      "info",
      "Submission cancelled",
      "Nothing was saved. You can start again from the submission channel.",
    ),
  );
};

export const onSubmitConfirm = async (interaction, token) => {
  await interaction.deferUpdate();
  const out = (payload) =>
    interaction.editReply({ ...payload, flags: MessageFlags.IsComponentsV2 });

  const p = pending.get(token);
  if (
    !p ||
    p.userId !== interaction.user.id ||
    p.guildId !== interaction.guildId
  ) {
    return out(
      notice(
        "warn",
        "This confirmation expired",
        "Press the submit button again to start over.",
      ),
    );
  }

  const g = await gate(interaction);
  if (g.fail) return out(g.fail);
  if (String(g.team._id) !== p.teamId)
    return out(
      notice(
        "error",
        "Team changed",
        "Your team changed since you started — please start again.",
      ),
    );
  if (isClosed(g.config)) {
    pending.delete(token);
    return out(closedNotice(g.config));
  }

  const me = g.team.members.find((m) => m.userId === interaction.user.id);
  const submitter = me
    ? `${me.lastName}, ${me.firstName}`
    : interaction.user.username;
  const { guild, client } = interaction;
  const isFile = p.type === "presentation";

  // Presentations are copied into the team's private channel so the file (and a permanent link) lives on Discord.
  let stored = null;
  let fileBuf = null;
  if (isFile) {
    try {
      const buf = await downloadFile(p.file.url);
      fileBuf = buf;
      if (!sniffPresentation(buf, p.file.ext)) throw new Error("bad file");
      const channel = g.team.textChannelId
        ? await guild.channels.fetch(g.team.textChannelId)
        : null;
      if (!channel) throw new Error("no team channel");
      stored = await channel.send({
        ...v2([
          container(
            [
              text(
                `-# 🎞️  PRESENTATION SUBMITTED\n### ${g.team.name}\n${kv([
                  ["By:", submitter, "👤"],
                  ["File:", p.file.name, "📎"],
                ])}\n-# Stored by Onyx so the judges can always find it.`,
              ),
              { type: C.File, file: { url: `attachment://${p.file.name}` } },
            ],
            STYLE.ok,
          ),
        ]),
        files: [new AttachmentBuilder(buf, { name: p.file.name })],
      });
    } catch (e) {
      error(`Presentation upload failed: ${e.message}`, e);
      return out(
        notice(
          "error",
          "Couldn't store your file",
          `Nothing was submitted. The file may be too large for this server's upload limit — try compressing it and submitting again. ${FACILITATOR_NOTE}`,
        ),
      );
    }
  }

  try {
    // The unique index (guild, team, type) makes this atomic: the first insert wins.
    await Submission.create({
      guildId: p.guildId,
      teamId: g.team._id,
      teamName: g.team.name,
      type: p.type,
      url: isFile ? stored.url : p.url,
      fileName: isFile ? p.file.name : null,
      fileSize: isFile ? p.file.size : null,
      channelId: isFile ? stored.channelId : null,
      messageId: isFile ? stored.id : null,
      submittedBy: interaction.user.id,
      submittedByName: submitter,
    });
  } catch (e) {
    pending.delete(token);
    if (stored) await stored.delete().catch(() => null); // lost the race: remove our copy
    if (e?.code === 11000) {
      const sub = await Submission.findOne({
        guildId: p.guildId,
        teamId: g.team._id,
        type: p.type,
      });
      return out(
        sub
          ? alreadySubmitted(sub, p.type)
          : notice("warn", "Already submitted", FACILITATOR_NOTE),
      );
    }
    error(`Submission insert failed: ${e.message}`, e);
    return out(
      notice(
        "error",
        "Couldn't save your submission",
        `Nothing was saved. Please try again. ${FACILITATOR_NOTE}`,
      ),
    );
  }

  pending.delete(token);
  const link = isFile ? stored.url : p.url;
  const what = isFile ? `📎 ${p.file.name}\n${link}` : link;

  // Side effects are best-effort: the submission is already safely stored.
  logEvent(guild, isFile ? "submit.ppt" : "submit.repo", {
    user: interaction.member ?? interaction.user,
    summary: `**${g.team.name}** · by <@${interaction.user.id}> (${submitter})`,
    fields: [
      [
        "Team",
        `**${g.team.name}**${g.team.track ? ` · ${trackLabel(g.team.track)}` : ""}`,
      ],
      [
        isFile ? "File" : "Repository",
        isFile
          ? `📎 ${p.file.name} (${(p.file.size / 1048576).toFixed(1)} MB)\n${link}`
          : link,
      ],
    ],
  });
  await refreshBoard(guild, {
    teamId: g.team._id,
    file: isFile ? { teamId: String(g.team._id), buffer: fileBuf } : null,
  });
  await refreshSubmissionPanel(client, interaction.guildId);
  if (!isFile && g.team.textChannelId) {
    guild.channels
      .fetch(g.team.textChannelId)
      .then((ch) =>
        ch?.send(
          v2([
            container(
              [
                text(
                  `-# ${LABEL[p.type].emoji}  REPOSITORY SUBMITTED\n### ${g.team.name}\n${kv(
                    [
                      ["By:", submitter, "👤"],
                      ["Link:", p.url, "🔗"],
                    ],
                  )}`,
                ),
              ],
              STYLE.ok,
            ),
          ]),
        ),
      )
      .catch(() => null);
  }

  return out(
    v2(
      [
        container(
          [
            text(
              `-# ${LABEL[p.type].emoji}  SUBMITTED SUCCESSFULLY\n# ${LABEL[p.type].title} Locked In!\nTeam **${g.team.name}**`,
            ),
            sep(),
            text(
              kv([
                ["Submitted by:", submitter, "👤"],
                ["When:", ts(new Date(), "R"), "🕒"],
                [
                  isFile ? "File:" : "Link:",
                  isFile ? `${p.file.name}\n${link}` : link,
                  LABEL[p.type].emoji,
                ],
              ]),
            ),
            sep(),
            text(`-# ${FACILITATOR_NOTE}`),
            footer(),
          ],
          STYLE.ok,
        ),
      ],
      { ephemeral: true },
    ),
  );
};

/** "My Team's Status" button. */
export const onTeamStatus = async (interaction) => {
  const g = await gate(interaction);
  if (g.fail) return interaction.reply(g.fail);
  const subs = await Submission.find({
    guildId: interaction.guildId,
    teamId: g.team._id,
  });
  const get = (type) => subs.find((x) => x.type === type);
  const block = (type) => {
    const s = get(type);
    return s
      ? kv([
          ["Status:", `Submitted ${ts(s.createdAt, "R")}`, "✅"],
          ["By:", s.submittedByName ?? "A Teammate", "👤"],
          [
            s.fileName ? "File" : "Link",
            `${s.fileName ? `${s.fileName}\n` : ""}${s.url}`,
            LABEL[type].emoji,
          ],
        ])
      : kv([["Status:", "Not Submitted Yet", "⏳"]]);
  };
  const done = subs.length;
  const closed = isClosed(g.config);
  return interaction.reply(
    v2(
      [
        container(
          [
            text(
              `-# 📋  TEAM STATUS\n# ${g.team.name}\n${bar(done, 2, 6)}  **${done}/2** Submitted`,
            ),
            bigSep(),
            heading("🗂️", "Repository"),
            text(block("repository")),
            sep(),
            heading("🎞️", "Presentation"),
            text(block("presentation")),
            sep(),
            text(
              `${closed ? `🔒 Closed ${ts(g.config.deadline, "R")}` : `⏰ Deadline: ${ts(g.config.deadline)} (${ts(g.config.deadline, "R")})`}\n\n-# ${FACILITATOR_NOTE}`,
            ),
            footer(),
          ],
          done === 2 ? STYLE.ok : STYLE.color,
        ),
      ],
      { ephemeral: true },
    ),
  );
};
