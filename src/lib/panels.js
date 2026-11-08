// The two public messages the bot owns: the welcome/verify panel and the final-submission panel.
import { ButtonStyle } from "discord.js";
import { EVENT, trackLabel } from "../config/event.js";
import { GuildConfig, Submission, Team } from "../models/index.js";
import {
  assertWithinLimits,
  banner,
  bar,
  bigSep,
  button,
  container,
  heading,
  kv,
  row,
  sep,
  text,
  ts,
  v2,
} from "./ui.js";
import { STYLE } from "../config/style.js";
import { refreshBoardHeader } from "./board.js";
import { error } from "./logger.js";

export const IDS = {
  verify: "onyx:verify",
  verifyModal: "onyx:verify:modal",
  submitRepo: "onyx:submit:repository",
  submitPpt: "onyx:submit:presentation",
  submitModal: "onyx:submit:modal:", // + type
  submitConfirm: "onyx:submit:confirm:", // + token
  submitCancel: "onyx:submit:cancel:", // + token
  teamStatus: "onyx:submit:status",
};

export const welcomePanel = () => {
  const children = [];
  if (EVENT.bannerUrl) children.push(banner(EVENT.bannerUrl));
  children.push(
    text(
      `-# ${EVENT.organizers.replace(" x ", " × ")}  ·  ${EVENT.school}\n` +
        `# ✦ ${EVENT.name}\n` +
        `**${EVENT.theme}**\n` +
        `Four days. One idea. Build something that makes campus life better — you're in the right place.`,
    ),
    bigSep(),
    heading("🗓️", "Event timeline"),
    text(
      kv([
        ["Kickoff:", ts(EVENT.kickoff), "🚀"],
        ["Code Freeze & Submission Deadline:", ts(EVENT.deadline), "🧊"],
        ["Final Pitching & Awarding:", ts(EVENT.pitching), "🎤"],
      ]),
    ),
    bigSep(),
    heading("✅", "Get verified in 3 steps"),
    text(
      `\`1\`\u2002Press **Verify** below\n` +
        `\`2\`\u2002Enter your **team name** and your **name** exactly as your team registered it\n` +
        `\`3\`\u2002Receive your team nickname, roles and your team's private space`,
    ),
    text(
      `-# Teams have ${EVENT.teamSize.min}–${EVENT.teamSize.max} members  ·  **Can't verify? Ask a facilitator for help.**`,
    ),
    row(
      button({
        id: IDS.verify,
        label: "Verify Me",
        emoji: "✅",
        style: ButtonStyle.Success,
      }),
    ),
  );

  const payload = v2([
    container(children),
    container(
      [
        heading("🛡️", "Facilitators"),
        text(
          "**Need facilitator access?** Message <@651240959417516070> to get access.",
        ),
      ],
      STYLE.info,
    ),
  ]);
  assertWithinLimits(payload, "welcome panel");
  return payload;
};

export const submissionStats = async (guildId) => {
  const [teams, repos, ppts] = await Promise.all([
    Team.countDocuments({ guildId }),
    Submission.countDocuments({ guildId, type: "repository" }),
    Submission.countDocuments({ guildId, type: "presentation" }),
  ]);
  return { teams, repos, ppts };
};

export const isClosed = (config) =>
  new Date(config.deadline).getTime() <= Date.now();

export const submissionPanel = (
  config,
  stats = { teams: 0, repos: 0, ppts: 0 },
) => {
  const closed = isClosed(config);
  const deadline = ts(config.deadline);

  const payload = v2([
    container(
      [
        text(
          `-# ${closed ? "🔒  SUBMISSIONS CLOSED" : "📦  FINAL SUBMISSION"}\n` +
            `# ${closed ? "Submissions Are Closed" : "Submit Your Work"}\n` +
            (closed
              ? `The deadline passed ${ts(config.deadline, "R")} (${deadline}). Need help? Notify a facilitator.`
              : `⏰ **Deadline:**\u2002${deadline}\u2002(${ts(config.deadline, "R")})`),
        ),
        bigSep(),
        heading("🗂️", "1 · Repository"),
        text(
          `Your team's **GitHub link** — public.\n` +
            `The \`README.md\` must fully explain the project. IoT / hardware builds are documented there too.`,
        ),
        heading("🎞️", "2 · Presentation"),
        text(
          `A **PDF or PPTX** file (max ${EVENT.presentationFile.maxMB} MB) with ${EVENT.slides.min}–${EVENT.slides.max} slides:\n` +
            `Team · Problem Statement · Architecture / Tech Stack · Future Scalability`,
        ),
        bigSep(),
        heading("🛡️", "Before you submit"),
        text(
          `▸ Any team member can submit — the **first confirmed submission of each item locks for the whole team**.\n` +
            `▸ You'll preview and confirm before anything is saved.\n` +
            `▸ Mistake or problem? **Don't resubmit — notify the facilitators**.`,
        ),
        sep(),
        text(
          `${kv([
            [
              "Overall Repositories:",
              `\n${bar(stats.repos, stats.teams)}  **${stats.repos}/${stats.teams}** teams`,
              "🗂️",
            ],
            [
              "Overall Presentations:",
              `\n${bar(stats.ppts, stats.teams)}  **${stats.ppts}/${stats.teams}** teams`,
              "🎞️",
            ],
          ])}`,
        ),
        row(
          button({
            id: IDS.submitRepo,
            label: "Submit Repository",
            emoji: "🗂️",
            style: ButtonStyle.Primary,
            disabled: closed,
          }),
          button({
            id: IDS.submitPpt,
            label: "Submit Presentation",
            emoji: "🎞️",
            style: ButtonStyle.Primary,
            disabled: closed,
          }),
          button({
            id: IDS.teamStatus,
            label: "My Team's Status",
            emoji: "📋",
            style: ButtonStyle.Secondary,
          }),
        ),
      ],
      closed ? STYLE.rose : STYLE.color,
    ),
  ]);
  assertWithinLimits(payload, "submission panel");
  return payload;
};

/** Send the panel, or edit it in place if we already posted it. Returns the message id. */
export const publishPanel = async (
  guild,
  channelId,
  existingMessageId,
  payload,
  oldChannelId = null,
) => {
  const channel = await guild.channels.fetch(channelId);
  if (!channel?.isTextBased()) throw new Error("Channel is not a text channel");

  if (existingMessageId && (!oldChannelId || oldChannelId === channelId)) {
    const msg = await channel.messages
      .fetch(existingMessageId)
      .catch(() => null);
    if (msg) {
      await msg.edit({
        components: payload.components,
        flags: payload.flags,
        allowedMentions: payload.allowedMentions,
      });
      return msg.id;
    }
  } else if (existingMessageId && oldChannelId) {
    // channel changed: remove the stale panel (best effort)
    const oldChannel = await guild.channels
      .fetch(oldChannelId)
      .catch(() => null);
    const old = await oldChannel?.messages
      ?.fetch(existingMessageId)
      .catch(() => null);
    await old?.delete().catch(() => null);
  }
  const sent = await channel.send(payload);
  return sent.id;
};

const timers = new Map();
/** Re-render the submission panel (progress counters / closed state). Debounced per server. */
export const refreshSubmissionPanel = (
  client,
  guildId,
  { immediate = false } = {},
) => {
  const run = async () => {
    timers.delete(guildId);
    try {
      const config = await GuildConfig.findOne({ guildId });
      if (!config?.submissionChannelId || !config.submissionMessageId) return;
      const guild = client.guilds.cache.get(guildId);
      if (!guild) return;
      const stats = await submissionStats(guildId);
      const id = await publishPanel(
        guild,
        config.submissionChannelId,
        config.submissionMessageId,
        submissionPanel(config, stats),
      );
      if (id !== config.submissionMessageId) {
        config.submissionMessageId = id;
        await config.save();
      }
      await refreshBoardHeader(guild);
    } catch (e) {
      error(`Could not refresh submission panel for ${guildId}: ${e.message}`);
    }
  };
  if (immediate) return run();
  if (timers.has(guildId)) return;
  const t = setTimeout(run, 3000);
  t.unref?.();
  timers.set(guildId, t);
};

export { trackLabel };
