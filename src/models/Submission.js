import mongoose from "mongoose";

export const SUBMISSION_TYPES = ["repository", "presentation"];

const submissionSchema = new mongoose.Schema(
  {
    guildId: { type: String, required: true },
    teamId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Team",
      required: true,
    },
    teamName: { type: String, required: true },
    type: { type: String, enum: SUBMISSION_TYPES, required: true },
    // repository: the GitHub link. presentation: a permanent Discord jump link to the stored file.
    url: { type: String, required: true, maxlength: 500 },
    fileName: { type: String, default: null },
    fileSize: { type: Number, default: null },
    channelId: { type: String, default: null },
    messageId: { type: String, default: null },
    submittedBy: { type: String, required: true }, // Discord user id
    submittedByName: { type: String, default: null }, // "Last, First" as verified
  },
  { timestamps: true },
);

// The unique index is what guarantees "first submission wins, nobody else can submit".
// Two members pressing Confirm at the same instant: exactly one insert succeeds.
submissionSchema.index({ guildId: 1, teamId: 1, type: 1 }, { unique: true });

export const Submission = mongoose.model("Submission", submissionSchema);
