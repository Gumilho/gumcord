// Accessibility of the real app (see run.sh): the axe engine over the main screens, then the things
// axe can't judge, which are how the keyboard and a screen reader get around. Fails on any of it.
// Pass --report to list every offending element (useful while fixing); otherwise a summary.
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const AXE = require.resolve("axe-core/axe.min.js");
const BASE = "http://127.0.0.1:18090";
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM,
  args: ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
    "--disable-features=WebRtcHideLocalIpsWithMdns", "--autoplay-policy=no-user-gesture-required"],
});
const wait = { timeout: 8000 };
const verbose = process.argv.includes("--report");

async function user(name, admin = false, viewport = { width: 1280, height: 800 }) {
  const ctx = await browser.newContext({ locale: "en-US", permissions: ["microphone"], viewport });
  const page = await ctx.newPage();
  const socketReady = new Promise((resolve) => page.on("websocket", (ws) => ws.once("framereceived", resolve)));
  await page.goto(`${BASE}/api/auth/dev?name=${name}${admin ? "&admin=1" : ""}`);
  await page.locator("nav.channels").waitFor({ timeout: 15000 });
  await socketReady;
  await page.waitForTimeout(300);
  const me = await (await ctx.request.get(`${BASE}/api/me`)).json();
  return { ctx, page, me };
}

const found = []; // { screen, id, impact, help, nodes: [target] }
async function scan(screen, page) {
  await page.addScriptTag({ path: AXE });
  const res = await page.evaluate(async () => await window.axe.run(document, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] },
  }));
  for (const v of res.violations) {
    found.push({
      screen, id: v.id, impact: v.impact, help: v.help,
      nodes: v.nodes.map((n) => {
        const d = n.any.find((c) => c.id === "color-contrast")?.data;
        // For contrast, say what colours and how far short, so a fix can be judged without guessing.
        return n.target.join(" ") + (d ? `  [${d.fgColor} on ${d.bgColor}, ${Number(d.contrastRatio).toFixed(2)}:1, needs ${d.expectedContrastRatio}]` : "");
      }),
    });
  }
  console.log(`  scanned ${screen}: ${res.violations.length} violation type(s)`);
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/a11y-${screen.replace(/[^a-z0-9]+/gi, "-")}.png` });
}

const admin = await user("admin", true);
const alice = await user("alice");
await admin.ctx.request.put(`${BASE}/api/servers/1/members/${alice.me.id}`);
await alice.page.locator(".channel-row:has-text('general')").waitFor(wait);

// Something in the chat to scan: a message, an attachment, a link.
await admin.page.locator(".channel-row:has-text('general')").click();
await alice.page.locator(".channel-row:has-text('general')").click();
const input = alice.page.locator("textarea.msg-input");
await input.fill("hello there https://example.com");
await input.press("Enter");
await admin.page.locator(".message:has-text('hello there')").waitFor(wait);
await admin.ctx.request.post(`${BASE}/api/servers/1/emotes`, { multipart: { name: "dot", file: { name: "dot.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64") } } });

await scan("chat (member)", alice.page);
await scan("chat (admin)", admin.page);

// Dialogs and pop-ups.
async function overlay(screen, page, open, close = () => page.keyboard.press("Escape")) {
  await open();
  await page.waitForTimeout(400);
  await scan(screen, page);
  await close();
  await page.waitForTimeout(200);
}
await overlay("user settings", alice.page, () => alice.page.locator("button[aria-label='User settings']").click());
await overlay("server settings", admin.page, () => admin.page.locator(".header-actions button").first().click());
await overlay("channel settings", admin.page, () => admin.page.locator(".channel-gear").first().click({ force: true }));
await overlay("emote picker", alice.page, () => alice.page.locator("button.emote-btn").click());
await overlay("creating a server", admin.page, () => admin.page.locator(".server-rail button, nav button").filter({ hasText: "+" }).first().click().catch(() => {}));

// A call: sidebar panel, call view, the soundboard, a person's volume menu.
await alice.page.locator(".voice-channel").first().click();
await alice.page.locator(".voice-panel").waitFor({ timeout: 20000 });
await admin.page.locator(".voice-channel").first().click();
await admin.page.locator(".voice-panel").waitFor({ timeout: 20000 });
await alice.page.locator("nav.channels").getByText("admin", { exact: true }).waitFor({ timeout: 15000 });
await scan("in a call (sidebar)", alice.page);
await alice.page.locator(".voice-channel.in-voice").first().click();
await alice.page.locator(".tile").nth(1).waitFor(wait);
await scan("call view", alice.page);
await overlay("soundboard", alice.page, () => alice.page.locator("button[aria-label='Soundboard']").first().click());
await overlay("volume menu", alice.page, () => alice.page.locator(".tile.clickable").first().click());

// Narrow screens, and the sign-in screen.
const phone = await user("phone", false, { width: 390, height: 780 });
await admin.ctx.request.put(`${BASE}/api/servers/1/members/${phone.me.id}`);
await phone.page.locator("textarea.msg-input").waitFor(wait);
await phone.page.waitForTimeout(500);
await scan("phone: chat", phone.page);
await phone.page.locator("button.back, button[aria-label='Back']").first().click();
await phone.page.waitForTimeout(500);
await scan("phone: channel list", phone.page);

await alice.page.locator("button[aria-label='Disconnect']").first().click();
await alice.page.locator("button[aria-label='Log out']").click();
await alice.page.locator(".channels").waitFor({ state: "detached", ...wait });
await scan("sign-in screen", alice.page);


// ── What a tool can't see: moving around with the keyboard, and what's announced ──
const behaviour = [];
async function check(name, fn) {
  try { await fn(); behaviour.push(["ok", name]); console.log("  ok  ", name); }
  catch (e) { behaviour.push(["FAIL", name, e.message.split("\n")[0]]); console.log("  FAIL", name, "-", e.message.split("\n")[0]); }
}
const focused = (page) => page.evaluate(() => {
  const el = document.activeElement;
  return el ? { tag: el.tagName, id: el.id, label: el.getAttribute("aria-label") || el.textContent?.trim().slice(0, 40), role: el.getAttribute("role"), inDialog: !!el.closest("[role=dialog]"), inMenu: !!el.closest("[role=menu]") } : null;
});
const expectTrue = (cond, message) => { if (!cond) throw new Error(message); };

const kb = await user("keyboarder");
await admin.ctx.request.put(`${BASE}/api/servers/1/members/${kb.me.id}`);
await kb.page.locator("textarea.msg-input").waitFor(wait);
const k = kb.page;

await check("one main landmark and one level-one heading, naming the channel", async () => {
  expectTrue((await k.locator("main").count()) === 1, "not exactly one <main>");
  const h1 = await k.locator("h1").allInnerTexts();
  expectTrue(h1.length === 1 && h1[0].includes("general"), "h1: " + JSON.stringify(h1));
});

await check("a skip link comes first in the page, shows when focused, and moves focus to the main area", async () => {
  const first = await k.evaluate(() => {
    const stops = [...document.querySelectorAll("a[href], button, input, select, textarea, [tabindex]")]
      .filter((el) => !el.matches("[tabindex='-1'], :disabled") && !el.closest("[inert], [hidden]")
        && el.checkVisibility({ visibilityProperty: true })); // not the hidden loading splash
    return stops[0]?.className;
  });
  expectTrue(first?.includes("skip-link"), "the first thing Tab can reach is: " + first);
  const skip = k.locator("a.skip-link");
  expectTrue((await skip.boundingBox())?.y < 0, "the link shows even when it isn't focused");
  await skip.focus();
  const box = await skip.boundingBox();
  expectTrue(box && box.y >= 0 && box.y < 100, "the link is off screen when focused: " + JSON.stringify(box));
  await k.keyboard.press("Enter");
  expectTrue((await focused(k))?.id === "main", "focus is on " + JSON.stringify(await focused(k)));
});

await check("messages are a log that announces new ones, but not a channel's history as it opens", async () => {
  const log = k.locator("[role=log]");
  expectTrue((await log.getAttribute("aria-label")) === "Messages", "log has no name");
  await k.waitForTimeout(900); // history has loaded and settled
  expectTrue((await log.getAttribute("aria-live")) === "polite", "not announcing after load: " + (await log.getAttribute("aria-live")));
  // Switching channels: while the new history arrives it must be silent.
  await admin.ctx.request.post(`${BASE}/api/servers/1/channels`, { data: { name: "second", kind: "text" } });
  await k.locator(".channel-row:has-text('second')").waitFor(wait);
  await k.locator(".channel-row:has-text('second')").click();
  expectTrue((await k.locator("[role=log]").getAttribute("aria-live")) === "off", "history of a new channel would be read out");
  await k.waitForTimeout(900);
  expectTrue((await k.locator("[role=log]").getAttribute("aria-live")) === "polite", "announcing never resumed");
  await k.locator(".channel-row:has-text('general')").click();
  await k.waitForTimeout(900);
});

await check("a dialog takes focus, keeps Tab inside, and gives focus back when closed", async () => {
  const opener = k.locator("button[aria-label='User settings']");
  await opener.focus();
  await k.keyboard.press("Enter");
  await k.locator("[role=dialog]").first().waitFor(wait);
  expectTrue((await focused(k))?.inDialog, "focus didn't move into the dialog: " + JSON.stringify(await focused(k)));
  // Fast, like a person holding Tab. Focus is sampled a beat after each press: the dialog may take it
  // back a moment later, which is fine; what matters is where it settles.
  const stops = () => k.evaluate(() => [...document.querySelector("[role=dialog]").querySelectorAll("a[href], button, input:not([type=hidden]), select, textarea, [tabindex]")]
    .filter((el) => !el.matches(":disabled, [tabindex='-1']") && !el.closest("[hidden], [inert]"))
    .map((el) => `${el.tagName.toLowerCase()}${el.type ? "[" + el.type + "]" : ""}${el.checked ? "*" : ""} ${(el.getAttribute("aria-label") || el.textContent || el.value || "").trim().slice(0, 20)}${el.checkVisibility({ visibilityProperty: true }) ? "" : " (hidden)"}`));
  for (const key of ["Tab", "Shift+Tab"]) {
    for (let i = 0; i < 40; i++) {
      await k.keyboard.press(key);
      await k.waitForTimeout(20);
      if (!(await focused(k))?.inDialog) throw new Error(`${key} ${i + 1} left the dialog, to ${JSON.stringify(await focused(k))}; its stops: ${JSON.stringify(await stops())}`);
    }
  }
  await k.keyboard.press("Escape");
  await k.locator("[role=dialog]").first().waitFor({ state: "detached", ...wait });
  expectTrue((await focused(k))?.label === "User settings", "focus after closing: " + JSON.stringify(await focused(k)));
});

await check("the dialog is named by its heading", async () => {
  await k.locator("button[aria-label='User settings']").click();
  const dialog = k.locator("[role=dialog]").first();
  await dialog.waitFor(wait);
  const labelled = await dialog.evaluate((el) => { const id = el.getAttribute("aria-labelledby"); return id ? document.getElementById(id)?.textContent : null; });
  expectTrue(labelled === "User settings", "named by: " + labelled);
  await k.keyboard.press("Escape");
});

await check("the context menu opens from the keyboard, moves with the arrows, and returns focus", async () => {
  const row = k.locator(".voice-channel").first();
  await row.focus();
  await k.keyboard.press("Shift+F10");
  await k.locator("[role=menu]").waitFor(wait);
  const first = await focused(k);
  expectTrue(first?.inMenu && first.role === "menuitem", "focus not on a menu item: " + JSON.stringify(first));
  await k.keyboard.press("ArrowDown");
  const second = await focused(k);
  expectTrue(second?.inMenu, "ArrowDown left the menu");
  await k.keyboard.press("ArrowUp");
  expectTrue((await focused(k))?.label === first.label, "ArrowUp didn't come back");
  await k.keyboard.press("Escape");
  await k.locator("[role=menu]").waitFor({ state: "detached", ...wait });
  expectTrue((await focused(k))?.label?.includes("voice"), "focus after closing: " + JSON.stringify(await focused(k)));
});

await check("the emote picker takes focus in its search box and returns it to its button", async () => {
  const button = k.locator("button.emote-btn");
  await button.focus();
  await k.keyboard.press("Enter");
  await k.locator("[role=dialog][aria-label='Emotes and stickers']").waitFor(wait);
  expectTrue((await focused(k))?.tag === "INPUT", "focus: " + JSON.stringify(await focused(k)));
  await k.keyboard.press("Escape");
  await k.locator("[role=dialog][aria-label='Emotes and stickers']").waitFor({ state: "detached", ...wait });
  expectTrue((await focused(k))?.label === "Emotes and stickers", "focus after closing: " + JSON.stringify(await focused(k)));
});

await check("in a call, each other person is a button named with their state, and their menu opens by keyboard", async () => {
  await k.locator(".voice-channel").first().click();
  await k.locator(".voice-panel").waitFor({ timeout: 20000 });
  const row = k.locator("button.participant-row").first();
  await row.waitFor({ timeout: 15000 });
  const label = await row.getAttribute("aria-label");
  expectTrue(/^Voice settings for admin/.test(label ?? ""), "label: " + label);
  expectTrue((await k.locator("ul.participants > li").count()) >= 2, "participants aren't list items");
  expectTrue((await k.locator("ul.participants [role=button]").count()) === 0, "a list item still acts as a button");
  await row.focus();
  await k.keyboard.press("Enter");
  await k.locator("[role=dialog] input[type=range]").waitFor(wait);
  const f = await focused(k);
  expectTrue(f?.inDialog, "focus not in the volume menu: " + JSON.stringify(f));
  const menuBox = await k.locator("[role=dialog] input[type=range]").boundingBox();
  const rowBox = await row.boundingBox();
  expectTrue(menuBox && rowBox && Math.abs(menuBox.y - (rowBox.y + rowBox.height)) < 120, "menu opened far from the row, at " + JSON.stringify(menuBox));
  await k.keyboard.press("Escape");
  await k.locator("[role=dialog] input[type=range]").waitFor({ state: "detached", ...wait });
  expectTrue((await focused(k))?.label?.startsWith("Voice settings for admin"), "focus after closing: " + JSON.stringify(await focused(k)));
});

await check("people who ask for reduced motion get no sliding or fading", async () => {
  await k.emulateMedia({ reducedMotion: "reduce" });
  const ms = await k.evaluate(() => {
    const el = document.querySelector(".channel-row");
    return parseFloat(getComputedStyle(el).transitionDuration) * 1000;
  });
  expectTrue(ms < 1, "channel rows still transition for " + ms + "ms");
  await k.emulateMedia({ reducedMotion: "no-preference" });
});

await check("a muted person's button says so", async () => {
  const toggle = admin.page.locator("button[aria-label='Mute']").last();
  await toggle.click();
  await k.locator("button.participant-row[aria-label*='muted']").waitFor({ timeout: 10000 });
});

await k.locator("button[aria-label='Disconnect']").first().click().catch(() => {});

await browser.close();

const byRule = new Map();
for (const f of found) {
  const r = byRule.get(f.id) ?? { help: f.help, impact: f.impact, screens: new Map() };
  r.screens.set(f.screen, [...(r.screens.get(f.screen) ?? []), ...f.nodes]);
  byRule.set(f.id, r);
}
console.log(`\n${byRule.size} kind(s) of accessibility violation`);
for (const [id, r] of byRule) {
  const count = [...r.screens.values()].reduce((n, a) => n + a.length, 0);
  console.log(`\n[${r.impact}] ${id}: ${r.help} (${count} element(s) on ${r.screens.size} screen(s))`);
  for (const [screen, nodes] of r.screens) {
    console.log(`   ${screen}:`);
    for (const n of verbose ? nodes : [...new Set(nodes)].slice(0, 3)) console.log(`      ${n}`);
  }
}
const badBehaviour = behaviour.filter((b) => b[0] === "FAIL");
console.log(`\n${behaviour.length - badBehaviour.length}/${behaviour.length} keyboard and screen-reader checks passed`);
process.exit(byRule.size || badBehaviour.length ? 1 : 0);
