# Uptime check

`.github/workflows/uptime.yml` asks MAXXING's public addresses ([targets.json](targets.json)) whether they answer, every five
minutes, from GitHub's servers. It is how the MAXXING operator hears about an outage when MAXXING's own servers, which run every
other alert, are down. It is not part of the SDK and sends nothing anywhere except to the operator's own channels.

- Each address is asked twice, 20 seconds apart, before it counts as down.
- A problem is said once, again every six hours while it lasts, and once when it is over.
- `api.maxxing.ad/health/watch` answers 200 only while the API's own minute checks run, so this also notices when the inside alerts stop.
- The run log shows only how many addresses are down; which ones, and why, go to the operator's channels.
- `UPTIME_WATCH_TOKEN` (optional repository secret) is sent to `/health/watch` when the API requires it.
- With the optional repository secrets `UPTIME_TELEGRAM_BOT_TOKEN` + `UPTIME_TELEGRAM_CHAT_ID` and/or `UPTIME_DISCORD_WEBHOOK_URL`
  the messages go there. Without them a run fails when something goes down, and GitHub emails that failure.

Run it locally: `node .github/uptime/check.mjs .github/uptime/targets.json /tmp/uptime-state.json`.
