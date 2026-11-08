// Everything event-specific lives here (taken from the Hack4Success 2026 rules PDF).
// Change this file, not the logic, if details change.

export const EVENT = {
  name: "Hack4Success 2026",
  organizers: "COESC x OCTA",
  theme: "Student Around Services",
  school: "LSPU - SPCC",
  teamSize: { min: 3, max: 5 },

  // All times are Philippine time (UTC+8).
  kickoff: "2026-11-09T19:00:00+08:00",
  pitching: "2026-11-12T13:00:00+08:00",
  deadline: process.env.EVENT_DEADLINE || "2026-11-12T12:00:00+08:00",

  bannerUrl: process.env.EVENT_BANNER_URL || null,

  tracks: [
    {
      key: "qol",
      emoji: "🌱",
      label: "Quality of Life",
      blurb:
        "Student well-being, financial management and community engagement.",
    },
    {
      key: "edtech",
      emoji: "📚",
      label: "EdTech / Academic Accessibility",
      blurb: "Democratize learning resources and ease the academic workload.",
    },
    {
      key: "admin",
      emoji: "📊",
      label: "Data-Driven Administration",
      blurb: "ML and analytics that unclog campus administrative workflows.",
    },
    {
      key: "smart",
      emoji: "🏫",
      label: "Smart Campus & Physical Infrastructure",
      blurb: "IoT and hardware that solve physical logistics on campus.",
    },
  ],

  // Submission rules
  slides: { min: 5, max: 10 },
  // Presentation is uploaded as a file: PDF or PPTX only.
  presentationFile: { extensions: ["pdf", "pptx"], maxMB: 25 },
};

export const trackLabel = (key) => {
  const t = EVENT.tracks.find((x) => x.key === key);
  return t ? `${t.emoji} ${t.label}` : null;
};

export const deadlineDate = () => new Date(EVENT.deadline);
