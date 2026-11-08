// /onyx setup — an interactive wizard (role/channel pickers) instead of a wall of slash options.
import { ButtonStyle, MessageFlags } from "discord.js";
import { STYLE } from "../config/style.js";
import { GuildConfig } from "../models/index.js";
import { deployGuild, validateConfig } from "../lib/deploy.js";
import { TtlMap } from "../lib/guards.js";
import { error } from "../lib/logger.js";
import { canConfigure } from "../lib/perms.js";
import {
  assertWithinLimits,
  bigSep,
  button,
  channelSelect,
  container,
  footer,
  heading,
  notice,
  roleSelect,
  row,
  sep,
  text,
  update,
  v2,
} from "../lib/ui.js";
import { invalidateLogConfig, logEvent } from "../lib/logs.js";

const drafts = new TtlMap(30 * 60 * 1000);
const key = (i) => `${i.guildId}:${i.user.id}`;

export const SETUP_IDS = {
  participant: "onyx:setup:participant",
  facilitator: "onyx:setup:facilitator",
  welcome: "onyx:setup:welcome",
  submission: "onyx:setup:submission",
  log: "onyx:setup:log",
  board: "onyx:setup:board",
  lock: "onyx:setup:lock",
  deploy: "onyx:setup:deploy",
  cancel: "onyx:setup:cancel",
};

const FIELD = {
  participant: "participantRoleId",
  facilitator: "facilitatorRoleId",
  welcome: "welcomeChannelId",
  submission: "submissionChannelId",
  log: "logChannelId",
  board: "boardChannelId",
};

const tick = (v) => (v ? "✅" : "⬜");

export const wizardPayload = (d, problems = []) => {
  const ready = Boolean(
    d.participantRoleId &&
    d.facilitatorRoleId &&
    d.welcomeChannelId &&
    d.submissionChannelId &&
    d.boardChannelId,
  );
  const children = [
    text(
      `-# ⚙️  ONYX SETUP\n# Let's get Onyx ready\n` +
        `Pick the roles and channels below, then press **Deploy**. I'll lock the server until verification, post the welcome and submission panels, ` +
        `build the facilitators' board, and create a private space for every registered team.`,
    ),
  ];
  if (problems.length) {
    children.push(
      sep(),
      text(
        `### ⚠️ Fix these first\n${problems.map((p) => `- ${p}`).join("\n")}`.slice(
          0,
          1500,
        ),
      ),
    );
  }
  children.push(
    bigSep(),
    text(
      `${tick(d.participantRoleId)} **Participant role** — given to every verified participant`,
    ),
    row(
      roleSelect({
        id: SETUP_IDS.participant,
        placeholder: "Select the participant role",
        value: d.participantRoleId,
      }),
    ),
    text(
      `${tick(d.facilitatorRoleId)} **Facilitator role** — sees every team space, can run my staff commands`,
    ),
    row(
      roleSelect({
        id: SETUP_IDS.facilitator,
        placeholder: "Select the facilitator role",
        value: d.facilitatorRoleId,
      }),
    ),
    text(
      `${tick(d.welcomeChannelId)} **Welcome channel** — welcome message + Verify button`,
    ),
    row(
      channelSelect({
        id: SETUP_IDS.welcome,
        placeholder: "Select the welcome channel",
        value: d.welcomeChannelId,
      }),
    ),
    text(
      `${tick(d.submissionChannelId)} **Submission channel** — repository + presentation submission`,
    ),
    row(
      channelSelect({
        id: SETUP_IDS.submission,
        placeholder: "Select the submission channel",
        value: d.submissionChannelId,
      }),
    ),
    text(
      `${tick(d.boardChannelId)} **Submissions board channel** — one live card per team with their GitHub link + PDF/PPTX for judging; I will make it **facilitators-only**`,
    ),
    row(
      channelSelect({
        id: SETUP_IDS.board,
        placeholder: "Select the facilitators-only submissions board channel",
        value: d.boardChannelId,
      }),
    ),
    text(
      `🧾 **Server log channel** *(recommended)* — every server event is logged here; I will make it **facilitators-only**`,
    ),
    row(
      channelSelect({
        id: SETUP_IDS.log,
        placeholder: "Select the server log channel (optional)",
        value: d.logChannelId,
        min: 0,
      }),
    ),
    sep(),
    text(
      `🔒 **Lock server until verified: ${d.lockServer ? "ON" : "OFF"}**\n` +
        `-# ON removes *View Channel* from @everyone, so new members only see the welcome channel; the participant and facilitator roles get it back.`,
    ),
    row(
      button({
        id: SETUP_IDS.lock,
        label: d.lockServer ? "Lock: ON" : "Lock: OFF",
        emoji: "🔒",
        style: d.lockServer ? ButtonStyle.Success : ButtonStyle.Secondary,
      }),
      button({
        id: SETUP_IDS.deploy,
        label: "Deploy",
        emoji: "🚀",
        style: ButtonStyle.Primary,
        disabled: !ready,
      }),
      button({
        id: SETUP_IDS.cancel,
        label: "Cancel",
        style: ButtonStyle.Secondary,
      }),
    ),
  );
  const payload = v2([container(children)], { ephemeral: false });
  assertWithinLimits(payload, "setup wizard");
  return payload;
};

export const startSetup = async (interaction) => {
  if (!canConfigure(interaction.member)) {
    return interaction.reply(
      notice(
        "error",
        "Admins only",
        "You need the **Manage Server** permission to run setup.",
        { ephemeral: false },
      ),
    );
  }
  const existing = await GuildConfig.findOne({ guildId: interaction.guildId });
  const draft = {
    participantRoleId: existing?.participantRoleId ?? null,
    facilitatorRoleId: existing?.facilitatorRoleId ?? null,
    welcomeChannelId: existing?.welcomeChannelId ?? null,
    submissionChannelId: existing?.submissionChannelId ?? null,
    logChannelId: existing?.logChannelId ?? null,
    boardChannelId: existing?.boardChannelId ?? null,
    lockServer: existing?.lockServer ?? true,
  };
  drafts.set(key(interaction), draft);
  return interaction.reply(wizardPayload(draft));
};

const expired = (interaction) =>
  update(
    interaction,
    notice("warn", "Setup session expired", "Run `/onyx setup` again.", {
      ephemeral: false,
    }),
  );

export const onSetupComponent = async (interaction, action) => {
  if (!canConfigure(interaction.member)) {
    return interaction.reply(
      notice(
        "error",
        "Admins only",
        "You need the **Manage Server** permission to use setup.",
      ),
    );
  }
  const draft = drafts.get(key(interaction));
  if (!draft) return expired(interaction);

  if (action === "cancel") {
    drafts.delete(key(interaction));
    return update(
      interaction,
      notice("info", "Setup cancelled", "Nothing was changed.", {
        ephemeral: false,
      }),
    );
  }
  if (action === "lock") {
    draft.lockServer = !draft.lockServer;
    return update(interaction, wizardPayload(draft));
  }
  if (FIELD[action]) {
    draft[FIELD[action]] = interaction.values?.[0] ?? null;
    return update(interaction, wizardPayload(draft));
  }
  if (action === "deploy") return runDeploy(interaction, draft);
};

const runDeploy = async (interaction, draft) => {
  await interaction.deferUpdate();
  const { guild } = interaction;

  const problems = await validateConfig(guild, draft);
  if (problems.length)
    return interaction.editReply({
      ...wizardPayload(draft, problems),
      flags: MessageFlags.IsComponentsV2,
    });

  await interaction.editReply({
    ...notice(
      "info",
      "Deploying…",
      "Locking permissions, posting panels and building team spaces. This can take a minute.",
      { ephemeral: false },
    ),
    flags: MessageFlags.IsComponentsV2,
  });

  try {
    const config =
      (await GuildConfig.findOne({ guildId: guild.id })) ??
      new GuildConfig({ guildId: guild.id });

    // If a panel's channel changed, remove the old panel (best effort) and let deploy post a fresh one.
    for (const [chField, msgField] of [
      ["welcomeChannelId", "welcomeMessageId"],
      ["submissionChannelId", "submissionMessageId"],
    ]) {
      if (
        config[chField] &&
        config[chField] !== draft[chField] &&
        config[msgField]
      ) {
        const old = await guild.channels
          .fetch(config[chField])
          .catch(() => null);
        const msg = await old?.messages
          ?.fetch(config[msgField])
          .catch(() => null);
        await msg?.delete().catch(() => null);
        config[msgField] = null;
      }
    }

    Object.assign(config, {
      ...draft,
      configuredBy: interaction.user.id,
      panelClosed: false,
    });
    await config.save();

    const { lines, warnings } = await deployGuild(guild, config);
    drafts.delete(key(interaction));

    invalidateLogConfig(guild.id);
    logEvent(guild, "setup.deploy", {
      user: interaction.member,
      summary: `Deployed by <@${interaction.user.id}>`,
      fields: [
        ["Participant role", `<@&${config.participantRoleId}>`],
        ["Facilitator role", `<@&${config.facilitatorRoleId}>`],
        ["Welcome", `<#${config.welcomeChannelId}>`],
        ["Submissions", `<#${config.submissionChannelId}>`],
        ["Board", `<#${config.boardChannelId}>`],
        ["Lock until verified", config.lockServer ? "ON" : "OFF"],
      ],
      note: warnings.length ? warnings.join("\n").slice(0, 600) : undefined,
    });

    const body = [...lines, ...warnings].join("\n").slice(0, 2400);
    const next =
      `\`1\`\u2002Register teams with \`/team add\` or \`/team import\`\n` +
      `\`2\`\u2002Move **my role above** the participant and team roles (Server Settings → Roles)\n` +
      `\`3\`\u2002Check everything with \`/onyx status\``;

    return interaction.editReply({
      ...v2(
        [
          container(
            [
              text(
                `-# 🚀  DEPLOYED\n# Onyx is ${warnings.length ? "mostly " : ""}ready`,
              ),
              sep(),
              text(body),
              bigSep(),
              heading("🧭", "Next steps"),
              text(next),
              footer(),
            ],
            warnings.length ? STYLE.warn : STYLE.ok,
          ),
        ],
        { ephemeral: false },
      ),
      flags: MessageFlags.IsComponentsV2,
    });
  } catch (e) {
    error(`Setup deploy failed: ${e.message}`, e);
    return interaction.editReply({
      ...notice(
        "error",
        "Setup failed",
        `${e.message}\n\nNothing is broken — fix the issue and run \`/onyx setup\` again.`,
        { ephemeral: false },
      ),
      flags: MessageFlags.IsComponentsV2,
    });
  }
};
