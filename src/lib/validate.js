// Link validation for submissions.
import { EVENT } from "../config/event.js";

const RESERVED_OWNERS = new Set([
  "orgs",
  "settings",
  "topics",
  "marketplace",
  "sponsors",
  "features",
  "about",
  "pricing",
  "login",
  "join",
  "explore",
  "notifications",
]);

const toUrl = (input) => {
  let raw = String(input ?? "")
    .trim()
    .replace(/^<|>$/g, "");
  if (!raw) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
};

/** GitHub repo link -> canonical https://github.com/owner/repo */
export const parseRepoUrl = (input) => {
  const url = toUrl(input);
  if (!url)
    return { ok: false, reason: "That doesn't look like a valid link." };
  if (url.protocol !== "https:")
    return { ok: false, reason: "The link must start with `https://`." };
  if (url.username || url.password)
    return { ok: false, reason: "Remove any username/password from the link." };
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== "github.com")
    return {
      ok: false,
      reason:
        "Only **GitHub** repository links are accepted (`https://github.com/owner/repo`).",
    };
  const [owner, repoRaw] = url.pathname.split("/").filter(Boolean);
  const repo = repoRaw?.replace(/\.git$/i, "");
  if (!owner || !repo)
    return {
      ok: false,
      reason:
        "The link must point to a repository: `https://github.com/owner/repo`.",
    };
  if (
    RESERVED_OWNERS.has(owner.toLowerCase()) ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)
  )
    return {
      ok: false,
      reason:
        "That owner name doesn't look like a GitHub user or organization.",
    };
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(repo) || repo === "." || repo === "..")
    return { ok: false, reason: "That repository name doesn't look valid." };
  return { ok: true, url: `https://github.com/${owner}/${repo}` };
};

/** Presentation file: PDF or PPTX only, within the size cap. Takes a Discord attachment-like object. */
export const checkPresentationFile = (file) => {
  const { extensions, maxMB } = EVENT.presentationFile;
  const name = String(file?.name ?? "");
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  if (!extensions.includes(ext))
    return {
      ok: false,
      reason: "Only **PDF** or **PPTX** files are accepted.",
    };
  if (!file.size || file.size <= 0)
    return { ok: false, reason: "That file is empty." };
  if (file.size > maxMB * 1024 * 1024)
    return {
      ok: false,
      reason: `That file is too large (max ${maxMB} MB). Compress the images and try again.`,
    };
  return { ok: true, ext };
};

/** Check the real bytes, not just the name: PDFs start with %PDF-, PPTX is a zip containing ppt/ entries. */
export const sniffPresentation = (buffer, ext) => {
  if (ext === "pdf")
    return buffer.subarray(0, 5).toString("latin1") === "%PDF-";
  if (ext === "pptx") {
    const zip =
      buffer[0] === 0x50 &&
      buffer[1] === 0x4b &&
      buffer[2] === 0x03 &&
      buffer[3] === 0x04;
    return zip && buffer.includes("ppt/");
  }
  return false;
};

/** File name that is safe to re-upload (keeps the extension). */
export const safeFileName = (name, ext) => {
  const base =
    String(name)
      .replace(/\.[^.]+$/, "")
      .replace(/[^\w\- ]+/g, "_")
      .trim()
      .slice(0, 60) || "presentation";
  return `${base}.${ext}`;
};
