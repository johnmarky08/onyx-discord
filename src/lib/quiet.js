// Things Onyx changes itself (roles, channels, nicknames) are already reported by a purpose-built log,
// so the generic server-event logger skips them for a short while to avoid duplicates.
import { TtlMap } from "./guards.js";

const muted = new TtlMap(2 * 60 * 1000);

export const mute = (id) => {
  if (id) muted.set(String(id), true);
};
export const muteMany = (ids = []) => ids.forEach(mute);
export const isMuted = (id) => Boolean(id) && muted.get(String(id)) === true;
export const memberKey = (guildId, userId) => `member:${guildId}:${userId}`;
