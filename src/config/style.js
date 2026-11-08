// Look & feel. Naming formats requested for the team spaces live here so they are easy to tweak.

export const STYLE = {
  // Container accent colours
  color: 0x9b8cff, // Onyx violet
  ok: 0x4ade80,
  warn: 0xfbbf24,
  error: 0xf87171,
  info: 0x9b8cff,
  gold: 0xf5c542,
  cyan: 0x5eead4,
  rose: 0xfb7185,
  slate: 0x64748b,
  blue: 0x60a5fa,

  footer: "✦ Onyx · Hack4Success 2026",

  // Category: ⊂⊃  ﹕  team name  !  ୧
  category: (teamName) => {
    const prefix = "⊂⊃  ﹕  "; // figure spaces: Discord collapses normal double spaces
    const suffix = "  !  ୧";
    const room = 100 - prefix.length - suffix.length;
    let name = teamName.toLowerCase();
    if (name.length > room) name = name.slice(0, room - 1) + "…";
    return `${prefix}${name}${suffix}`;
  },

  // Channels: ．📢．𓂃．channel-name
  textChannel: "．💬．𓂃．team-chat",
  voiceChannel: "．🔊．𓂃．team-collab",

  roleColors: [
    0x9b8cff, 0x5865f2, 0x1abc9c, 0xe67e22, 0xe91e63, 0x3498db, 0xf1c40f,
    0x2ecc71, 0xe74c3c, 0x9b59b6, 0x00bcd4, 0xff7043,
  ],
};
