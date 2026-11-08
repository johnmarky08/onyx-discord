// The facilitators' submissions board: one header + one live card per team.
// Cards update the moment a team submits, and carry the actual PDF/PPTX so judges can open it right there.
import { AttachmentBuilder, ComponentType as C } from "discord.js";
import { trackLabel } from "../config/event.js";
import { STYLE } from "../config/style.js";
import { GuildConfig, Submission, Team } from "../models/index.js";
import { withLock } from "./guards.js";
import { error } from "./logger.js";
import {
  bar,
  bigSep,
  container,
  footer,
  heading,
  kv,
  linkButton,
  row,
  sep,
  text,
  ts,
  v2,
} from "./ui.js";

const byType = (subs, type) => subs.find((s) => s.type === type);
const sizeText = (bytes) =>
  bytes ? `${(bytes / 1024 / 1024).toFixed(bytes > 1048576 ? 1 : 2)} MB` : "";

export const teamState = (subs) => {
  const done =
    Number(Boolean(byType(subs, "repository"))) +
    Number(Boolean(byType(subs, "presentation")));
  if (done === 2)
    return {
      done,
      icon: "🟢",
      label: "Complete — ready for judging",
      color: STYLE.ok,
    };
  if (done === 1)
    return { done, icon: "🟡", label: "1 of 2 submitted", color: STYLE.warn };
  return {
    done,
    icon: "⚪",
    label: "Waiting for submissions",
    color: STYLE.slate,
  };
};

/** One team's card. `hasFile` = the PDF/PPTX is attached to this very message. */
export const teamCardPayload = (team, subs, { hasFile = false } = {}) => {
  const repo = byType(subs, "repository");
  const ppt = byType(subs, "presentation");
  const st = teamState(subs);
  const roster = team.roster?.length
    ? team.roster
        .map((r) => `${r.userId ? "✅" : "⏳"} ${r.firstName} ${r.lastName}`)
        .join("  ·  ")
    : "*no roster*";

  const children = [
    text(
      `-# ${st.icon}  ${st.label}${team.track ? `  ·  ${trackLabel(team.track)}` : ""}\n## ${team.name}`,
    ),
    text(`👥  ${roster}`),
    bigSep(),
    heading("🗂️", "Repository"),
    text(
      repo
        ? `${kv([["Submitted", `${ts(repo.createdAt, "R")} by ${repo.submittedByName ?? "a teammate"}`, "✅"]])}\n${repo.url}`
        : "⏳ *Waiting for the team to submit their GitHub link…*",
    ),
    sep(),
    heading("🎞️", "Presentation"),
    text(
      ppt
        ? kv([
            [
              "Submitted",
              `${ts(ppt.createdAt, "R")} by ${ppt.submittedByName ?? "a teammate"}`,
              "✅",
            ],
            [
              "File",
              `${ppt.fileName ?? "presentation"}${ppt.fileSize ? ` · ${sizeText(ppt.fileSize)}` : ""}`,
              "📎",
            ],
          ])
        : "⏳ *Waiting for the team to upload their PDF / PPTX…*",
    ),
  ];
  if (ppt && hasFile)
    children.push({
      type: C.File,
      file: { url: `attachment://${ppt.fileName}` },
    });

  const buttons = [];
  if (repo)
    buttons.push(
      linkButton({ url: repo.url, label: "Open repository", emoji: "🔗" }),
    );
  if (ppt)
    buttons.push(
      linkButton({ url: ppt.url, label: "Open in team chat", emoji: "💬" }),
    );
  if (buttons.length) children.push(row(...buttons));
  children.push(footer(`updated ${ts(new Date(), "R")}`));

  return v2([container(children, st.color)]);
};

export const boardStats = async (guildId) => {
  const [teams, subs] = await Promise.all([
    Team.find({ guildId }).select("_id"),
    Submission.find({ guildId }).select("teamId type"),
  ]);
  const per = new Map();
  for (const s of subs)
    per.set(String(s.teamId), (per.get(String(s.teamId)) ?? 0) + 1);
  const total = teams.length;
  const complete = teams.filter((t) => per.get(String(t._id)) === 2).length;
  const started = teams.filter((t) => per.get(String(t._id)) === 1).length;
  return {
    total,
    repos: subs.filter((s) => s.type === "repository").length,
    ppts: subs.filter((s) => s.type === "presentation").length,
    complete,
    started,
    waiting: total - complete - started,
  };
};

export const boardHeaderPayload = (config, st) => {
  const closed = new Date(config.deadline).getTime() <= Date.now();
  return v2([
    container(
      [
        text(
          `-# 🔒  FACILITATORS ONLY\n# 📬  Submissions Board\nEvery team's work in one place — cards update live the moment a team submits.`,
        ),
        bigSep(),
        text(
          `${kv([
            [
              "Repositories",
              `${bar(st.repos, st.total)}  **${st.repos}/${st.total}**`,
              "🗂️",
            ],
            [
              "Presentations",
              `${bar(st.ppts, st.total)}  **${st.ppts}/${st.total}**`,
              "🎞️",
            ],
            [
              "Teams complete",
              `${bar(st.complete, st.total)}  **${st.complete}/${st.total}**`,
              "🏁",
            ],
          ])}`,
        ),
        sep(),
        text(
          `${closed ? "🔒 **Submissions closed**" : "⏰ **Deadline**"} ${ts(config.deadline)}${closed ? "" : `  (${ts(config.deadline, "R")})`}\n` +
            `🟢 complete: **${st.complete}** · 🟡 partial: **${st.started}** · ⚪ waiting: **${st.waiting}**`,
        ),
        footer(`updated ${ts(new Date(), "R")}`),
      ],
      closed ? STYLE.rose : STYLE.gold,
    ),
  ]);
};

const sendOpts = (payload, extra = {}) => ({
  components: payload.components,
  flags: payload.flags,
  allowedMentions: payload.allowedMentions,
  ...extra,
});

const fetchStoredFile = async (guild, sub) => {
  try {
    const ch = await guild.channels.fetch(sub.channelId);
    const msg = await ch.messages.fetch(sub.messageId);
    const att = msg.attachments.first();
    if (!att) return null;
    const res = await fetch(att.url);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
};

const upsertHeader = async (channel, config) => {
  const payload = boardHeaderPayload(config, await boardStats(config.guildId));
  const existing = config.boardHeaderMessageId
    ? await channel.messages
        .fetch(config.boardHeaderMessageId)
        .catch(() => null)
    : null;
  if (existing) return existing.edit(sendOpts(payload));
  const sent = await channel.send(payload);
  config.boardHeaderMessageId = sent.id;
  await config.save();
};

const upsertCard = async (guild, channel, team, file) => {
  const subs = await Submission.find({ guildId: guild.id, teamId: team._id });
  const ppt = byType(subs, "presentation");
  const existing = team.boardMessageId
    ? await channel.messages.fetch(team.boardMessageId).catch(() => null)
    : null;

  let files = [];
  let hasFile = false;
  if (ppt?.fileName) {
    if (existing?.attachments?.some((a) => a.name === ppt.fileName)) {
      hasFile = true; // already attached from an earlier update
    } else {
      const buf =
        file?.teamId === String(team._id)
          ? file.buffer
          : await fetchStoredFile(guild, ppt);
      if (buf) {
        files = [new AttachmentBuilder(buf, { name: ppt.fileName })];
        hasFile = true;
      }
    }
  }

  const payload = teamCardPayload(team, subs, { hasFile });
  if (existing) {
    // adding a new file (or dropping one after a reset) replaces whatever was attached before
    const extra = files.length
      ? { files, attachments: [] }
      : ppt
        ? {}
        : { attachments: [] };
    await existing.edit(sendOpts(payload, extra));
    return existing.id;
  }
  const sent = await channel.send(sendOpts(payload, { files }));
  await Team.updateOne(
    { _id: team._id },
    { $set: { boardMessageId: sent.id } },
  );
  team.boardMessageId = sent.id;
  return sent.id;
};

/**
 * Bring the board up to date. With `teamId` only that team's card (+ header) is touched;
 * without it every team gets a card (used by setup/sync). `file` = { teamId, buffer } avoids re-downloading.
 */
export const refreshBoard = (guild, { teamId = null, file = null } = {}) =>
  withLock(`board:${guild.id}`, async () => {
    try {
      const config = await GuildConfig.findOne({ guildId: guild.id });
      if (!config?.boardChannelId) return { cards: 0 };
      const channel = await guild.channels
        .fetch(config.boardChannelId)
        .catch(() => null);
      if (!channel) return { cards: 0 };

      await upsertHeader(channel, config);
      const teams = teamId
        ? [await Team.findById(teamId)].filter(Boolean)
        : await Team.find({ guildId: guild.id }).sort({ createdAt: 1 });
      let cards = 0;
      for (const team of teams) {
        await upsertCard(guild, channel, team, file);
        cards += 1;
      }
      return { cards };
    } catch (e) {
      error(`Board refresh failed in ${guild.id}: ${e.message}`, e);
      return { cards: 0, error: e.message };
    }
  });

/** Header only (counters / closed state) — cheap, used by the deadline watcher. */
export const refreshBoardHeader = (guild) =>
  withLock(`board:${guild.id}`, async () => {
    try {
      const config = await GuildConfig.findOne({ guildId: guild.id });
      if (!config?.boardChannelId) return;
      const channel = await guild.channels
        .fetch(config.boardChannelId)
        .catch(() => null);
      if (channel) await upsertHeader(channel, config);
    } catch (e) {
      error(`Board header refresh failed: ${e.message}`);
    }
  });

export const removeTeamCard = async (guild, team) => {
  try {
    const config = await GuildConfig.findOne({ guildId: guild.id });
    if (!config?.boardChannelId || !team.boardMessageId) return;
    const channel = await guild.channels
      .fetch(config.boardChannelId)
      .catch(() => null);
    const msg = await channel?.messages
      .fetch(team.boardMessageId)
      .catch(() => null);
    await msg?.delete().catch(() => null);
    await refreshBoardHeader(guild);
  } catch (e) {
    error(`Could not remove board card: ${e.message}`);
  }
};
