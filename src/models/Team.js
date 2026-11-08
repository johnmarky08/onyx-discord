import mongoose from "mongoose";
import { EVENT } from "../config/event.js";

const memberSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    firstName: { type: String, required: true },
    lastName: { type: String, required: true },
    nickname: { type: String, default: null },
    verifiedAt: { type: Date, default: () => new Date() },
  },
  { _id: false },
);

// A registered person on the team. Filled by /team add; `userId` is set when they verify.
const rosterSchema = new mongoose.Schema(
  {
    lastName: { type: String, required: true },
    firstName: { type: String, required: true },
    key: { type: String, required: true }, // normalised name, used to match what they type
    userId: { type: String, default: null },
  },
  { _id: false },
);

// This is the "participants" model: one document per registered team.
// Teams are created by facilitators (/team add, /team import); members are added when they verify.
const teamSchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    // normalised name used for matching ("Team-X" == "team x")
    nameKey: { type: String, required: true },
    track: {
      type: String,
      enum: [...EVENT.tracks.map((t) => t.key), null],
      default: null,
    },

    // Discord resources that belong to the team
    boardMessageId: { type: String, default: null }, // this team's card on the facilitators' board
    roleId: { type: String, default: null },
    categoryId: { type: String, default: null },
    textChannelId: { type: String, default: null },
    voiceChannelId: { type: String, default: null },

    roster: { type: [rosterSchema], default: [] },
    members: { type: [memberSchema], default: [] },
  },
  { timestamps: true },
);

teamSchema.index({ guildId: 1, nameKey: 1 }, { unique: true });
teamSchema.index({ guildId: 1, "members.userId": 1 });

export const Team = mongoose.model("Team", teamSchema);
