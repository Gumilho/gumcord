// Drives the real app, in real browsers, against a real backend and LiveKit (see run.sh): signing
// in, chat and its live updates, a two-person voice call, the soundboard, settings and signing out.
// SHOTS=<dir> also saves screenshots of the call and the sign-in screen there.
import { chromium } from "playwright-core";

const BASE = "http://127.0.0.1:18090";
const SHOTS = process.env.SHOTS;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM,
  args: ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
    "--disable-features=WebRtcHideLocalIpsWithMdns", "--autoplay-policy=no-user-gesture-required"],
});

const problems = [];
const results = [];
async function step(name, fn) {
  try { await fn(); results.push(["ok", name]); console.log("  ok  ", name); }
  catch (e) { results.push(["FAIL", name, e.message.split("\n").slice(0,2).join(" ")]); console.log("  FAIL", name, "-", e.message.split("\n").slice(0,2).join(" ")); }
}

async function user(name, admin = false) {
  const ctx = await browser.newContext({ locale: "en-US", permissions: ["microphone"], viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => problems.push(`${name} pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") problems.push(`${name} console: ${m.text()}`); });
  // Booted means the sidebar is up and the live socket is open and has said something.
  const socketReady = new Promise((resolve) => page.on("websocket", (ws) => ws.once("framereceived", resolve)));
  await page.goto(`${BASE}/api/auth/dev?name=${name}${admin ? "&admin=1" : ""}`);
  await page.locator("nav.channels").waitFor({ timeout: 15000 });
  await socketReady;
  await page.waitForTimeout(300);
  const me = await (await ctx.request.get(`${BASE}/api/me`)).json();
  return { name, ctx, page, me };
}


function wav(seconds = 0.2, rate = 8000) {
  const n = Math.floor(seconds * rate), b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  return b;
}
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const wait = { timeout: 8000 };
const admin = await user("admin", true);
const alice = await user("alice");
const bob = await user("bob");
const text = (u, s) => u.page.locator(`.message:has-text("${s}")`);

await step("signed-in user with no servers sees an empty app", async () => {
  await alice.page.locator(".chat-body, .empty, main").first().waitFor(wait);
  if (await alice.page.locator(".channel-row").count()) throw new Error("channels visible without a server");
});

await step("adding a member makes the server appear live", async () => {
  for (const u of [alice, bob]) {
    const r = await admin.ctx.request.put(`${BASE}/api/servers/1/members/${u.me.id}`);
    if (!r.ok()) throw new Error("add member: " + r.status());
  }
  await alice.page.locator(".channel-row:has-text('general')").waitFor(wait);
  await bob.page.locator(".channel-row:has-text('general')").waitFor(wait);
});

await step("members can open the text channel and send messages", async () => {
  await alice.page.locator(".channel-row:has-text('general')").click();
  await bob.page.locator(".channel-row:has-text('general')").click();
  const input = alice.page.locator("textarea.msg-input");
  await input.waitFor(wait);
  await input.fill("hello world");
  await input.press("Enter");
  await text(alice, "hello world").waitFor(wait);
  await text(bob, "hello world").waitFor(wait);
  if ((await input.inputValue()) !== "") throw new Error("draft not cleared after sending");
});

await step("replies arrive both ways", async () => {
  const input = bob.page.locator("textarea.msg-input");
  await input.fill("reply from bob");
  await input.press("Enter");
  await text(alice, "reply from bob").waitFor(wait);
});

await step("edits and deletes reach other clients live", async () => {
  const msgs = await (await alice.ctx.request.get(`${BASE}/api/channels/1/messages`)).json();
  const mine = msgs.find((m) => m.content === "hello world");
  const r = await alice.ctx.request.patch(`${BASE}/api/messages/${mine.id}`, { data: { content: "hello edited" } });
  if (!r.ok()) throw new Error("edit: " + r.status());
  await text(bob, "hello edited").waitFor(wait);
  await alice.ctx.request.delete(`${BASE}/api/messages/${mine.id}`);
  await text(bob, "hello edited").waitFor({ state: "detached", ...wait });
});

await step("Arrow-up edits your last message in the UI", async () => {
  const input = alice.page.locator("textarea.msg-input");
  await input.fill("typo mesage");
  await input.press("Enter");
  await text(bob, "typo mesage").waitFor(wait);
  await input.press("ArrowUp");
  const editor = alice.page.locator(".message.editing textarea, .message.editing input").first();
  await editor.waitFor(wait);
  await editor.fill("typo message fixed");
  await editor.press("Enter");
  await text(bob, "typo message fixed").waitFor(wait);
});

await step("an uploaded picture can be attached and sent", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  await alice.page.locator('input[type="file"]').first().setInputFiles({ name: "dot.png", mimeType: "image/png", buffer: png });
  await alice.page.locator("img[alt='dot.png']").waitFor(wait);
  const input = alice.page.locator("textarea.msg-input");
  await input.fill("with a picture");
  await input.press("Enter");
  await text(bob, "with a picture").locator("img").first().waitFor(wait);
});


await step("muting a channel shows an icon and is remembered after a reload", async () => {
  const toggle = alice.page.locator("button.mute-toggle");
  await toggle.click();
  await alice.page.locator("button.mute-toggle[aria-pressed='true']").waitFor(wait);
  await alice.page.locator(".channel-row.muted .ch-muted").waitFor(wait);
  await alice.page.reload();
  await alice.page.locator(".channel-row.muted .ch-muted").waitFor(wait);
  await alice.page.locator("button.mute-toggle").click();
  await alice.page.locator(".channel-row.muted").waitFor({ state: "detached", ...wait });
});

await step("an uploaded emote shows up in messages for everyone", async () => {
  const r = await admin.ctx.request.post(`${BASE}/api/servers/1/emotes`, { multipart: { name: "dot", file: { name: "dot.png", mimeType: "image/png", buffer: PNG } } });
  if (!r.ok()) throw new Error("add emote: " + r.status() + " " + await r.text());
  await alice.page.waitForTimeout(500);
  const input = alice.page.locator("textarea.msg-input");
  await input.fill("look :dot: here");
  await input.press("Enter");
  await bob.page.locator(".message:has-text('look') img.emote").waitFor(wait);
});

await step("settings: changing your name updates the sidebar, and you can reset it", async () => {
  await alice.page.locator("button[aria-label='User settings']").click();
  const dialog = alice.page.locator("[role='dialog']").first();
  await dialog.waitFor(wait);
  await dialog.locator("input[maxlength='32']").fill("Alice Two");
  await dialog.getByRole("button", { name: "Save" }).click();
  await alice.page.locator(".self-name:has-text('Alice Two')").waitFor(wait);
  await dialog.getByText("Use my PocketID name").click();
  await alice.page.locator(".self-name:has-text('alice')").waitFor(wait);
});

await step("settings: input mode and noise suppression are remembered on this device", async () => {
  const dialog = alice.page.locator("[role='dialog']").first();
  await dialog.getByLabel("Push to talk").check();
  await dialog.locator("select").filter({ has: alice.page.locator("option[value='standard']") }).selectOption("standard");
  const saved = await alice.page.evaluate(() => ({
    keybinds: JSON.parse(localStorage.getItem("gc_keybinds") || "null"),
    noise: localStorage.getItem("gc_noise_suppression"),
  }));
  if (!saved.keybinds?.pushToTalk) throw new Error("push to talk not saved: " + JSON.stringify(saved));
  if (saved.noise !== "standard") throw new Error("noise level not saved: " + JSON.stringify(saved));
  await dialog.getByLabel("Voice activity").check();
  await alice.page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached", ...wait });
});

await step("alice joins voice and sees the connected panel", async () => {
  await alice.page.locator(".voice-channel").first().click();
  await alice.page.locator(".voice-panel .voice-channel-name, .voice-panel .audio-blocked").first().waitFor({ timeout: 20000 });
});

await step("bob joins and each sees the other in the channel", async () => {
  await bob.page.locator(".voice-channel").first().click();
  await bob.page.locator(".voice-panel").waitFor({ timeout: 20000 });
  await alice.page.locator("nav.channels").getByText("bob", { exact: true }).waitFor({ timeout: 15000 });
  await bob.page.locator("nav.channels").getByText("alice", { exact: true }).waitFor({ timeout: 15000 });
});

await step("mute and deafen toggle, with labels", async () => {
  const mute = alice.page.locator(".user-panel button[aria-label='Mute'], button[aria-label='Mute']").last();
  await mute.click();
  await alice.page.locator("button[aria-label='Unmute'][aria-pressed='true']").last().waitFor(wait);
  await alice.page.locator("button[aria-label='Deafen']").last().click();
  await alice.page.locator("button[aria-label='Undeafen'][aria-pressed='true']").last().waitFor(wait);
  await alice.page.locator("button[aria-label='Undeafen']").last().click();
  await alice.page.locator("button[aria-label='Deafen'][aria-pressed='false']").last().waitFor(wait);
});

await step("the call view shows tiles for both people", async () => {
  await alice.page.locator(".voice-channel.in-voice").first().click();
  await alice.page.locator(".tile").nth(1).waitFor(wait);
  const tiles = await alice.page.locator(".tile").count();
  if (tiles < 2) throw new Error(`${tiles} tiles`);
  if (SHOTS) await alice.page.screenshot({ path: `${SHOTS}/call.png` });
});

await step("clicking another person's tile opens their volume menu", async () => {
  await alice.page.locator(".tile.clickable").first().click();
  await alice.page.locator("input[type='range']").first().waitFor(wait);
  await alice.page.keyboard.press("Escape");
  await alice.page.locator("input[type='range']").first().waitFor({ state: "detached", ...wait });
});


await step("per-person volume is saved to the server", async () => {
  await alice.page.locator(".tile.clickable").first().click();
  const slider = alice.page.locator("input[type='range']").first();
  await slider.waitFor(wait);
  await slider.fill("150");
  await alice.page.waitForTimeout(1200);
  const list = await (await alice.ctx.request.get(`${BASE}/api/user-audio`)).json();
  const entry = list.find((a) => a.target_id === bob.me.id);
  if (!entry || Math.abs(entry.volume - 1.5) > 0.01) throw new Error("not saved: " + JSON.stringify(list));
  await alice.page.keyboard.press("Escape");
});

await step("soundboard lists the server's sounds and plays one", async () => {
  const r = await admin.ctx.request.post(`${BASE}/api/servers/1/sounds`, { multipart: { name: "blip", file: { name: "blip.wav", mimeType: "audio/wav", buffer: wav() } } });
  if (!r.ok()) throw new Error("add sound: " + r.status() + " " + await r.text());
  await alice.page.locator("button[aria-label='Soundboard']").first().click();
  const board = alice.page.locator("[role='dialog'][aria-label='Soundboard']");
  await board.waitFor(wait);
  await board.getByText("blip", { exact: true }).first().waitFor(wait);
  await board.getByText("blip", { exact: true }).first().click();
  await alice.page.waitForTimeout(300);
  await alice.page.keyboard.press("Escape");
});

await step("a refresh while in a call rejoins it", async () => {
  await alice.page.reload();
  await alice.page.locator(".voice-panel").waitFor({ timeout: 25000 });
});

await step("leaving the call removes you from others' lists", async () => {
  await alice.page.locator("button[aria-label='Disconnect']").first().click();
  await alice.page.locator(".voice-panel").waitFor({ state: "detached", ...wait });
  await bob.page.locator("nav.channels").getByText("alice", { exact: true }).waitFor({ state: "detached", timeout: 15000 });
});

await step("removing bob from the server clears his view and ends his call", async () => {
  const r = await admin.ctx.request.delete(`${BASE}/api/servers/1/members/${bob.me.id}`);
  if (!r.ok()) throw new Error("remove member " + r.status());
  await bob.page.locator(".channel-row:has-text('general')").waitFor({ state: "detached", timeout: 15000 });
  await bob.page.locator(".voice-panel").waitFor({ state: "detached", timeout: 15000 });
});

await step("logging out shows the sign-in screen", async () => {
  await alice.page.locator("button[aria-label='Log out']").click();
  await alice.page.locator(".channels").waitFor({ state: "detached", ...wait });
  if (SHOTS) await alice.page.screenshot({ path: `${SHOTS}/signed-out.png` });
});

await browser.close();
const bad = results.filter((r) => r[0] === "FAIL");
// Console errors that are expected: pages loading before sign-in, and LiveKit's data channels closing
// when someone is removed from a call.
const noise = (p) => /favicon|Failed to load resource.*(401|404)|ResizeObserver|DataChannel|data channel/.test(p);
const real = [...new Set(problems.filter((p) => !noise(p)))];
const uncaught = real.filter((p) => p.includes("pageerror"));
console.log(`\n${results.length - bad.length}/${results.length} steps passed`);
if (real.length) console.log("console/page errors:\n  " + real.join("\n  "));
process.exit(bad.length || uncaught.length ? 1 : 0);
