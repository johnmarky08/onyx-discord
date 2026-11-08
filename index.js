import "dotenv/config";
import mongoose from "mongoose";
import { startBot } from "./src/bot.js";
import { error, log } from "./src/lib/logger.js";

const { DISCORD_TOKEN, MONGODB_URI } = process.env;
if (!DISCORD_TOKEN || !MONGODB_URI) {
  console.error(
    "Missing DISCORD_TOKEN or MONGODB_URI. Copy .env.example to .env and fill them in.",
  );
  process.exit(1);
}

process.on("unhandledRejection", (e) =>
  error(`Unhandled rejection: ${e?.message ?? e}`, e),
);

(async () => {
  if (process.env.IS_LOCAL === "true") {
    // Remove this block when node fixed the dns issue.
    const dns = await import("dns");
    dns.setServers(["8.8.8.8", "1.1.1.1"]);
  }

  log("Connecting to MongoDB…");
  await mongoose.connect(MONGODB_URI);
  log("Connected to MongoDB.");
  // Make sure the unique indexes that enforce "one submission per team" and "unique team name" exist.
  await mongoose.connection.syncIndexes();
  try {
    await startBot(DISCORD_TOKEN);
  } catch (e) {
    if (/disallowed intents/i.test(e.message)) {
      error(
        "Discord refused the intents. In the Developer Portal → Bot → Privileged Gateway Intents, turn on SERVER MEMBERS INTENT (and MESSAGE CONTENT INTENT if ENABLE_MESSAGE_LOGS=true).",
      );
      process.exit(1);
    }
    throw e;
  }
})().catch((e) => {
  error(`Fatal: ${e.message}`, e);
  process.exit(1);
});
