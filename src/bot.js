import {
  ActivityType,
  Client,
  Collection,
  GatewayIntentBits,
} from "discord.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GuildConfig } from "./models/index.js";
import { handleInteraction } from "./interactions/index.js";
import { refreshSubmissionPanel } from "./lib/panels.js";
import { cmd, error, log, warn } from "./lib/logger.js";
import { registerEventLogs } from "./lib/events.js";
import { logEvent } from "./lib/logs.js";

const here = path.dirname(fileURLToPath(import.meta.url));

// Intents: Guilds + Server Members (privileged — joins/leaves/nicknames) + Moderation + Voice + Invites.
// Message logging is opt-in (ENABLE_MESSAGE_LOGS=true) because it needs the privileged Message Content intent.
const messageLogs = process.env.ENABLE_MESSAGE_LOGS === "true";
export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildInvites,
    ...(messageLogs
      ? [GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
      : []),
  ],
});
const commands = new Collection();

const loadCommands = async () => {
  const dir = path.join(here, "commands");
  for (const file of fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".js") && !f.startsWith("_"))) {
    const mod = await import(pathToFileURL(path.join(dir, file)).href);
    commands.set(mod.data.name, mod);
    cmd(`Loaded command: /${mod.data.name}`);
  }
};

/** Close the submission panel the moment the deadline passes. */
const watchDeadlines = () => {
  const tick = async () => {
    try {
      const due = await GuildConfig.find({
        panelClosed: false,
        deadline: { $lte: new Date() },
        submissionMessageId: { $ne: null },
      });
      for (const config of due) {
        await refreshSubmissionPanel(client, config.guildId, {
          immediate: true,
        });
        config.panelClosed = true;
        await config.save();
        log(`Submissions closed for guild ${config.guildId}`);
        const guild = client.guilds.cache.get(config.guildId);
        if (guild)
          logEvent(guild, "setup.closed", {
            id: guild.id,
            summary: "The deadline has passed — buttons are disabled.",
          });
      }
    } catch (e) {
      error(`Deadline watcher failed: ${e.message}`);
    }
  };
  tick();
  setInterval(tick, 30_000).unref?.();
};

client.once("clientReady", async (c) => {
  log(`Logged in as ${c.user.tag} — ${c.guilds.cache.size} server(s)`);
  c.user.setPresence({
    activities: [{ name: "Hack4Success 2026", type: ActivityType.Watching }],
    status: "online",
  });

  const body = [...commands.values()].map((m) => m.data.toJSON());
  const devGuild = process.env.DEV_GUILD_ID;
  if (devGuild) {
    const guild = await c.guilds.fetch(devGuild).catch(() => null);
    if (guild) {
      await guild.commands.set(body);
      cmd(`Registered ${body.length} commands to dev guild ${guild.name}`);
    } else
      warn(
        `DEV_GUILD_ID ${devGuild} not found — falling back to global commands`,
      );
    if (guild) return watchDeadlines();
  }
  await c.application.commands.set(body);
  cmd(`Registered ${body.length} global commands`);
  watchDeadlines();
});

client.on("interactionCreate", (interaction) =>
  handleInteraction(interaction, commands),
);
registerEventLogs(client, { messageLogs });
client.on("error", (e) => error(`Client error: ${e.message}`, e));

export const startBot = async (token) => {
  await loadCommands();
  await client.login(token);
};
