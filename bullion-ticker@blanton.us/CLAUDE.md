# Bullion Ticker

GNOME Shell extension (uuid `bullion-ticker@blanton.us`, currently v0.3.2). A desktop widget showing gold, silver, platinum, palladium, indices and stocks: price, day change (green up / red down), and an expandable chart (1D/3D/1W/1M/1Y). Trackers and colors are customizable in prefs. Built for Phillip's own use; may be published on extensions.gnome.org. Read `README.md` first for features, install and data sources.

## Environment

- Zorin OS, GNOME Shell 46. Previously on Wayland, switched to X11 (`WaylandEnable=false` in `/etc/gdm3/custom.conf`).
- Reloading: X11 uses Alt+F2, `r`. Wayland caches extension modules, so a logout/login is required after any code change (disable/enable re-runs the old code, and an ERROR state sticks until relogin).
- Widget layer is `above` (`addChrome`). The `desktop` layer (`Main.layoutManager._backgroundGroup`) is blocked by Zorin's `zorin-desktop-icons@zorinos.com` window, which swallows clicks.
- Schema changes need `glib-compile-schemas` on the installed `schemas` dir.
- Logs: `journalctl -b -o cat /usr/bin/gnome-shell | grep "Bullion Ticker"`
- The development sandbox could not reach Yahoo, gold-api, Twelve Data or stooq, so live data was never testable by Claude. Network behavior is verified by Phillip on his machine (curl tests, screenshots, journal output).

## Architecture

- Pure modules, no GNOME imports, unit-testable with plain Node (copy to `.mjs` with import paths adjusted): `yahoo.js`, `chart.js`, `providers.js`, `history.js`, `twelvedata.js`.
- GNOME-dependent: `extension.js` (widget, refresh logic, providers glue, drag, layers) and `prefs.js` (Adw/Gtk4 preferences).
- Settings: GSettings schema `org.gnome.shell.extensions.bullion-ticker`; trackers are a JSON string key.
- Charts are drawn with Cairo in an `St.DrawingArea`. Recorder-source charts use a time-scaled x-axis (`xRange`); Yahoo/Twelve Data charts are index-scaled.

### Data chain (first provider that answers wins)

1. Yahoo chart API (`query1`, then `query2`). Phillip's network gets HTTP 429, so the code backs off 15 minutes.
2. Twelve Data (free key, entered in prefs). Free plan: gold `XAU/USD` and US stocks/ETFs only, 8 credits/min, 800/day. Calls are serialized 8 s apart and charts are cached per range. A 429 starts a cool-down (90 s per-minute limit, until 00:01 UTC for the daily limit) with an automatic retry about 100 s later.
3. gold-api.com (keyless, current price only). A local recorder at `~/.local/share/bullion-ticker/history.json` (35 days raw, thinned to daily up to 400 days) builds history for silver/Pt/Pd over time, with a rolling 24h change.

Prefixes force a source: `GOLDAPI:XAU|XAG|XPT|XPD`, `TD:<symbol>`.

### Gotchas

- libsoup3: `msg.get_status()` throws for unlisted codes such as 429. Always use `msg.status_code`.
- Twelve Data signals exhausted credits with HTTP 429, sometimes with a non-JSON body; `parseTdResponse` handles this.
- Settings changes rebuild the UI; `_refreshAll(onlyStale)` must be used there so credits are not burned.

## Status

v0.3.2 added the Twelve Data 429 cool-down and retry, only-stale refresh, a ⚠ stale-price marker, and journal logging. Not yet confirmed on Phillip's machine: that SLV (via Twelve Data) loads after that fix.

## Open items

1. Verify 0.3.2 on X11 and check the journal for "Bullion Ticker" lines.
2. Silver/platinum/palladium history is only what has been recorded. Consider seeding daily history from another free source (MetalCharts was floated; its response format needs testing from Phillip's machine first).
3. The Dow index value is unavailable from free providers (the DIA ETF preset is the stand-in).
4. Desktop layer is blocked by Zorin's icons window. Options: insert above that window, or disable the Zorin icons extension.
5. The cause of the Yahoo 429 is unconfirmed (a phone-hotspot curl test was never reported).
6. License is GPL-2.0-or-later (done). Prep for extensions.gnome.org review: trim `shell-version` to versions actually tested, review Yahoo's terms, disclose the private `_backgroundGroup` use.
7. Never commit API keys. Phillip pasted a Twelve Data key into an earlier chat and should regenerate it.

## Working preferences

- Phillip is Linux-only: never suggest Windows or Microsoft products.
- Chain shell commands with `&&`.
- Documents, if any are needed, go in ODF formats, not Microsoft formats.
