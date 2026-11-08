import test from "node:test";
import assert from "node:assert/strict";
import {
  buildNickname,
  cleanPersonName,
  cleanTeamName,
  normalizeKey,
  suggestTeams,
} from "../src/lib/names.js";

test("normalizeKey ignores case, punctuation, accents and spacing", () => {
  assert.equal(normalizeKey("  Team-Alpha!! "), "team alpha");
  assert.equal(normalizeKey("TEAM   ALPHA"), "team alpha");
  assert.equal(normalizeKey("Café Ñandú"), "cafe nandu");
  assert.equal(normalizeKey("[Byte] Busters"), "byte busters");
});

test("cleanPersonName title-cases mono-case input only", () => {
  assert.equal(cleanPersonName("dela cruz"), "Dela Cruz");
  assert.equal(cleanPersonName("DELA CRUZ"), "Dela Cruz");
  assert.equal(cleanPersonName("McDonald"), "McDonald");
  assert.equal(cleanPersonName("o'brien"), "O'Brien");
  assert.equal(cleanPersonName("  Ana,  Marie [x] "), "Ana Marie x");
});

test("cleanTeamName strips formatting characters", () => {
  assert.equal(
    cleanTeamName("  *Byte*  _Busters_ @everyone "),
    "Byte Busters everyone",
  );
});

test("buildNickname uses the requested format when it fits", () => {
  const r = buildNickname("Onyx", "Cruz", "Juan");
  assert.equal(r.nickname, "[ Onyx ] Cruz, Juan");
  assert.equal(r.truncated, false);
});

test("buildNickname never exceeds 32 chars and keeps the shape", () => {
  const cases = [
    ["Byte Busters", "Dela Cruz", "Juan Miguel"],
    [
      "The Absolutely Unstoppable Hackers",
      "Villanueva-Santos",
      "Maria Cristina",
    ],
    ["A", "B", "C"],
    ["X".repeat(60), "Y".repeat(40), "Z".repeat(40)],
    ["Team", "Jr", "Jo"],
  ];
  for (const [t, l, f] of cases) {
    const { nickname } = buildNickname(t, l, f);
    assert.ok(nickname.length <= 32, `${nickname} (${nickname.length})`);
    assert.match(nickname, /^\[ .+ \] .+, .+$/u);
  }
  assert.equal(
    buildNickname(
      "The Absolutely Unstoppable Hackers",
      "Villanueva-Santos",
      "Maria Cristina",
    ).truncated,
    true,
  );
});

test("suggestTeams finds near matches", () => {
  const teams = ["Byte Busters", "Code Wizards", "Data Drifters"].map((n) => ({
    name: n,
    nameKey: normalizeKey(n),
  }));
  assert.deepEqual(
    suggestTeams(normalizeKey("Byte Bsters"), teams).map((t) => t.name),
    ["Byte Busters"],
  );
  assert.deepEqual(
    suggestTeams(normalizeKey("wizards"), teams).map((t) => t.name),
    ["Code Wizards"],
  );
  assert.deepEqual(suggestTeams(normalizeKey("zzzzzz"), teams), []);
});

import { parseRoster, personKey } from "../src/lib/names.js";
test("roster parsing and order-independent person keys", () => {
  const { people, errors } = parseRoster(
    "dela cruz, juan; Santos, Maria\nReyes, Ana",
  );
  assert.deepEqual(
    people.map((p) => `${p.lastName}|${p.firstName}`),
    ["Dela Cruz|Juan", "Santos|Maria", "Reyes|Ana"],
  );
  assert.deepEqual(errors, []);
  assert.equal(parseRoster("Just One Name").errors.length, 1);
  assert.equal(parseRoster("A, B, C").errors.length, 1);
  assert.equal(personKey("Dela Cruz", "Juan"), personKey("juan", "DELA CRUZ"));
});
