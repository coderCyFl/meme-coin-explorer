#!/usr/bin/env node
/** Static checks for 🚩 X 洗版 label wiring (stamp 20261029b). */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const picks = readFileSync(resolve(root, "picks.js"), "utf8");
const html = readFileSync(resolve(root, "index.html"), "utf8");
const css = readFileSync(resolve(root, "styles.css"), "utf8");
let pass = 0, fail = 0;
const ok = (n, c, extra = "") => { console.log((c ? "PASS " : "FAIL ") + n + (extra ? " → " + extra : "")); c ? pass++ : fail++; };

ok("stamp 20261029b on picks.js script tag", /picks\.js\?v=20261029b/.test(html));
ok("no leftover 20261029a in index.html", !/20261029a/.test(html));
ok("shillFlagEl text is exactly 🚩 X 洗版", /\}, "🚩 X 洗版"\)/.test(picks));
ok("no bare 🚩 append on xchip", !/gb-xflag", text: " 🚩"/.test(picks));
ok("sheet label 🚩 X 洗版 (not 疑似洗版)", /text: "🚩 X 洗版"/.test(picks) && !/疑似洗版/.test(picks));
ok("🔥/⚡ get shillFlagEl in gbCard", /\(r\.tier === "pump" \|\| gbIsEarly\(r\.tier\)\) \? shillFlagEl\(r\.symbol\)/.test(picks));
ok("🔥/⚡ get shillLineEl in details", /\(r\.tier === "pump" \|\| gbIsEarly\(r\.tier\)\) \? shillLineEl\(r\.symbol\)/.test(picks));
ok("今日跟買 uses shillFlagEl", /shillFlagEl\(x\.e\.pair_address \|\| x\.e\.symbol\)/.test(picks));
ok("每日新留意 table uses shillFlagEl", /shillFlagEl\(e\.pair_address \|\| e\.symbol\)/.test(picks));
ok("paint after early list", /renderEarlyList\(early, trig\);\s*\n\s*paintXChips\(\)/.test(picks));
ok(".shill-flag is red text, no fill", /\.shill-flag\{[^}]*color:var\(--red\)[^}]*background:none/.test(css.replace(/\s+/g, "")));
ok("no orange/ff8a3d in css/js/html", !/ff8a3d|orange/i.test(picks + html + css));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
