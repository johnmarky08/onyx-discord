// Name handling: matching team names, cleaning person names, and building the nickname.

const NICK_MAX = 32;

/** "Team-Alpha!!" -> "team alpha" (used for matching, never shown). */
export const normalizeKey = (input = "") =>
  String(input)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Tidy a team name for display: collapse whitespace, strip things that break formatting. */
export const cleanTeamName = (input = "") =>
  String(input)
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/[\[\]<>@#`*_~|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);

const titleCase = (s) =>
  s
    .toLowerCase()
    .replace(/(^|[\s\-'’.])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());

/** Clean a first/last name. All-lower or ALL-UPPER input gets Title Case; mixed case is kept as typed. */
export const cleanPersonName = (input = "") => {
  let s = String(input)
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/[\[\],<>@#`*_~|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
  if (s && (s === s.toLowerCase() || s === s.toUpperCase())) s = titleCase(s);
  return s;
};

/**
 * "[ Team Name ] Last Name, First Name" — Discord caps nicknames at 32 characters,
 * so when it doesn't fit the longest part is trimmed (with …) until it does.
 */
export const buildNickname = (teamName, lastName, firstName) => {
  const full = `[ ${teamName} ] ${lastName}, ${firstName}`;
  if (full.length <= NICK_MAX) return { nickname: full, truncated: false };

  const parts = [teamName, lastName, firstName];
  const lens = parts.map((p) => p.length);
  const overhead = "[  ] ".length + ", ".length; // 5 + 2 = 7
  const MIN = 3;
  while (lens.reduce((a, b) => a + b, 0) + overhead > NICK_MAX) {
    let idx = -1;
    for (let i = 0; i < lens.length; i++)
      if (lens[i] > MIN && (idx === -1 || lens[i] > lens[idx])) idx = i;
    if (idx === -1) break;
    lens[idx] -= 1;
  }
  const cut = parts.map((p, i) =>
    lens[i] < p.length
      ? p.slice(0, Math.max(1, lens[i] - 1)).trimEnd() + "…"
      : p,
  );
  const nickname = `[ ${cut[0]} ] ${cut[1]}, ${cut[2]}`.slice(0, NICK_MAX);
  return { nickname, truncated: true };
};

const levenshtein = (a, b) => {
  if (a === b) return 0;
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(
        dp[j] + 1,
        dp[j - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prev = tmp;
    }
  }
  return dp[b.length];
};

/** "Did you mean…" candidates for a mistyped team name. */
export const suggestTeams = (inputKey, teams, limit = 3) => {
  if (!inputKey) return [];
  return teams
    .map((t) => {
      const d = levenshtein(inputKey, t.nameKey);
      const close = d <= Math.max(2, Math.floor(t.nameKey.length * 0.3));
      const contains =
        inputKey.length >= 3 &&
        (t.nameKey.includes(inputKey) || inputKey.includes(t.nameKey));
      return { t, score: contains ? Math.min(d, 1) : d, ok: close || contains };
    })
    .filter((x) => x.ok)
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map((x) => x.t);
};

/** Order-independent key for "Last, First" so "Juan Dela Cruz" and "Dela Cruz, Juan" match. */
export const personKey = (last, first) =>
  normalizeKey(`${last} ${first}`).split(" ").filter(Boolean).sort().join(" ");

/**
 * Parse "Dela Cruz, Juan; Santos, Maria" (or one per line) into [{lastName, firstName}].
 * Returns { people, errors }.
 */
export const parseRoster = (input = "") => {
  const people = [];
  const errors = [];
  for (const chunk of String(input)
    .split(/[;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)) {
    const [last, first, ...rest] = chunk
      .split(",")
      .map((s) => cleanPersonName(s));
    if (
      !last ||
      !first ||
      rest.length ||
      !/\p{L}/u.test(last) ||
      !/\p{L}/u.test(first)
    ) {
      errors.push(chunk);
      continue;
    }
    people.push({ lastName: last, firstName: first });
  }
  return { people, errors };
};
