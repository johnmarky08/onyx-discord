// Tiny helpers that build raw Components V2 JSON (same style as the Kiro sample bot).
import {
  ButtonStyle,
  ChannelType,
  ComponentType as C,
  MessageFlags,
  SeparatorSpacingSize,
} from "discord.js";
import { STYLE } from "../config/style.js";

export const text = (content) => ({ type: C.TextDisplay, content });

export const sep = (divider = true, spacing = SeparatorSpacingSize.Small) => ({
  type: C.Separator,
  divider,
  spacing,
});

export const container = (components, color = STYLE.color) => ({
  type: C.Container,
  accent_color: color,
  components,
});

export const row = (...components) => ({ type: C.ActionRow, components });

export const button = ({
  id,
  label,
  style = ButtonStyle.Primary,
  emoji,
  disabled = false,
}) => ({
  type: C.Button,
  custom_id: id,
  label,
  style,
  ...(emoji
    ? { emoji: typeof emoji === "string" ? { name: emoji } : emoji }
    : {}),
  ...(disabled ? { disabled: true } : {}),
});

export const banner = (url) => ({
  type: C.MediaGallery,
  items: [{ media: { url } }],
});

export const roleSelect = ({ id, placeholder, value, min = 1 }) => ({
  type: C.RoleSelect,
  custom_id: id,
  placeholder,
  min_values: min,
  max_values: 1,
  ...(value ? { default_values: [{ id: value, type: "role" }] } : {}),
});

export const channelSelect = ({
  id,
  placeholder,
  value,
  min = 1,
  types = [ChannelType.GuildText],
}) => ({
  type: C.ChannelSelect,
  custom_id: id,
  placeholder,
  min_values: min,
  max_values: 1,
  channel_types: types,
  ...(value ? { default_values: [{ id: value, type: "channel" }] } : {}),
});

/** Build a message payload. Components V2 messages cannot carry `content`/`embeds`. */
export const v2 = (components, { ephemeral = false } = {}) => ({
  components,
  flags: ephemeral
    ? [MessageFlags.Ephemeral, MessageFlags.IsComponentsV2]
    : MessageFlags.IsComponentsV2,
  allowedMentions: { parse: [] },
});

// ---------- design primitives (one visual language for every message) ----------

export const bigSep = () => sep(true, SeparatorSpacingSize.Large);
export const gap = () => sep(false, SeparatorSpacingSize.Large);

/** Small grey line at the bottom of a card. */
export const footer = (extra) =>
  text(`-# ${STYLE.footer}${extra ? `  ·  ${extra}` : ""}`);

/** Big title with a small kicker above and an optional subtitle below. */
export const hero = ({ kicker, title, subtitle }) =>
  text(
    `${kicker ? `-# ${kicker}\n` : ""}# ${title}${subtitle ? `\n${subtitle}` : ""}`,
  );

/** Section heading inside a card. */
export const heading = (emoji, title) => text(`### ${emoji}\u2002${title}`);

/** "▸ **Label**  value" lines. Rows with an empty value are skipped. */
export const kv = (rows) =>
  rows
    .filter((r) => r && r[1] !== undefined && r[1] !== null && r[1] !== "")
    .map(
      ([label, value, icon]) =>
        `${icon ? `${icon} ` : "▸ "}**${label}**\u2002${value}`,
    )
    .join("\n");

/** Progress bar with 5-8 segments based on the real total. */
export const bar = (done, total) => {
  const len = Math.min(8, Math.max(5, total > 0 ? total : 5));
  const ratio = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
  const filled = Math.round(ratio * len);
  return (
    "▰".repeat(Math.min(len, filled)) + "▱".repeat(Math.max(0, len - filled))
  );
};

/** Text with a thumbnail (avatar/logo) on the right. Falls back to plain text when there is no image. */
export const withThumb = (content, url) =>
  url
    ? {
        type: C.Section,
        components: [text(content)],
        accessory: { type: C.Thumbnail, media: { url } },
      }
    : text(content);

/** Link button (opens a URL). */
export const linkButton = ({ url, label, emoji }) => ({
  type: C.Button,
  style: ButtonStyle.Link,
  url,
  label,
  ...(emoji ? { emoji: { name: emoji } } : {}),
});

/** Avatar URL that works for both User and GuildMember (null when unavailable). */
export const avatarOf = (who) => {
  const u = who?.user ?? who;
  try {
    return u?.displayAvatarURL?.({ extension: "png", size: 256 }) ?? null;
  } catch {
    return null;
  }
};

const TONES = {
  ok: { color: STYLE.ok, icon: "✅" },
  warn: { color: STYLE.warn, icon: "⚠️" },
  error: { color: STYLE.error, icon: "⛔" },
  info: { color: STYLE.info, icon: "💬" },
};

/** A tidy status card: tone-coloured accent, title, body and a quiet footer. */
export const notice = (tone, title, body, { ephemeral = true } = {}) => {
  const t = TONES[tone] ?? TONES.info;
  const parts = [text(`## ${t.icon}\u2002${title}`)];
  if (body) parts.push(sep(false), text(body));
  parts.push(footer());
  return v2([container(parts, t.color)], { ephemeral });
};

export const publicNotice = (tone, title, body) =>
  notice(tone, title, body, { ephemeral: false });

// --- Discord limits for Components V2 (checked in tests so panels never blow up in production) ---
export const V2_LIMITS = { totalComponents: 40, totalText: 4000 };

export const measure = (components) => {
  let count = 0;
  let chars = 0;
  const walk = (list) => {
    for (const c of list) {
      count += 1;
      if (c.type === C.TextDisplay) chars += c.content.length;
      if (c.components) walk(c.components);
      if (c.accessory) walk([c.accessory]);
    }
  };
  walk(components);
  return { count, chars };
};

export const assertWithinLimits = (payload, label = "message") => {
  const { count, chars } = measure(payload.components);
  if (count > V2_LIMITS.totalComponents)
    throw new Error(
      `${label}: ${count} components (max ${V2_LIMITS.totalComponents})`,
    );
  if (chars > V2_LIMITS.totalText)
    throw new Error(
      `${label}: ${chars} text chars (max ${V2_LIMITS.totalText})`,
    );
  return { count, chars };
};

/** Reply/edit helper that always does the right thing regardless of interaction state. */
export const respond = async (interaction, payload) => {
  if (interaction.deferred || interaction.replied) {
    // The ephemeral flag is fixed by the first response; edits only carry the V2 flag.
    return interaction.editReply({
      ...payload,
      flags: MessageFlags.IsComponentsV2,
    });
  }
  return interaction.reply(payload);
};

/** Modal with a single file-upload field (Components V2 for modals). */
export const fileModal = ({ id, title, intro, label, description }) => ({
  custom_id: id,
  title,
  components: [
    ...(intro ? [{ type: C.TextDisplay, content: intro }] : []),
    {
      type: C.Label,
      label,
      ...(description ? { description } : {}),
      component: {
        type: C.FileUpload,
        custom_id: "file",
        min_values: 1,
        max_values: 1,
        required: true,
      },
    },
  ],
});

/** Modal built from the new "Label + TextInput" layout (Components V2 for modals). */
export const textModal = ({ id, title, intro, fields }) => ({
  custom_id: id,
  title,
  components: [
    ...(intro ? [{ type: C.TextDisplay, content: intro }] : []),
    ...fields.map((f) => ({
      type: C.Label,
      label: f.label,
      ...(f.description ? { description: f.description } : {}),
      component: {
        type: C.TextInput,
        custom_id: f.id,
        style: f.paragraph ? 2 : 1,
        required: true,
        min_length: f.min ?? 1,
        max_length: f.max ?? 100,
        ...(f.placeholder ? { placeholder: f.placeholder } : {}),
        ...(f.value ? { value: String(f.value).slice(0, f.max ?? 100) } : {}),
      },
    })),
  ],
});

export const unix = (date) => Math.floor(new Date(date).getTime() / 1000);
export const ts = (date, style = "F") => `<t:${unix(date)}:${style}>`;

/** Update the message a component lives on (flags may only carry the V2 bit). */
export const update = (interaction, payload) =>
  interaction.update({ ...payload, flags: MessageFlags.IsComponentsV2 });
