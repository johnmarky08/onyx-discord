// End-to-end flow tests with an in-memory stand-in for MongoDB and fake Discord objects.
// (No real Discord/Mongo needed: we verify the bot's decisions, ordering and side effects.)
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  ChannelType,
  ComponentType as C,
  ContainerBuilder,
  MessageFlags,
  OverwriteType,
  PermissionFlagsBits as P,
} from "discord.js";
import { GuildConfig, Submission, Team } from "../src/models/index.js";
import { onVerifyModal } from "../src/interactions/verify.js";
import { onSubmitConfirm, onSubmitModal } from "../src/interactions/submit.js";
import { ensureTeamResources } from "../src/lib/teams.js";
import { normalizeKey, personKey } from "../src/lib/names.js";
import { resetRateLimits } from "../src/lib/guards.js";

// ---------- tiny Mongo-ish matcher ----------
const values = (doc, path) => {
  let vals = [doc];
  for (const part of path.split(".")) {
    vals = vals.flatMap((v) =>
      v == null
        ? []
        : Array.isArray(v)
          ? /^\d+$/.test(part)
            ? [v[part]]
            : v.map((x) => x?.[part])
          : [v[part]],
    );
  }
  return vals;
};
const match = (doc, q) =>
  Object.entries(q).every(([k, cond]) => {
    const vals = values(doc, k);
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      if ("$ne" in cond)
        return !vals.some((v) => String(v) === String(cond.$ne));
      if ("$elemMatch" in cond)
        return vals
          .flat()
          .some((el) =>
            Object.entries(cond.$elemMatch).every(
              ([k, v]) => (el?.[k] ?? null) === v,
            ),
          );
      if ("$exists" in cond)
        return cond.$exists
          ? vals.some((v) => v !== undefined)
          : vals.every((v) => v === undefined);
    }
    return vals.some((v) => String(v) === String(cond));
  });

let teams, subs, nextId;
const cfg = {
  save: async () => cfg,
  boardHeaderMessageId: null,
  guildId: "G",
  boardChannelId: "ANN",
  participantRoleId: "PART",
  facilitatorRoleId: "FAC",
  welcomeChannelId: "W",
  submissionChannelId: "S",
  logChannelId: null,
  maxTeamSize: 5,
  deadline: new Date(Date.now() + 3600_000),
  isComplete: () => true,
};

const withSave = (d) => (d ? Object.assign(d, { save: async () => d }) : null);
const chain = (arr) =>
  Object.assign(arr, { select: () => arr, sort: () => arr, limit: () => arr });

const install = () => {
  GuildConfig.findOne = async () => cfg;
  Team.findOne = async (q) => withSave(teams.find((t) => match(t, q)) ?? null);
  Team.findById = async (id) =>
    withSave(teams.find((t) => t._id === id) ?? null);
  Team.find = (q) => chain(teams.filter((t) => match(t, q)));
  Team.countDocuments = async () => 0;
  Team.findOneAndUpdate = async (q, upd) => {
    const t = teams.find((x) => match(x, q));
    if (!t) return null;
    if (upd.$set?.["roster.$.userId"]) {
      const em = q.roster.$elemMatch;
      t.roster.find((r) => r.key === em.key && r.userId === null).userId =
        upd.$set["roster.$.userId"];
    }
    if (upd.$push) t.members.push(upd.$push.members);
    return withSave(t);
  };
  Team.updateOne = async (q, upd) => {
    const t = teams.find((x) => x._id === q._id);
    if (!t) return;
    if (upd.$set?.["roster.$.userId"] === null)
      t.roster
        .filter((r) => r.userId === q["roster.userId"])
        .forEach((r) => (r.userId = null));
    if (upd.$pull)
      t.members = t.members.filter(
        (m) => m.userId !== upd.$pull.members.userId,
      );
    if (upd.$set) {
      const m = t.members.find((x) => x.userId === q["members.userId"]);
      if (m) m.nickname = upd.$set["members.$.nickname"];
    }
  };
  Submission.findOne = async (q) => subs.find((s) => match(s, q)) ?? null;
  Submission.find = (q) => chain(subs.filter((s) => match(s, q)));
  Submission.countDocuments = async (q) =>
    subs.filter((s) => match(s, q)).length;
  Submission.create = async (doc) => {
    if (
      subs.some(
        (s) =>
          s.guildId === doc.guildId &&
          String(s.teamId) === String(doc.teamId) &&
          s.type === doc.type,
      )
    ) {
      throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
    }
    await new Promise((r) => setTimeout(r, 5)); // widen the race window
    if (
      subs.some(
        (s) => String(s.teamId) === String(doc.teamId) && s.type === doc.type,
      )
    )
      throw Object.assign(new Error("dup"), { code: 11000 });
    const row = { ...doc, createdAt: new Date() };
    subs.push(row);
    return row;
  };
};

const mkTeam = (name, verified = [], extra = []) => ({
  _id: `T${nextId++}`,
  guildId: "G",
  name,
  nameKey: normalizeKey(name),
  track: "qol",
  roleId: `R-${name}`,
  categoryId: `C-${name}`,
  textChannelId: `TX-${name}`,
  voiceChannelId: `V-${name}`,
  roster: [
    ...verified.map((id, i) => ({
      lastName: `L${i}`,
      firstName: `F${i}`,
      key: personKey(`L${i}`, `F${i}`),
      userId: id,
    })),
    ...extra.map(([lastName, firstName]) => ({
      lastName,
      firstName,
      key: personKey(lastName, firstName),
      userId: null,
    })),
  ],
  members: verified.map((id, i) => ({
    userId: id,
    lastName: `L${i}`,
    firstName: `F${i}`,
    nickname: null,
  })),
});

// ---------- fake Discord ----------
const mkGuild = (teamList = []) => {
  const roleIds = new Set(["PART", "FAC", ...teamList.map((t) => t.roleId)]);
  const chIds = new Set([
    "ANN",
    ...teamList.flatMap((t) => [
      t.categoryId,
      t.textChannelId,
      t.voiceChannelId,
    ]),
  ]);
  const sent = [];
  const members = new Map();
  return {
    id: "G",
    sent,
    members,
    client: { user: { id: "BOT" } },
    roles: { everyone: { id: "G" }, cache: { has: (id) => roleIds.has(id) } },
    deleted: [],
    channels: {
      cache: { has: (id) => chIds.has(id) },
      fetch: async (id) =>
        chIds.has(id)
          ? {
              id,
              messages: { fetch: async () => null },
              send: async (m) => {
                sent.push([id, m]);
                const n = sent.length;
                return {
                  id: `M${n}`,
                  channelId: id,
                  url: `https://discord.com/channels/G/${id}/M${n}`,
                  delete: async () => {
                    sent.deleted ??= [];
                    sent.deleted.push(`M${n}`);
                  },
                };
              },
            }
          : null,
    },
  };
};
const mkMember = (guild, id, { failRoles = false, failNick = false } = {}) => {
  const m = {
    id,
    roles: {
      added: [],
      cache: { has: () => false },
      add: async (ids) => {
        if (failRoles) throw new Error("Missing Permissions");
        m.roles.added.push(...ids);
      },
    },
    nickname: null,
    setNickname: async (n) => {
      if (failNick) throw new Error("Missing Permissions");
      m.nickname = n;
    },
  };
  guild.members.set(id, m);
  return m;
};
const mkInteraction = (guild, userId, fields = {}, extra = {}) => {
  const i = {
    guildId: "G",
    guild,
    client: { guilds: { cache: new Map() } },
    user: { id: userId, username: `user${userId}` },
    fields: {
      getTextInputValue: (k) => fields[k],
      getUploadedFiles: () => ({ first: () => fields.file }),
    },
    deferred: false,
    replied: false,
    last: null,
    deferReply: async () => {
      i.deferred = true;
    },
    editReply: async (p) => {
      i.last = p;
    },
    reply: async (p) => {
      i.replied = true;
      i.last = p;
    },
    update: async (p) => {
      i.last = p;
    },
    deferUpdate: async () => {
      i.deferred = true;
    },
    ...extra,
  };
  guild.members.fetch = async (id) => {
    const m = guild.members.get(id);
    if (!m) throw new Error("Unknown Member");
    return m;
  };
  return i;
};
const textOf = (payload) => JSON.stringify(payload.components);
const assertValidV2 = (p) => {
  assert.ok(p.flags & MessageFlags.IsComponentsV2);
  for (const c of p.components) new ContainerBuilder(c).toJSON();
};

beforeEach(() => {
  resetRateLimits();
  teams = [];
  subs = [];
  nextId = 1;
  cfg.deadline = new Date(Date.now() + 3600_000);
  install();
});

// =============================== VERIFICATION ===============================
test("verify: happy path renames, roles, welcome (name matched against the roster, any order)", async () => {
  const t = mkTeam(
    "Byte Busters",
    ["other1", "other2"],
    [["Dela Cruz", "Juan"]],
  );
  teams.push(t);
  const g = mkGuild(teams);
  const m = mkMember(g, "u1");
  const i = mkInteraction(g, "u1", {
    team: "byte-busters",
    last: "dela cruz",
    first: "juan",
  });
  await onVerifyModal(i);
  assert.deepEqual(m.roles.added, ["PART", "R-Byte Busters"]);
  assert.equal(m.nickname, "[ Byte Busters ] Dela Cruz, Juan");
  assert.equal(t.members.length, 3);
  assert.equal(t.roster[2].userId, "u1");
  assertValidV2(i.last);
  assert.match(textOf(i.last), /Welcome, Juan!/);
  assert.match(textOf(i.last), /TX-Byte Busters/);
});

test("verify: unknown team -> error with suggestion, nothing changes", async () => {
  teams.push(mkTeam("Byte Busters", [], [["Cruz", "Juan"]]));
  const g = mkGuild(teams);
  const m = mkMember(g, "u1");
  const i = mkInteraction(g, "u1", {
    team: "Byte Bsters",
    last: "Cruz",
    first: "Juan",
  });
  await onVerifyModal(i);
  assert.match(textOf(i.last), /Team not found/);
  assert.match(textOf(i.last), /Did you mean: \*\*Byte Busters\*\*/);
  assert.equal(m.roles.added.length, 0);
});

test("verify: a name that is not on the team's roster is refused (no impersonation)", async () => {
  const t = mkTeam("Byte Busters", [], [["Cruz", "Juan"]]);
  teams.push(t);
  const g = mkGuild(teams);
  const m = mkMember(g, "u1");
  const i = mkInteraction(g, "u1", {
    team: "Byte Busters",
    last: "Santos",
    first: "Maria",
  });
  await onVerifyModal(i);
  assert.match(textOf(i.last), /Name not found on this team/);
  assert.equal(m.roles.added.length, 0);
  assert.equal(t.members.length, 0);
});

test("verify: a name already claimed by another account is refused", async () => {
  const t = mkTeam("Byte Busters", [], [["Cruz", "Juan"]]);
  t.roster[0].userId = "someoneElse";
  teams.push(t);
  const g = mkGuild(teams);
  const m = mkMember(g, "u1");
  const i = mkInteraction(g, "u1", {
    team: "Byte Busters",
    last: "Cruz",
    first: "Juan",
  });
  await onVerifyModal(i);
  assert.match(textOf(i.last), /already claimed/);
  assert.equal(m.roles.added.length, 0);
});

test("verify: someone already verified with a different team is refused", async () => {
  teams.push(mkTeam("Alpha", ["u1"]), mkTeam("Beta", [], [["Cruz", "Juan"]]));
  const g = mkGuild(teams);
  mkMember(g, "u1");
  const i = mkInteraction(g, "u1", {
    team: "Beta",
    last: "Cruz",
    first: "Juan",
  });
  await onVerifyModal(i);
  assert.match(textOf(i.last), /Already verified with another team/);
  assert.equal(teams[1].members.length, 0);
});

test("verify: role failure rolls the roster claim back", async () => {
  teams.push(mkTeam("Byte Busters", [], [["Cruz", "Juan"]]));
  const g = mkGuild(teams);
  mkMember(g, "u1", { failRoles: true });
  const i = mkInteraction(g, "u1", {
    team: "Byte Busters",
    last: "Cruz",
    first: "Juan",
  });
  await onVerifyModal(i);
  assert.match(textOf(i.last), /couldn't finish verifying/);
  assert.equal(teams[0].members.length, 0);
  assert.equal(
    teams[0].roster[0].userId,
    null,
    "name released so they can retry",
  );
});

test("verify: nickname failure is non-fatal and explained", async () => {
  teams.push(mkTeam("Byte Busters", [], [["Cruz", "Juan"]]));
  const g = mkGuild(teams);
  const m = mkMember(g, "u1", { failNick: true });
  const i = mkInteraction(g, "u1", {
    team: "Byte Busters",
    last: "Cruz",
    first: "Juan",
  });
  await onVerifyModal(i);
  assert.deepEqual(m.roles.added, ["PART", "R-Byte Busters"]);
  assert.match(textOf(i.last), /couldn't change your nickname/);
  assert.equal(teams[0].members.length, 1);
});

test("verify: two accounts racing for the same name -> exactly one wins; different names all succeed", async () => {
  teams.push(
    mkTeam(
      "Byte Busters",
      [],
      [
        ["Cruz", "Juan"],
        ["Santos", "Maria"],
        ["Reyes", "Ana"],
      ],
    ),
  );
  const g = mkGuild(teams);
  const names = [
    ["u1", "Cruz", "Juan"],
    ["u2", "Cruz", "Juan"],
    ["u3", "Santos", "Maria"],
    ["u4", "Reyes", "Ana"],
  ];
  const results = await Promise.all(
    names.map(([id, l, f]) => {
      mkMember(g, id);
      const i = mkInteraction(g, id, {
        team: "Byte Busters",
        last: l,
        first: f,
      });
      return onVerifyModal(i).then(() => i);
    }),
  );
  assert.equal(teams[0].members.length, 3);
  const cruz = results.slice(0, 2).map((i) => textOf(i.last));
  assert.equal(cruz.filter((t) => /Welcome, /.test(t)).length, 1);
  assert.equal(cruz.filter((t) => /already claimed/.test(t)).length, 1);
});

test("verify: re-verifying an existing member re-applies roles without a second claim", async () => {
  teams.push(mkTeam("Byte Busters", ["u1"]));
  const g = mkGuild(teams);
  const m = mkMember(g, "u1");
  await onVerifyModal(
    mkInteraction(g, "u1", { team: "Byte Busters", last: "L0", first: "F0" }),
  );
  assert.equal(teams[0].members.length, 1);
  assert.deepEqual(m.roles.added, ["PART", "R-Byte Busters"]);
  assert.equal(m.nickname, "[ Byte Busters ] L0, F0");
});

// =============================== SUBMISSIONS ===============================
const PDF = Buffer.from("%PDF-1.7\n...fake...");
globalThis.fetch = async () => ({
  ok: true,
  arrayBuffer: async () =>
    PDF.buffer.slice(PDF.byteOffset, PDF.byteOffset + PDF.length),
});
const submitFlow = async (g, userId, type, url) => {
  const fields = type === "presentation" ? { file: url } : { url };
  const modal = mkInteraction(g, userId, fields);
  await onSubmitModal(modal, type);
  const token = JSON.stringify(modal.last).match(
    /onyx:submit:confirm:([a-f0-9]+)/,
  )?.[1];
  return { modal, token };
};

test("submit: validate -> confirm -> stored; teammate is then blocked", async () => {
  teams.push(mkTeam("Byte Busters", ["u1", "u2"]));
  const g = mkGuild(teams);

  const bad = await submitFlow(g, "u1", "repository", "https://gitlab.com/a/b");
  assert.match(textOf(bad.modal.last), /can't be accepted/);
  assert.equal(bad.token, undefined);

  const { modal, token } = await submitFlow(
    g,
    "u1",
    "repository",
    "github.com/byte/busters.git",
  );
  assertValidV2(modal.last);
  assert.match(textOf(modal.last), /This is final/);
  assert.equal(subs.length, 0, "nothing saved before confirmation");

  const confirm = mkInteraction(g, "u1", {}, {});
  await onSubmitConfirm(confirm, token);
  assert.equal(subs.length, 1);
  assert.equal(subs[0].url, "https://github.com/byte/busters");
  assert.match(textOf(confirm.last), /Repository locked in/);
  await new Promise((r) => setTimeout(r, 30)); // board refresh is fire-and-forget
  const board = g.sent.filter(([id]) => id === "ANN");
  assert.equal(board.length, 2, "board header + this team's card");
  board.forEach(([, m]) => assertValidV2(m));
  assert.match(textOf(board[0][1]), /Submissions Board/);
  assert.match(textOf(board[1][1]), /Byte Busters/);
  assert.match(textOf(board[1][1]), /github\.com\/byte\/busters/);
  assert.match(textOf(board[1][1]), /1 of 2 submitted/);

  // teammate tries the same item
  const mate = await submitFlow(
    g,
    "u2",
    "repository",
    "https://github.com/other/repo",
  );
  assert.match(textOf(mate.modal.last), /already submitted the repository/);
  assert.match(textOf(mate.modal.last), /notify the facilitators/);
  assert.equal(subs.length, 1);

  // ...but can still submit the other item
  const ppt = await submitFlow(g, "u2", "presentation", {
    name: "Our Deck!.pdf",
    size: 2_000_000,
    url: "https://cdn.discordapp.com/x/deck.pdf",
  });
  assert.match(textOf(ppt.modal.last), /Our Deck_\.pdf/);
  const pc = mkInteraction(g, "u2");
  await onSubmitConfirm(pc, ppt.token);
  assert.equal(subs.length, 2);
  assert.equal(subs[1].fileName, "Our Deck_.pdf");
  assert.match(
    subs[1].url,
    /^https:\/\/discord\.com\/channels\/G\/TX-Byte Busters\/M\d+$/,
  );
  assert.equal(
    g.sent.filter(([id]) => id === "TX-Byte Busters").length >= 1,
    true,
    "file stored in the team's private channel",
  );
  assert.match(textOf(pc.last), /Presentation locked in/);
  await new Promise((r) => setTimeout(r, 30));
  const cards = g.sent.filter(([id]) => id === "ANN");
  const last = cards[cards.length - 1][1];
  assert.equal(
    last.files?.length,
    1,
    "the PDF itself is attached to the facilitators' card",
  );
  assert.equal(last.files[0].name, "Our Deck_.pdf");
  assert.match(textOf(last), /attachment:\/\/Our Deck_\.pdf/);
  assert.match(textOf(last), /Complete — ready for judging/);
});

test("submit: two teammates confirming at the same instant -> exactly one wins", async () => {
  teams.push(mkTeam("Byte Busters", ["u1", "u2"]));
  const g = mkGuild(teams);
  const a = await submitFlow(g, "u1", "repository", "https://github.com/a/one");
  const b = await submitFlow(g, "u2", "repository", "https://github.com/a/two");
  const ca = mkInteraction(g, "u1");
  const cb = mkInteraction(g, "u2");
  await Promise.all([
    onSubmitConfirm(ca, a.token),
    onSubmitConfirm(cb, b.token),
  ]);
  assert.equal(subs.length, 1);
  const texts = [textOf(ca.last), textOf(cb.last)];
  assert.equal(texts.filter((t) => /Repository locked in/.test(t)).length, 1);
  assert.equal(
    texts.filter((t) => /already submitted the repository/.test(t)).length,
    1,
  );
});

test("submit: wrong file types / sizes / fake extensions are refused", async () => {
  teams.push(mkTeam("Byte Busters", ["u1"]));
  const g = mkGuild(teams);
  for (const [file, re] of [
    [{ name: "deck.docx", size: 1000, url: "u" }, /PDF\*\* or \*\*PPTX/],
    [{ name: "deck.ppt", size: 1000, url: "u" }, /PDF\*\* or \*\*PPTX/],
    [{ name: "deck.pdf", size: 30 * 1024 * 1024, url: "u" }, /too large/],
  ]) {
    const r = await submitFlow(g, "u1", "presentation", file);
    assert.match(textOf(r.modal.last), re);
    assert.equal(r.token, undefined);
  }
  // renamed exe pretending to be a pdf
  const prev = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    arrayBuffer: async () => new TextEncoder().encode("MZ not a pdf").buffer,
  });
  const fake = await submitFlow(g, "u1", "presentation", {
    name: "deck.pdf",
    size: 1000,
    url: "u",
  });
  globalThis.fetch = prev;
  assert.match(textOf(fake.modal.last), /isn't a real PDF/);
});

test("submit: a confirmation token can't be used by someone else", async () => {
  teams.push(mkTeam("Byte Busters", ["u1", "u2"]));
  const g = mkGuild(teams);
  const { token } = await submitFlow(
    g,
    "u1",
    "repository",
    "https://github.com/a/one",
  );
  const thief = mkInteraction(g, "u2");
  await onSubmitConfirm(thief, token);
  assert.match(textOf(thief.last), /expired/);
  assert.equal(subs.length, 0);
});

test("submit: unverified user and closed deadline are refused", async () => {
  teams.push(mkTeam("Byte Busters", ["u1"]));
  const g = mkGuild(teams);
  const stranger = await submitFlow(
    g,
    "nobody",
    "repository",
    "https://github.com/a/b",
  );
  assert.match(textOf(stranger.modal.last), /Verify first/);

  const ok = await submitFlow(g, "u1", "repository", "https://github.com/a/b");
  cfg.deadline = new Date(Date.now() - 1000); // deadline passes between modal and confirm
  const c = mkInteraction(g, "u1");
  await onSubmitConfirm(c, ok.token);
  assert.match(textOf(c.last), /Submissions are closed/);
  assert.equal(subs.length, 0);

  const late = await submitFlow(g, "u1", "presentation", {
    name: "d.pdf",
    size: 10,
    url: "u",
  });
  assert.match(textOf(late.modal.last), /Submissions are closed/);
});

// =============================== TEAM SPACES ===============================
test("team space: category + 1 text + 1 voice, private to the team and facilitators", async () => {
  const doc = {
    _id: "T9",
    guildId: "G",
    name: "Byte Busters",
    roleId: null,
    categoryId: null,
    textChannelId: null,
    voiceChannelId: null,
    createdAt: new Date(),
  };
  teams.push(doc);
  const created = { roles: [], channels: [] };
  const guild = {
    id: "G",
    client: { user: { id: "BOT" } },
    roles: {
      everyone: { id: "G" },
      fetch: async () => null,
      create: async (o) => {
        created.roles.push(o);
        return { id: "ROLE1", name: o.name, setName: async () => {} };
      },
    },
    channels: {
      fetch: async () => null,
      create: async (o) => {
        created.channels.push(o);
        return { id: `CH${created.channels.length}`, type: o.type, ...o };
      },
    },
  };
  const { team, created: what } = await ensureTeamResources(guild, doc, cfg);
  assert.deepEqual(what, ["role", "category", "text channel", "voice channel"]);

  const [cat, text, voice] = created.channels;
  assert.equal(cat.name, "⊂⊃  ﹕  byte busters  !  ୧");
  assert.equal(cat.type, ChannelType.GuildCategory);
  assert.equal(text.name, "．💬．𓂃．team-chat");
  assert.equal(text.type, ChannelType.GuildText);
  assert.equal(text.parent, "CH1");
  assert.equal(voice.name, "．🔊．𓂃．team-collab");
  assert.equal(voice.type, ChannelType.GuildVoice);
  assert.equal(voice.parent, "CH1");
  assert.equal(
    created.channels.length,
    3,
    "exactly one category, one text, one voice",
  );

  for (const ch of [cat, text, voice]) {
    const byId = Object.fromEntries(
      ch.permissionOverwrites.map((o) => [o.id, o]),
    );
    assert.deepEqual(byId["G"].deny, [P.ViewChannel], "@everyone cannot view");
    assert.ok(byId["ROLE1"].allow.includes(P.ViewChannel), "team can view");
    assert.ok(
      byId["FAC"].allow.includes(P.ViewChannel),
      "facilitators can view",
    );
    assert.equal(
      Object.keys(byId).length,
      4,
      "no other team/role is granted access",
    );
    assert.ok(
      ch.permissionOverwrites.every(
        (o) => o.type === OverwriteType.Role || o.id === "BOT",
      ),
    );
  }
  assert.deepEqual(
    [team.roleId, team.categoryId, team.textChannelId, team.voiceChannelId],
    ["ROLE1", "CH1", "CH2", "CH3"],
  );
});

// =============================== /team edit & /team add ===============================
import { execute as teamExecute } from "../src/commands/team.js";

const mkCmd = (guild, sub, opts) => {
  const i = mkInteraction(guild, "admin");
  i.member = {
    permissions: { has: () => true },
    roles: { cache: { has: () => false } },
  };
  i.options = {
    getSubcommand: () => sub,
    getString: (k) => opts[k] ?? null,
    getUser: (k) => opts[k],
  };
  i.client = { guilds: { cache: new Map() } };
  i.inGuild = () => true;
  return i;
};

test("team add: needs a valid 3-5 person roster", async () => {
  Team.create = async (d) => {
    const t = { _id: `T${nextId++}`, ...d, members: [] };
    teams.push(t);
    return t;
  };
  const g = mkGuild([]);
  cfg.isComplete = () => false;
  const bad = mkCmd(g, "add", {
    name: "Solo",
    members: "Cruz, Juan; Santos, Maria",
  });
  await teamExecute(bad);
  assert.match(textOf(bad.last), /needs 3-5 members/);
  assert.equal(teams.length, 0);
  const good = mkCmd(g, "add", {
    name: "Trio",
    members: "Cruz, Juan; Santos, Maria; Reyes, Ana",
    track: "qol",
  });
  await teamExecute(good);
  cfg.isComplete = () => true;
  assert.equal(teams.length, 1);
  assert.deepEqual(
    teams[0].roster.map((r) => r.userId),
    [null, null, null],
  );
  assert.match(textOf(good.last), /Cruz, Juan/);
});

test("team edit: rename updates nicknames; add/remove members releases the removed person", async () => {
  const t = mkTeam("Old Name", ["u1", "u2"], [["Reyes", "Ana"]]);
  teams.push(t);
  t.save = async () => t;
  const g = mkGuild(teams);
  const m1 = mkMember(g, "u1");
  mkMember(g, "u2");
  Team.findOne = async (q) => withSave(teams.find((x) => match(x, q)) ?? null);

  const rename = mkCmd(g, "edit", { name: "Old Name", new_name: "New Name" });
  await teamExecute(rename);
  assert.equal(t.name, "New Name");
  assert.equal(m1.nickname, "[ New Name ] L0, F0");

  const swap = mkCmd(g, "edit", {
    name: "New Name",
    remove_members: "L0, F0",
    add_members: "Santos, Maria",
  });
  m1.roles.remove = async () => {};
  await teamExecute(swap);
  assert.deepEqual(
    t.roster.map((r) => r.lastName),
    ["L1", "Reyes", "Santos"],
  );
  assert.equal(
    t.members.some((m) => m.userId === "u1"),
    false,
    "removed person is unverified",
  );
  assert.match(textOf(swap.last), /TEAM UPDATED/);

  const tooMany = mkCmd(g, "edit", {
    name: "New Name",
    add_members: "A, A; B, B; C, C",
  });
  await teamExecute(tooMany);
  assert.match(textOf(tooMany.last), /at most 5/);
});
