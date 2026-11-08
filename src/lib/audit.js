// Optional log channel for facilitators (verifications + submissions).
import { container, sep, text, ts, v2 } from "./ui.js";
import { trackLabel } from "../config/event.js";
import { warn } from "./logger.js";
import { STYLE } from "../config/style.js";

/** Announce a confirmed submission in the facilitators-only channel (falls back to the log channel). */
export const announceSubmission = async (
  guild,
  config,
  { team, type, submitter, userId, link, fileName, stats },
) => {
  const channelId = config?.submissionLogChannelId || config?.logChannelId;
  if (!channelId) return;
  try {
    const ch = await guild.channels.fetch(channelId);
    const isFile = type === "presentation";
    const progress = stats
      ? `\n-# Progress — 🗂️ ${stats.repos}/${stats.teams} repositories · 🎞️ ${stats.ppts}/${stats.teams} presentations`
      : "";
    await ch.send(
      v2([
        container(
          [
            text(
              `### ${isFile ? "🎞️ Presentation Submitted" : "🗂️ Repository Submitted"} — ${team.name}`,
            ),
            sep(false),
            text(
              `**Team:** ${team.name}${team.track ? ` · ${trackLabel(team.track)}` : ""}\n` +
                `**Submitted by:** <@${userId}> (${submitter})\n` +
                `**When:** ${ts(new Date())}\n` +
                `**${isFile ? "File" : "Repository"}:** ${isFile ? `📎 ${fileName} — ` : ""}${link}${progress}`,
            ),
          ],
          STYLE.ok,
        ),
      ]),
    );
  } catch (e) {
    warn(`Submission announcement failed in ${guild.id}: ${e.message}`);
  }
};

export const audit = async (guild, config, title, body, color = STYLE.info) => {
  if (!config?.logChannelId) return;
  try {
    const ch = await guild.channels.fetch(config.logChannelId);
    await ch.send(
      v2([container([text(`**${title}**`), sep(false), text(body)], color)]),
    );
  } catch (e) {
    warn(`Audit log failed in ${guild.id}: ${e.message}`);
  }
};
