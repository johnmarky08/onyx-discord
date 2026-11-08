import mongoose from "mongoose";
import { deadlineDate } from "../config/event.js";

const guildConfigSchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true, unique: true },

    // Roles
    participantRoleId: { type: String, default: null },
    facilitatorRoleId: { type: String, default: null },

    // Channels
    welcomeChannelId: { type: String, default: null },
    welcomeMessageId: { type: String, default: null },
    submissionChannelId: { type: String, default: null },
    submissionMessageId: { type: String, default: null },
    logChannelId: { type: String, default: null },
    // Facilitators-only channel that holds the live submissions board (header + one card per team).
    boardChannelId: { type: String, default: null },
    boardHeaderMessageId: { type: String, default: null },

    // Behaviour
    lockServer: { type: Boolean, default: true },
    maxTeamSize: { type: Number, default: 5, min: 3, max: 5 },
    deadline: { type: Date, default: () => deadlineDate() },
    panelClosed: { type: Boolean, default: false },

    configuredBy: { type: String, default: null },
  },
  { timestamps: true },
);

guildConfigSchema.methods.isComplete = function () {
  return Boolean(
    this.participantRoleId &&
    this.facilitatorRoleId &&
    this.welcomeChannelId &&
    this.submissionChannelId,
  );
};

export const GuildConfig = mongoose.model("GuildConfig", guildConfigSchema);
