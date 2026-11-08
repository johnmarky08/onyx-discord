import test from "node:test";
import assert from "node:assert/strict";
import {
  checkPresentationFile,
  parseRepoUrl,
  safeFileName,
  sniffPresentation,
} from "../src/lib/validate.js";

test("repo links are canonicalised", () => {
  assert.equal(
    parseRepoUrl("https://github.com/octa/hack4success").url,
    "https://github.com/octa/hack4success",
  );
  assert.equal(
    parseRepoUrl("github.com/octa/app.git").url,
    "https://github.com/octa/app",
  );
  assert.equal(
    parseRepoUrl("https://www.github.com/octa/app/tree/main/src?x=1").url,
    "https://github.com/octa/app",
  );
  assert.equal(
    parseRepoUrl("<https://github.com/octa/app>").url,
    "https://github.com/octa/app",
  );
});

test("repo links reject non-GitHub / incomplete / unsafe links", () => {
  for (const bad of [
    "",
    "not a url",
    "http://github.com/a/b",
    "https://gitlab.com/a/b",
    "https://github.com/octa",
    "https://github.com/settings/profile",
    "https://user:pw@github.com/a/b",
    "https://github.com.evil.com/a/b",
    "https://github.com/-bad/repo",
    "javascript:alert(1)",
  ]) {
    assert.equal(parseRepoUrl(bad).ok, false, bad);
  }
});

test("presentation files: only pdf/pptx within the size cap", () => {
  assert.equal(
    checkPresentationFile({ name: "Deck.PDF", size: 1000 }).ok,
    true,
  );
  assert.equal(
    checkPresentationFile({ name: "my deck.pptx", size: 5_000_000 }).ok,
    true,
  );
  for (const bad of [
    { name: "a.ppt", size: 10 },
    { name: "a.docx", size: 10 },
    { name: "pdf", size: 10 },
    { name: "a.pdf", size: 0 },
    { name: "a.pdf", size: 26 * 1024 * 1024 },
  ]) {
    assert.equal(checkPresentationFile(bad).ok, false, JSON.stringify(bad));
  }
});

test("presentation bytes are sniffed, not trusted", () => {
  assert.equal(sniffPresentation(Buffer.from("%PDF-1.4 x"), "pdf"), true);
  assert.equal(sniffPresentation(Buffer.from("MZ......"), "pdf"), false);
  assert.equal(
    sniffPresentation(
      Buffer.concat([
        Buffer.from([0x50, 0x4b, 3, 4]),
        Buffer.from("....ppt/slides/slide1.xml"),
      ]),
      "pptx",
    ),
    true,
  );
  assert.equal(
    sniffPresentation(
      Buffer.concat([
        Buffer.from([0x50, 0x4b, 3, 4]),
        Buffer.from("....word/document.xml"),
      ]),
      "pptx",
    ),
    false,
  );
});

test("safeFileName keeps the extension", () => {
  assert.equal(safeFileName("Our Deck!.PDF", "pdf"), "Our Deck_.pdf");
  assert.ok(!safeFileName("../../etc/passwd.pptx", "pptx").includes("/"));
});
