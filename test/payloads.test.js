import test from "node:test";
import assert from "node:assert/strict";
import {
  ComponentType as C,
  ContainerBuilder,
  MessageFlags,
  ModalBuilder,
} from "discord.js";
import { welcomePanel, submissionPanel, IDS } from "../src/lib/panels.js";
import { wizardPayload } from "../src/interactions/setup.js";
import {
  measure,
  notice,
  textModal,
  v2,
  V2_LIMITS,
  container,
  text,
} from "../src/lib/ui.js";
import { EVENT } from "../src/config/event.js";
import { STYLE } from "../src/config/style.js";

// discord.js' own builders validate the JSON (types, lengths, required fields) on toJSON().
const validate = (payload, label) => {
  assert.ok(
    payload.flags & MessageFlags.IsComponentsV2 ||
      (Array.isArray(payload.flags) &&
        payload.flags.includes(MessageFlags.IsComponentsV2)),
    `${label}: V2 flag`,
  );
  assert.ok(
    !("content" in payload) && !("embeds" in payload),
    `${label}: V2 messages can't have content/embeds`,
  );
  for (const c of payload.components) {
    assert.equal(c.type, C.Container, `${label}: top level is a container`);
    new ContainerBuilder(c).toJSON();
  }
  const { count, chars } = measure(payload.components);
  assert.ok(
    count <= V2_LIMITS.totalComponents,
    `${label}: ${count} components`,
  );
  assert.ok(chars <= V2_LIMITS.totalText, `${label}: ${chars} chars`);
  return { count, chars };
};

const config = (deadline) => ({ deadline, guildId: "1" });

test("welcome panel is valid Components V2", () => {
  const r = validate(welcomePanel(), "welcome");
  console.log("   welcome:", r);
});

test("submission panel: open and closed states", () => {
  const open = submissionPanel(config(new Date(Date.now() + 86400000)), {
    teams: 12,
    repos: 3,
    ppts: 2,
  });
  const closed = submissionPanel(config(new Date(Date.now() - 1000)), {
    teams: 12,
    repos: 12,
    ppts: 11,
  });
  console.log("   submission open:", validate(open, "submission open"));
  validate(closed, "submission closed");
  const buttons = (p) =>
    p.components[0].components.find((c) => c.type === C.ActionRow).components;
  assert.equal(
    buttons(open).find((b) => b.custom_id === IDS.submitRepo).disabled,
    undefined,
  );
  assert.equal(
    buttons(closed).find((b) => b.custom_id === IDS.submitRepo).disabled,
    true,
  );
  assert.equal(
    buttons(closed).find((b) => b.custom_id === IDS.teamStatus).disabled,
    undefined,
    "status stays usable after close",
  );
});

test("setup wizard: empty, partial, full and with problems", () => {
  const empty = { lockServer: true };
  const full = {
    participantRoleId: "1",
    facilitatorRoleId: "2",
    welcomeChannelId: "3",
    submissionChannelId: "4",
    boardChannelId: "6",
    logChannelId: "5",
    lockServer: false,
  };
  const find = (list, id) => {
    for (const c of list) {
      if (c.custom_id === id) return c;
      const hit = c.components && find(c.components, id);
      if (hit) return hit;
    }
  };
  const deployBtn = (p) => find(p.components, "onyx:setup:deploy");
  console.log("   wizard:", validate(wizardPayload(empty), "wizard empty"));
  validate(
    wizardPayload({ ...empty, participantRoleId: "1" }),
    "wizard partial",
  );
  assert.equal(
    deployBtn(wizardPayload({ ...full, boardChannelId: null })).disabled,
    true,
    "announcements channel is required",
  );
  validate(wizardPayload(full, ["Problem one", "Problem two"]), "wizard full");
  assert.equal(deployBtn(wizardPayload(empty)).disabled, true);
  assert.equal(deployBtn(wizardPayload(full)).disabled, undefined);
  // default values are wired so the pickers show the current choice
  assert.match(
    JSON.stringify(wizardPayload(full)),
    /"default_values":\[\{"id":"1","type":"role"\}\]/,
  );
  assert.match(
    JSON.stringify(wizardPayload(full)),
    /"default_values":\[\{"id":"3","type":"channel"\}\]/,
  );
});

test("notice cards for every tone", () => {
  for (const tone of ["ok", "warn", "error", "info"])
    validate(notice(tone, "Title", "Body"), `notice ${tone}`);
});

test("modals use Label + TextInput and validate", () => {
  const m = textModal({
    id: IDS.verifyModal,
    title: "Participant Verification",
    intro: "intro",
    fields: [
      {
        id: "team",
        label: "Team name",
        min: 2,
        max: 60,
        value: "Byte Busters",
      },
      { id: "last", label: "Last name", max: 40 },
      { id: "first", label: "First name", max: 40 },
    ],
  });
  new ModalBuilder(m).toJSON();
  assert.equal(m.components[1].type, C.Label);
  assert.equal(m.components[1].component.type, C.TextInput);
});

test("submission modal title stays within Discord's 45 char limit", () => {
  const title = `Submit Presentation — ${"A".repeat(60)}`.slice(0, 45);
  new ModalBuilder(
    textModal({
      id: "x",
      title,
      fields: [{ id: "u", label: "Link", max: 400 }],
    }),
  ).toJSON();
});

test("category / channel names follow the requested format", () => {
  assert.equal(STYLE.category("Byte Busters"), "⊂⊃  ﹕  byte busters  !  ୧");
  assert.match(STYLE.textChannel, /^．.+．𓂃．team-chat$/u);
  assert.match(STYLE.voiceChannel, /^．.+．𓂃．team-collab$/u);
  assert.ok(STYLE.category("x".repeat(200)).length <= 100);
});

test("event config matches the rules PDF", () => {
  assert.equal(
    new Date(EVENT.deadline).toISOString(),
    "2026-11-12T04:00:00.000Z",
  ); // 12 NN PHT
  assert.equal(EVENT.tracks.length, 4);
  assert.deepEqual(EVENT.teamSize, { min: 3, max: 5 });
});

test("all slash commands serialise and every custom_id is within 100 chars", async () => {
  for (const name of ["onyx", "team", "submissions"]) {
    const mod = await import(`../src/commands/${name}.js`);
    const json = mod.data.toJSON();
    assert.equal(json.name, name);
    assert.ok(typeof mod.execute === "function");
  }
  const ids = JSON.stringify([
    welcomePanel(),
    submissionPanel(config(new Date(Date.now() + 1e6))),
    wizardPayload({ lockServer: true }),
  ]).match(/"custom_id":"[^"]+"/g);
  for (const id of ids) assert.ok(id.length - 13 <= 100, id);
  assert.ok((IDS.submitConfirm + "abcdef123456").length <= 100);
  assert.ok(`onyx:team-remove:confirm:${"a".repeat(24)}`.length <= 100);
});

import { fileModal } from "../src/lib/ui.js";
test("presentation modal uses a File Upload field and validates", () => {
  const m = fileModal({
    id: "x",
    title: "Submit",
    intro: "i",
    label: "Presentation file",
    description: "PDF or PPTX only",
  });
  new ModalBuilder(m).toJSON();
  assert.equal(m.components[1].component.type, C.FileUpload);
});
