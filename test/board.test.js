import test from "node:test";
import assert from "node:assert/strict";
import { ComponentType as C, ContainerBuilder } from "discord.js";
import {
  boardHeaderPayload,
  teamCardPayload,
  teamState,
} from "../src/lib/board.js";
import { KINDS, buildLog } from "../src/lib/logs.js";
import { measure, V2_LIMITS } from "../src/lib/ui.js";

const valid = (payload, label) => {
  for (const c of payload.components) new ContainerBuilder(c).toJSON();
  const { count, chars } = measure(payload.components);
  assert.ok(
    count <= V2_LIMITS.totalComponents,
    `${label}: ${count} components`,
  );
  assert.ok(chars <= V2_LIMITS.totalText, `${label}: ${chars} chars`);
};
const flat = (list) =>
  list.flatMap((c) => [
    c,
    ...(c.components ? flat(c.components) : []),
    ...(c.accessory ? [c.accessory] : []),
  ]);

const team = {
  _id: "T1",
  name: "Byte Busters",
  track: "qol",
  roster: [
    { firstName: "Juan", lastName: "Cruz", userId: "1" },
    { firstName: "Maria", lastName: "Santos", userId: null },
  ],
};
const repo = {
  type: "repository",
  url: "https://github.com/byte/busters",
  submittedByName: "Cruz, Juan",
  createdAt: new Date(),
};
const ppt = {
  type: "presentation",
  url: "https://discord.com/channels/1/2/3",
  fileName: "deck.pdf",
  fileSize: 3_500_000,
  submittedByName: "Santos, Maria",
  createdAt: new Date(),
};

test("team card states: waiting / partial / complete", () => {
  assert.equal(teamState([]).icon, "⚪");
  assert.equal(teamState([repo]).icon, "🟡");
  assert.equal(teamState([repo, ppt]).icon, "🟢");
});

test("team card shows the github link and the attached presentation file", () => {
  const empty = teamCardPayload(team, []);
  valid(empty, "card empty");
  assert.equal(
    flat(empty.components).some((c) => c.type === C.File),
    false,
  );
  assert.equal(
    flat(empty.components).some((c) => c.type === C.ActionRow),
    false,
    "no buttons until something is submitted",
  );

  const full = teamCardPayload(team, [repo, ppt], { hasFile: true });
  valid(full, "card full");
  const all = flat(full.components);
  const file = all.find((c) => c.type === C.File);
  assert.equal(file.file.url, "attachment://deck.pdf");
  const links = all.filter((c) => c.type === C.Button).map((b) => b.url);
  assert.deepEqual(links, [
    "https://github.com/byte/busters",
    "https://discord.com/channels/1/2/3",
  ]);
  assert.match(JSON.stringify(full), /Juan Cruz/);
  assert.match(JSON.stringify(full), /3\.3 MB/);

  const noFile = teamCardPayload(team, [repo, ppt], { hasFile: false });
  assert.equal(
    flat(noFile.components).some((c) => c.type === C.File),
    false,
  );
});

test("board header: open and closed", () => {
  const st = {
    total: 12,
    repos: 5,
    ppts: 3,
    complete: 2,
    started: 4,
    waiting: 6,
  };
  valid(
    boardHeaderPayload({ deadline: new Date(Date.now() + 1e7) }, st),
    "header open",
  );
  const closed = boardHeaderPayload(
    { deadline: new Date(Date.now() - 1e3) },
    st,
  );
  valid(closed, "header closed");
  assert.match(JSON.stringify(closed), /Submissions Closed/);
  valid(
    boardHeaderPayload(
      { deadline: new Date() },
      { total: 0, repos: 0, ppts: 0, complete: 0, started: 0, waiting: 0 },
    ),
    "header empty",
  );
});

test("every log kind renders a valid card (with and without avatar)", () => {
  const user = {
    id: "42",
    displayAvatarURL: () => "https://cdn.discordapp.com/avatars/42/a.png",
  };
  for (const kind of Object.keys(KINDS)) {
    valid(
      buildLog(kind, {
        user,
        summary: "<@42> · **name**",
        fields: [
          ["A", "b"],
          ["Empty", ""],
        ],
        note: "x".repeat(2000),
      }),
      kind,
    );
    valid(buildLog(kind, { id: "7" }), `${kind} bare`);
  }
  const withThumb = flat(
    buildLog("member.join", { user, summary: "s" }).components,
  );
  assert.ok(withThumb.some((c) => c.type === C.Thumbnail));
  assert.ok(
    !flat(buildLog("member.join", { summary: "s" }).components).some(
      (c) => c.type === C.Thumbnail,
    ),
  );
});
