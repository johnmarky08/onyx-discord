// Routes every incoming interaction to the right handler.
import { MessageFlags } from "discord.js";
import { error } from "../lib/logger.js";
import { logEvent } from "../lib/logs.js";
import { notice } from "../lib/ui.js";
import { onVerifyButton, onVerifyModal } from "./verify.js";
import {
  onSubmitButton,
  onSubmitCancel,
  onSubmitConfirm,
  onSubmitModal,
  onTeamStatus,
} from "./submit.js";
import { onSetupComponent } from "./setup.js";
import { IDS } from "../lib/panels.js";
import { onTeamRemoveButton } from "../commands/team.js";

export const handleInteraction = async (interaction, commands) => {
  try {
    if (!interaction.inGuild()) {
      if (interaction.isRepliable())
        await interaction.reply(
          notice(
            "info",
            "Server only",
            "Onyx works inside the hackathon server.",
          ),
        );
      return;
    }

    if (interaction.isChatInputCommand()) {
      const command = commands.get(interaction.commandName);
      return await command?.execute(interaction);
    }

    if (interaction.isAutocomplete()) {
      const command = commands.get(interaction.commandName);
      return await command?.autocomplete?.(interaction);
    }

    const id = interaction.customId ?? "";

    if (interaction.isModalSubmit()) {
      if (id === IDS.verifyModal) return await onVerifyModal(interaction);
      if (id.startsWith(IDS.submitModal))
        return await onSubmitModal(
          interaction,
          id.slice(IDS.submitModal.length),
        );
      return;
    }

    if (interaction.isButton() || interaction.isAnySelectMenu()) {
      if (id === IDS.verify) return await onVerifyButton(interaction);
      if (id === IDS.submitRepo)
        return await onSubmitButton(interaction, "repository");
      if (id === IDS.submitPpt)
        return await onSubmitButton(interaction, "presentation");
      if (id === IDS.teamStatus) return await onTeamStatus(interaction);
      if (id.startsWith(IDS.submitConfirm))
        return await onSubmitConfirm(
          interaction,
          id.slice(IDS.submitConfirm.length),
        );
      if (id.startsWith(IDS.submitCancel))
        return await onSubmitCancel(
          interaction,
          id.slice(IDS.submitCancel.length),
        );
      if (id.startsWith("onyx:setup:"))
        return await onSetupComponent(interaction, id.split(":")[2]);
      if (id.startsWith("onyx:team-remove:")) {
        const [, , action, teamId] = id.split(":");
        return await onTeamRemoveButton(interaction, action, teamId);
      }
    }
  } catch (e) {
    error(
      `Interaction ${interaction.customId ?? interaction.commandName ?? interaction.type} failed: ${e.message}`,
      e,
    );
    logEvent(interaction.guild, "error", {
      user: interaction.user,
      summary: `\`${interaction.customId ?? `/${interaction.commandName}`}\` by <@${interaction.user?.id}>`,
      note: String(e.message).slice(0, 500),
    });
    const payload = notice(
      "error",
      "Something went wrong",
      "That didn't work on my side. Please try again, or ask a facilitator if it keeps happening.",
    );
    try {
      if (!interaction.isRepliable()) return;
      if (interaction.deferred || interaction.replied)
        await interaction.editReply({
          ...payload,
          flags: MessageFlags.IsComponentsV2,
        });
      else await interaction.reply(payload);
    } catch {
      /* the interaction token may have expired */
    }
  }
};
