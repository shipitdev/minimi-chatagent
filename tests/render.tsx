/**
 * Render smoke test.
 *
 * The generated-UI layer is the highest-risk untested surface: a schema/renderer
 * mismatch fails at render time, for the user, and typechecking cannot catch a
 * runtime parse error in an OpenUI Lang document. This renders one document
 * containing every component through the real OpenUI runtime and asserts the
 * expected text survives to HTML.
 *
 * Run: npm run test:ui
 */

import React from "react";
import { renderToString } from "react-dom/server";
import { Renderer } from "@openuidev/react-lang";
import { clientLibrary } from "../src/client/library.js";

const doc = [
  "root = Report([answer, changes, timeline, stats, note, chips])",
  'answer = AnswerCard("**Gallium** melts at 29.76 °C [1].\n\n| Tool | Price |\n|---|---|\n| Gallium | 29.76 |", [1], ["Gallium"], ["rsc.org"], ["https://www.rsc.org/x"])',
  'changes = ChangeList("What changed", ["Cursor", "Windsurf"], ["updated", "unchanged"], ["price changed", "no change found"], ["$20", ""], ["$25", ""], ["1,2", ""])',
  'timeline = RecallTimeline("Recovered", "yesterday · Asia/Calcutta", ["LLM compression"], ["Tue 10 Nov"], ["Asia/Calcutta"], [6], ["we discussed LLMLingua"], ["c1"])',
  'stats = StatStrip(["Sources", "Digest"], ["1", "78% smaller"], ["", "vs raw"])',
  'note = Note("A caveat with \\"quotes\\".")',
  'chips = QuickChips(["What changed?", "Track this"])',
].join("\n");

try {
  const html = renderToString(React.createElement(Renderer, { response: doc, library: clientLibrary as never }));
  const checks: Array<[string, boolean]> = [
    ["answer text", html.includes("Gallium")],
    ["markdown bold rendered", html.includes("<strong>Gallium</strong>")],
    ["markdown table rendered", html.includes("<table") && html.includes("<th")],
    ["markdown leaked as literal pipes", !html.includes("|---|")],
    ["citation chip", html.includes("cite-chip") && html.includes("rsc.org")],
    ["change row label", html.includes("Cursor")],
    ["change old→new", html.includes("$20") && html.includes("$25")],
    ["status badge", html.includes("updated")],
    ["timeline", html.includes("LLM compression") && html.includes("Asia/Calcutta")],
    ["stats", html.includes("78% smaller")],
    ["note with quotes", html.includes("A caveat")],
    ["chips", html.includes("What changed?")],
  ];
  let ok = 0;
  for (const [name, pass] of checks) {
    console.log(`  ${pass ? "ok  " : "FAIL"} ${name}`);
    if (pass) ok++;
  }
  console.log(`\n${ok}/${checks.length} render checks passed (${html.length} chars of HTML)`);
  process.exitCode = ok === checks.length ? 0 : 1;
} catch (err) {
  console.error("RENDER THREW:", err);
  process.exitCode = 1;
}
