import {
  OverwriteType,
  PermissionFlagsBits as P,
  PermissionsBitField,
} from "discord.js";

const TEXT_MEMBER = [
  P.ViewChannel,
  P.SendMessages,
  P.SendMessagesInThreads,
  P.ReadMessageHistory,
  P.AttachFiles,
  P.EmbedLinks,
  P.AddReactions,
  P.UseExternalEmojis,
  P.CreatePublicThreads,
];
const VOICE_MEMBER = [
  P.ViewChannel,
  P.Connect,
  P.Speak,
  P.Stream,
  P.UseVAD,
  P.SendMessages,
  P.ReadMessageHistory,
  P.AttachFiles,
  P.EmbedLinks,
];
const FACILITATOR = [
  P.ViewChannel,
  P.SendMessages,
  P.ReadMessageHistory,
  P.ManageMessages,
  P.AttachFiles,
  P.EmbedLinks,
  P.Connect,
  P.Speak,
  P.Stream,
  P.UseVAD,
  P.MuteMembers,
  P.MoveMembers,
  P.CreatePublicThreads,
];
const BOT = [
  P.ViewChannel,
  P.ManageChannels,
  P.SendMessages,
  P.ReadMessageHistory,
  P.Connect,
  P.ManageRoles,
];

/** Is this member allowed to run facilitator-level commands? */
export const isStaff = (member, config) => {
  if (!member) return false;
  if (member.permissions?.has(P.Administrator)) return true;
  return Boolean(
    config?.facilitatorRoleId &&
    member.roles?.cache?.has(config.facilitatorRoleId),
  );
};

export const canConfigure = (member) =>
  Boolean(
    member?.permissions?.has(P.Administrator) ||
    member?.permissions?.has(P.ManageGuild),
  );

/**
 * Overwrites for a team's category and its channels:
 * @everyone hidden, the team role + facilitators + the bot can see it.
 * Other teams' roles are never mentioned, so they cannot see it either.
 */
export const teamOverwrites = ({
  guild,
  teamRoleId,
  facilitatorRoleId,
  kind = "category",
}) => {
  const member = kind === "voice" ? VOICE_MEMBER : TEXT_MEMBER;
  const list = [
    {
      id: guild.roles.everyone.id,
      type: OverwriteType.Role,
      deny: [P.ViewChannel, P.UseApplicationCommands, P.UseExternalApps],
    },
    { id: teamRoleId, type: OverwriteType.Role, allow: member },
    { id: guild.client.user.id, type: OverwriteType.Member, allow: BOT },
  ];
  if (facilitatorRoleId)
    list.push({
      id: facilitatorRoleId,
      type: OverwriteType.Role,
      allow: FACILITATOR,
    });
  return list;
};

export const BOT_REQUIRED = [
  ["ManageRoles", P.ManageRoles],
  ["ManageChannels", P.ManageChannels],
  ["ManageNicknames", P.ManageNicknames],
  ["ViewChannel", P.ViewChannel],
  ["SendMessages", P.SendMessages],
];

export const missingBotPerms = (guild) => {
  const me = guild.members.me;
  if (!me) return ["(bot member not cached)"];
  if (me.permissions.has(P.Administrator)) return [];
  return BOT_REQUIRED.filter(([, bit]) => !me.permissions.has(bit)).map(
    ([name]) => name,
  );
};

export { PermissionsBitField };
