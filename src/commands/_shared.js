import { GuildConfig, Team } from "../models/index.js";
import { isStaff } from "../lib/perms.js";
import { normalizeKey } from "../lib/names.js";
import { publicNotice } from "../lib/ui.js";

/** Gate for facilitator-level commands. Returns the config, or replies with an error and returns null. */
export const requireStaff = async (interaction) => {
  const config = await GuildConfig.findOne({ guildId: interaction.guildId });
  if (!isStaff(interaction.member, config)) {
    await interaction.reply(
      publicNotice(
        "error",
        "Facilitators only",
        "This command is for facilitators and server admins.",
      ),
    );
    return null;
  }
  return config ?? new GuildConfig({ guildId: interaction.guildId });
};

export const findTeamByName = (guildId, input) =>
  Team.findOne({ guildId, nameKey: normalizeKey(input) });

/** Autocomplete for any option called `name` / `team` that expects a team. */
export const teamAutocomplete = async (interaction) => {
  const focused = interaction.options.getFocused();
  const key = normalizeKey(focused);
  const filter = {
    guildId: interaction.guildId,
    ...(key
      ? { nameKey: { $regex: key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") } }
      : {}),
  };
  const teams = await Team.find(filter)
    .sort({ name: 1 })
    .limit(25)
    .select("name");
  return interaction.respond(
    teams.map((t) => ({
      name: t.name.slice(0, 100),
      value: t.name.slice(0, 100),
    })),
  );
};
