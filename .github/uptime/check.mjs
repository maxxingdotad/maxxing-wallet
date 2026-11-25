#!/usr/bin/env node
/**
 * One uptime pass, run by .github/workflows/uptime.yml every five minutes (and testable on its own):
 *
 *   node .github/uptime/check.mjs <targets.json> <state.json>
 *
 * Each target is asked twice, 20 seconds apart, before it counts as down. A target going down is said once, again every six hours
 * while it stays down, and once when it is back (with how long it lasted). Messages go to Telegram and/or Discord when their
 * variables are set. Writes `news=down` to $GITHUB_OUTPUT when something went down (or is due a reminder) so the run fails and GitHub
 * emails it. The public run log shows a count only, never which target or why. Needs Node 18+ and nothing else.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const REMIND_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = Number(process.env.UPTIME_RETRY_MS ?? 20_000);
const TIMEOUT_MS = 15_000;
/** The header /health/watch reads its shared token from (repository secret UPTIME_WATCH_TOKEN). */
const WATCH_HEADER = "x-maxxing-watch";

/** Telegram's Markdown refuses raw _ * ` [ (an error code like UND_ERR_CONNECT_TIMEOUT): every dynamic part is escaped. */
export const escapeMarkdown = text => String(text).replace(/([_*`[\]])/g, "\\$1");

export async function probe(target, request = fetch, env = process.env) {
  const started = Date.now();
  const headers = { "user-agent": "maxxing-uptime/1 (+https://github.com/maxxingdotad/maxxing-wallet)" };
  if (target.watchToken && env.UPTIME_WATCH_TOKEN) headers[WATCH_HEADER] = env.UPTIME_WATCH_TOKEN;
  try {
    const response = await request(target.url, { redirect: "follow", headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const ok = response.status === (target.expect ?? 200) || (!target.expect && response.status < 400);
    return { ok, detail: `HTTP ${response.status}`, ms: Date.now() - started };
  } catch (error) {
    return { ok: false, detail: error?.name === "TimeoutError" ? `no answer in ${TIMEOUT_MS / 1000} s` : String(error?.cause?.code ?? error?.message ?? error).slice(0, 80), ms: Date.now() - started };
  }
}

const minutes = ms => { const m = Math.max(1, Math.round(ms / 60_000)); return m < 120 ? `${m} min` : `${Math.round(m / 60)} h`; };
const e = escapeMarkdown;

/** What to say for one target, given its result now and what was known before. Pure: the tests drive it. */
export function decide(target, result, before, now) {
  const state = { ...(before ?? { down: false }) };
  if (!result.ok) {
    if (!state.down) return { state: { down: true, since: now, notifiedAt: now, detail: result.detail }, message: `🔴 *${e(target.name)} is down*\n${e(target.url)}\n${e(result.detail)}${target.hint ? `\n${e(target.hint)}` : ""}`, news: "down" };
    if (now - (state.notifiedAt ?? 0) > REMIND_MS) return { state: { ...state, notifiedAt: now, detail: result.detail }, message: `🔴 *Still down: ${e(target.name)}*\n${e(target.url)}\n${e(result.detail)} · for ${minutes(now - state.since)}`, news: "down" };
    return { state: { ...state, detail: result.detail }, message: null, news: null };
  }
  if (state.down) return { state: { down: false }, message: `✅ *${e(target.name)} is back*\nDown for ${minutes(now - state.since)}.`, news: "up" };
  return { state: { down: false }, message: null, news: null };
}

export async function notify(text, env = process.env, request = fetch) {
  const sent = [];
  if (env.UPTIME_TELEGRAM_BOT_TOKEN && env.UPTIME_TELEGRAM_CHAT_ID) {
    const post = markdown => request(`https://api.telegram.org/bot${env.UPTIME_TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: env.UPTIME_TELEGRAM_CHAT_ID, text, ...(markdown ? { parse_mode: "Markdown" } : {}) }), signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    let response = await post(true);
    // 400: Telegram refused the formatting. The alert still goes out, as plain text.
    if (response?.status === 400) response = await post(false);
    sent.push(`telegram ${response?.ok ? "sent" : "failed"}`);
  }
  if (env.UPTIME_DISCORD_WEBHOOK_URL && /^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(env.UPTIME_DISCORD_WEBHOOK_URL)) {
    const response = await request(env.UPTIME_DISCORD_WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: text, allowed_mentions: { parse: [] } }), redirect: "error", signal: AbortSignal.timeout(10_000) }).catch(() => null);
    sent.push(`discord ${response?.ok ? "sent" : "failed"}`);
  }
  return sent;
}

export async function run(targetsFile, stateFile, { request = fetch, env = process.env, now = () => Date.now(), wait = ms => new Promise(r => setTimeout(r, ms)), log = console.log } = {}) {
  const { targets } = JSON.parse(readFileSync(targetsFile, "utf8"));
  let previous = {};
  try { if (existsSync(stateFile)) previous = JSON.parse(readFileSync(stateFile, "utf8")).targets ?? {}; } catch { /* a broken state file starts fresh */ }
  let results = await Promise.all(targets.map(target => probe(target, request, env)));
  // A second try for anything that failed, so one dropped packet pages nobody.
  if (results.some(result => !result.ok)) {
    await wait(RETRY_MS);
    results = await Promise.all(targets.map((target, i) => results[i].ok ? results[i] : probe(target, request, env)));
  }
  const next = {}, messages = [];
  let news = null;
  targets.forEach((target, i) => {
    const decision = decide(target, results[i], previous[target.name], now());
    next[target.name] = decision.state;
    if (decision.message) messages.push(decision.message);
    if (decision.news === "down") news = "down";
  });
  writeFileSync(stateFile, JSON.stringify({ checkedAt: new Date(now()).toISOString(), targets: next }, null, 2));
  // The run log is public: a count only. Which target and why go to the private channels.
  const down = results.filter(result => !result.ok).length;
  log(`${targets.length} checked, ${down} down${messages.length ? `, ${messages.length} ${messages.length === 1 ? "message" : "messages"}` : ""}`);
  if (messages.length) {
    const sent = await notify(messages.join("\n\n"), env, request);
    log(sent.length ? sent.join(", ") : "no channel set: the failed run is the alert");
  }
  if (news && env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `news=${news}\n`);
  return { news, messages, state: next };
}

if (process.argv[1]?.endsWith("check.mjs")) {
  const [targetsFile, stateFile] = process.argv.slice(2);
  if (!targetsFile || !stateFile) { console.error("Usage: node check.mjs <targets.json> <state.json>"); process.exit(2); }
  // The state file must exist afterwards even if something above throws, so the workflow can save it.
  run(targetsFile, stateFile).catch(error => { console.error(error?.message ?? "uptime check failed"); if (!existsSync(stateFile)) writeFileSync(stateFile, "{}"); process.exit(1); });
}
