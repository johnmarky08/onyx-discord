import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ChannelType, ContainerBuilder } from "discord.js";
import { GuildConfig, Team } from "../src/models/index.js";
import { registerEventLogs } from "../src/lib/events.js";
import { setLogDelay } from "../src/lib/logs.js";
import { mute, memberKey } from "../src/lib/quiet.js";

GuildConfig.findOne = () => Promise.resolve({ logChannelId: "LOG" });
Team.findOne = async () => ({ name: "Byte Busters" });

const sent = [];
const guild = {
  id: "G",
  memberCount: 42,
  channels: { fetch: async () => ({ send: async (m) => sent.push(m) }) },
  roles: { cache: new Map() },
};
const client = new EventEmitter();
registerEventLogs(client, { messageLogs: true });
const text = (m) => JSON.stringify(m.components);
const flush = async () => {
  setLogDelay(0);
  await new Promise((r) => setTimeout(r, 60));
};

const user = {
  id: "u1",
  username: "juan",
  bot: false,
  createdAt: new Date(),
  displayAvatarURL: () => "https://cdn.discordapp.com/a.png",
};
const mkRoles = (ids) => ({
  cache: new Map(ids.map((i) => [i, { id: i, position: 1 }])),
  keys: undefined,
});

test("server events become valid log cards", async () => {
  client.emit("guildMemberAdd", {
    guild,
    user,
    id: "u1",
    toString: () => "<@u1>",
  });
  client.emit("guildMemberRemove", {
    guild,
    user,
    id: "u1",
    roles: { cache: new Map() },
    joinedAt: new Date(),
  });
  client.emit("channelCreate", {
    guild,
    id: "c1",
    name: "general",
    type: ChannelType.GuildText,
    parent: null,
  });
  client.emit("channelDelete", {
    guild,
    id: "c2",
    name: "old",
    type: ChannelType.GuildVoice,
    parent: { name: "Cat" },
  });
  client.emit("roleCreate", { guild, id: "r1" });
  client.emit(
    "voiceStateUpdate",
    { channelId: null, member: null },
    { channelId: "v1", member: { id: "u1", user, guild } },
  );
  client.emit("guildBanAdd", { guild, user, reason: "spam" });
  client.emit("inviteCreate", {
    guild,
    code: "abc",
    inviter: user,
    channel: { id: "c1" },
    maxUses: 0,
    expiresAt: null,
  });
  client.emit("messageDelete", {
    guild,
    author: user,
    channelId: "c1",
    content: "hello",
    attachments: new Map(),
  });
  await flush();
  const all = sent.map(text).join("\n");
  for (const needle of [
    "Member Joined",
    "Member Left",
    "Byte Busters",
    "Channel Created",
    "Channel Deleted",
    "Role Created",
    "Joined Voice",
    "Member Banned",
    "spam",
    "Invite Created",
    "Message Deleted",
    "hello",
  ]) {
    assert.ok(all.includes(needle), `missing "${needle}"`);
  }
  sent.forEach((m) =>
    m.components.forEach((c) => new ContainerBuilder(c).toJSON()),
  );
  assert.equal(sent.length, 9);
});

test("changes Onyx makes itself are not logged twice", async () => {
  sent.length = 0;
  mute("c-team");
  mute(memberKey("G", "u1"));
  client.emit("channelCreate", {
    guild,
    id: "c-team",
    name: "team",
    type: ChannelType.GuildText,
    parent: null,
  });
  const roles = (ids) => ({ cache: new Map(ids.map((i) => [i, {}])) });
  client.emit(
    "guildMemberUpdate",
    { partial: false, nickname: null, roles: roles([]) },
    { guild, id: "u1", user, nickname: "[ X ] A, B", roles: roles(["r"]) },
  );
  await flush();
  assert.equal(sent.length, 0);
});

test("nickname and role changes by others are logged", async () => {
  sent.length = 0;
  const roles = (ids) => ({ cache: new Map(ids.map((i) => [i, {}])) });
  client.emit(
    "guildMemberUpdate",
    { partial: false, nickname: "a", roles: roles(["r1"]) },
    {
      guild,
      id: "u9",
      user: { ...user, id: "u9" },
      nickname: "b",
      roles: roles(["r2"]),
    },
  );
  await flush();
  const all = sent.map(text).join("\n");
  assert.ok(all.includes("Nickname Changed") && all.includes("Roles Updated"));
});
