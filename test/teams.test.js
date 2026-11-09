import test from "node:test";
import assert from "node:assert/strict";
import { countVerifiedMembers } from "../src/lib/teams.js";

test("counts verified members across all teams", () => {
  const teams = [
    { members: [{ userId: "1" }, { userId: "2" }] },
    { members: [{ userId: "3" }] },
  ];

  assert.equal(countVerifiedMembers(teams), 3);
});

test("does not use the server member count for verified totals", () => {
  const teams = [{ members: [{ userId: "1" }] }];
  const guild = { memberCount: 100 };

  assert.equal(countVerifiedMembers(teams), 1);
  assert.notEqual(countVerifiedMembers(teams), guild.memberCount);
});
