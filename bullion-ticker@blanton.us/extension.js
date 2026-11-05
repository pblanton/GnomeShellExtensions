import Cairo from 'gi://cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {RANGES, RANGE_ORDER, buildUrl, parseChart, dayChange, fmtNum} from './yahoo.js';
import {drawChart, indexAt, timeIndexAt} from './chart.js';
import {goldapiCode, goldapiOnly, goldapiUrl, parseGoldApi} from './providers.js';
import {WINDOW_SECONDS, addSample, change24h, mergeStore, prune, windowSeries} from './history.js';
import {TD_RANGES, isDailyLimit, parseTdResponse, tdChart, tdOnly, tdSymbol, tdToday, tdUrl} from './twelvedata.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');
Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');

const YAHOO_BACKOFF_MS = 15 * 60 * 1000;
const TD_MIN_SPACING_MS = 8000;   // free plan: 8 credits per minute

const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';

// ---------- small helpers ----------

function parseColor(str, fallback) {
    if (!str)
        return fallback;
    const s = str.trim();
    let m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s);
    if (m) {
        const n = parseInt(m[1], 16);
        return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255,
            m[2] ? parseInt(m[2], 16) / 255 : 1];
    }
    m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s);
    if (m) {
        return [m[1] / 255, m[2] / 255, m[3] / 255,
            m[4] !== undefined ? parseFloat(m[4]) : 1];
    }
    return fallback;
}

function css(c) {
    return `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${c[3].toFixed(3)})`;
}

function readableOn(c) {
    const lum = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    return lum > 0.55 ? [0, 0, 0, 0.85] : [1, 1, 1, 1];
}

function formatTime(ts, fmt) {
    const dt = GLib.DateTime.new_from_unix_local(ts);
    return dt ? dt.format(fmt).trim() : '';
}

// msg.get_status() throws for codes libsoup has no enum value for (e.g. 429),
// so read the plain numeric property and fall back to parsing the error text.
function statusOf(msg) {
    try {
        const s = msg.status_code;
        if (typeof s === 'number')
            return s;
    } catch (_e) {
        // fall through
    }
    try {
        return msg.get_status();
    } catch (e) {
        const m = /^(\d+) is not a valid value/.exec(e.message ?? '');
        return m ? parseInt(m[1], 10) : 0;
    }
}

function shortErr(msg) {
    if (!msg)
        return '';
    if (/429/.test(msg))
        return 'Rate limited (HTTP 429)';
    return msg.length > 34 ? `${msg.slice(0, 33)}…` : msg;
}

function isCancelled(e) {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

// ---------- extension ----------

export default class BullionTicker extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._session = new Soup.Session({timeout: 20, idle_timeout: 20, user_agent: UA});
        this._cancellable = new Gio.Cancellable();

        this._quotes = new Map();   // symbol -> {price, prevClose, change, pct, marketTime}
        this._charts = new Map();   // `${symbol}|${range}` -> {points}
        this._errors = new Map();   // symbol -> message
        this._loading = new Set();  // `${symbol}|${range}`
        this._ranges = new Map();   // symbol -> range key chosen in this session
        this._expanded = new Set(this._settings.get_strv('expanded'));
        this._lastUpdated = null;

        // Fallback-provider state: where each symbol's data currently comes from,
        // when Yahoo may be tried again, and the locally recorded price history.
        this._src = new Map();      // symbol -> 'yahoo' | 'td' | 'recorder'
        this._yahooBlockedUntil = 0;
        this._tdBlockedUntil = 0;
        this._retryId = 0;
        this._tdLast = 0;
        this._tdChain = Promise.resolve();
        this._tdChartAt = new Map();    // `${symbol}|${range}` -> ms when last fetched from Twelve Data
        this._sleepIds = new Set();
        this._store = {};
        this._storeLoaded = false;
        this._saving = false;
        this._saveId = 0;
        this._loadStore();

        this._rows = [];
        this._refreshId = 0;
        this._rebuildId = 0;
        this._dragging = false;
        this._grab = null;

        this._build();

        this._settingsId = this._settings.connect('changed', (_s, key) => this._onSettingChanged(key));
        this._overviewIds = [
            Main.overview.connect('showing', () => this._actor?.hide()),
            Main.overview.connect('hidden', () => this._actor?.show()),
        ];
        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => this._place());

        this._startTimer();
        this._refreshAll();
    }

    disable() {
        this._cancellable?.cancel();
        this._session?.abort();

        if (this._refreshId) GLib.source_remove(this._refreshId);
        if (this._rebuildId) GLib.source_remove(this._rebuildId);
        if (this._saveId) GLib.source_remove(this._saveId);
        if (this._recorderId) GLib.source_remove(this._recorderId);
        if (this._retryId) GLib.source_remove(this._retryId);
        this._recorderId = 0;
        this._retryId = 0;
        this._refreshId = 0;
        this._rebuildId = 0;
        this._saveId = 0;
        for (const id of this._sleepIds ?? [])
            GLib.source_remove(id);
        this._sleepIds = null;
        this._saveStoreSync();

        if (this._settingsId) this._settings.disconnect(this._settingsId);
        this._settingsId = 0;
        for (const id of this._overviewIds ?? [])
            Main.overview.disconnect(id);
        this._overviewIds = null;
        if (this._monitorsId) Main.layoutManager.disconnect(this._monitorsId);
        this._monitorsId = 0;

        this._teardown();

        this._session = null;
        this._cancellable = null;
        this._settings = null;
        this._quotes = this._charts = this._errors = this._loading = this._ranges = this._expanded = null;
        this._src = this._store = this._tdChartAt = null;
    }

    // ---------- recorded history (used when a source has no history of its own) ----------

    _storePath() {
        return GLib.build_filenamev([GLib.get_user_data_dir(), 'bullion-ticker', 'history.json']);
    }

    async _loadStore() {
        try {
            const [bytes] = await Gio.File.new_for_path(this._storePath())
                .load_contents_async(this._cancellable);
            if (!this._store)
                return;
            mergeStore(this._store, JSON.parse(new TextDecoder().decode(bytes)));
        } catch (e) {
            if (isCancelled(e) || !this._store)
                return;
            if (!(e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)))
                console.error(`Bullion Ticker: could not read history: ${e.message}`);
        }
        if (!this._store)
            return;
        this._storeLoaded = true;
        this._afterAll();
    }

    _storeJson() {
        const now = Math.floor(Date.now() / 1000);
        for (const k of Object.keys(this._store))
            this._store[k] = prune(this._store[k], now);
        return JSON.stringify(this._store);
    }

    _saveStoreSoon() {
        if (this._saveId)
            return;
        this._saveId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
            this._saveId = 0;
            this._saveStore();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _saveStore() {
        if (!this._storeLoaded || this._saving || !this._store)
            return;
        this._saving = true;
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(this._storePath()), 0o755);
            const data = new TextEncoder().encode(this._storeJson());
            await Gio.File.new_for_path(this._storePath()).replace_contents_bytes_async(
                new GLib.Bytes(data), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, this._cancellable);
        } catch (e) {
            if (!isCancelled(e))
                console.error(`Bullion Ticker: could not save history: ${e.message}`);
        } finally {
            this._saving = false;
        }
    }

    // Last-chance synchronous save while the extension is being disabled.
    _saveStoreSync() {
        if (!this._storeLoaded || !this._store)
            return;
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(this._storePath()), 0o755);
            GLib.file_set_contents(this._storePath(), this._storeJson());
        } catch (e) {
            console.error(`Bullion Ticker: could not save history: ${e.message}`);
        }
    }

    // ---------- settings ----------

    _trackers() {
        try {
            const arr = JSON.parse(this._settings.get_string('trackers'));
            if (!Array.isArray(arr))
                return [];
            return arr
                .filter(t => t && typeof t.symbol === 'string' && t.symbol.trim())
                .map(t => ({
                    label: String(t.label || t.symbol),
                    symbol: t.symbol.trim(),
                    prefix: String(t.prefix ?? ''),
                    decimals: Number.isInteger(t.decimals) ? Math.min(6, Math.max(0, t.decimals)) : 2,
                }));
        } catch (e) {
            console.error(`Bullion Ticker: bad trackers setting: ${e.message}`);
            return [];
        }
    }

    _onSettingChanged(key) {
        if (key === 'expanded')
            return;
        if (key === 'pos-x' || key === 'pos-y') {
            if (this._settings.get_int(key) < 0)
                this._place();
            return;
        }
        if (key === 'refresh-minutes') {
            this._startTimer();
            return;
        }
        // Everything else (trackers, colors, size, layer...) rebuilds the widget.
        if (this._rebuildId)
            return;
        this._rebuildId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this._rebuildId = 0;
            this._teardown();
            this._build();
            this._refreshAll(true);
            return GLib.SOURCE_REMOVE;
        });
    }

    _startTimer() {
        if (this._refreshId)
            GLib.source_remove(this._refreshId);
        if (this._recorderId)
            GLib.source_remove(this._recorderId);
        const mins = this._settings.get_int('refresh-minutes');
        this._refreshId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, mins * 60, () => {
            this._refreshAll();
            return GLib.SOURCE_CONTINUE;
        });

        // Metals on the recorder source (gold-api.com has no quota) are sampled every
        // 5 minutes so their locally built charts have more detail than the main interval.
        this._recorderId = 0;
        if (mins > 5) {
            this._recorderId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5 * 60, () => {
                this._rows.forEach((r, i) => {
                    if (this._src?.get(r.tracker.symbol) === 'recorder')
                        this._refreshQuote(i);
                });
                return GLib.SOURCE_CONTINUE;
            });
        }
    }

    // ---------- building the widget ----------

    _build() {
        const s = this._settings;
        const c = this._c = {
            bg: parseColor(s.get_string('bg-color'), [0.09, 0.09, 0.125, 0.82]),
            text: parseColor(s.get_string('text-color'), [0.94, 0.94, 0.96, 1]),
            muted: parseColor(s.get_string('muted-color'), [0.94, 0.94, 0.96, 0.55]),
            up: parseColor(s.get_string('up-color'), [0.2, 0.83, 0.43, 1]),
            down: parseColor(s.get_string('down-color'), [1, 0.36, 0.36, 1]),
            accent: parseColor(s.get_string('accent-color'), [0.83, 0.69, 0.22, 1]),
            line: parseColor(s.get_string('line-color'), [0.83, 0.69, 0.22, 1]),
        };
        const fs = this._fs = s.get_int('font-size');
        const width = s.get_int('width');
        const radius = s.get_int('corner-radius');
        const family = this._family = s.get_string('font-family').replace(/["\\;]/g, '');
        const fontCss = family ? `font-family: "${family}";` : '';

        this._actor = new St.BoxLayout({
            vertical: true,
            reactive: true,
            width,
            style: `background-color: ${css(c.bg)}; border-radius: ${radius}px; ` +
                `border: 1px solid ${css([c.text[0], c.text[1], c.text[2], 0.10])}; ` +
                `padding: 8px 10px 10px 10px; color: ${css(c.text)}; ` +
                `font-size: ${fs}px; ${fontCss}`,
        });

        this._buildHeader();

        this._rows = [];
        const trackers = this._trackers();
        if (!trackers.length) {
            this._actor.add_child(new St.Label({
                text: 'No trackers yet. Open preferences (\u2699) to add some.',
                style: `color: ${css(c.muted)}; padding: 10px 4px;`,
            }));
        }
        trackers.forEach((t, i) => this._buildTracker(t, i));

        this._attach();
    }

    _buildHeader() {
        const c = this._c;
        const header = this._header = new St.BoxLayout({
            reactive: true,
            x_expand: true,
            style: 'padding: 0 2px 4px 2px; spacing: 6px;',
        });
        const title = new St.Label({
            text: 'MARKETS',
            y_align: Clutter.ActorAlign.CENTER,
            style: `font-weight: 700; font-size: ${this._fs - 3}px; color: ${css(c.muted)};`,
        });
        title.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        header.add_child(title);
        header.add_child(new St.Widget({x_expand: true}));

        this._updatedLabel = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            style: `font-size: ${this._fs - 3}px; color: ${css(c.muted)};`,
        });
        header.add_child(this._updatedLabel);

        const mkBtn = (icon, onClick) => {
            const b = new St.Button({
                style_class: 'bullion-btn',
                can_focus: true,
                reactive: true,
                child: new St.Icon({
                    icon_name: icon,
                    icon_size: this._fs,
                    style: `color: ${css(c.muted)};`,
                }),
            });
            b.connect('clicked', onClick);
            return b;
        };
        header.add_child(mkBtn('view-refresh-symbolic', () => this._refreshAll()));
        header.add_child(mkBtn('emblem-system-symbolic', () => this.openPreferences()));

        header.connect('button-press-event', (_a, ev) => this._dragBegin(ev));
        header.connect('motion-event', (_a, ev) => this._dragMove(ev));
        header.connect('button-release-event', () => this._dragEnd());

        this._actor.add_child(header);
        this._setUpdatedLabel();
    }

    _buildTracker(t, i) {
        const c = this._c;
        const fs = this._fs;
        const row = {
            tracker: t,
            hoverIdx: null,
        };
        this._rows.push(row);

        const block = new St.BoxLayout({vertical: true, x_expand: true});

        // Header row (click to expand).
        const btn = new St.Button({
            style_class: 'bullion-row',
            can_focus: true,
            reactive: true,
            track_hover: true,
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
        });
        const inner = new St.BoxLayout({x_expand: true, style: 'spacing: 8px;'});
        btn.set_child(inner);

        row.arrow = new St.Icon({
            icon_name: 'pan-end-symbolic',
            icon_size: Math.max(10, fs - 2),
            y_align: Clutter.ActorAlign.CENTER,
            style: `color: ${css(c.muted)};`,
        });
        inner.add_child(row.arrow);

        const nameBox = new St.BoxLayout({vertical: true, y_align: Clutter.ActorAlign.CENTER});
        nameBox.add_child(new St.Label({
            text: t.label,
            style: `font-weight: 700; font-size: ${fs + 1}px;`,
        }));
        if (this._settings.get_boolean('show-symbol')) {
            nameBox.add_child(new St.Label({
                text: t.symbol,
                style: `font-size: ${fs - 3}px; color: ${css(c.muted)};`,
            }));
        }
        inner.add_child(nameBox);
        inner.add_child(new St.Widget({x_expand: true}));

        const priceBox = new St.BoxLayout({vertical: true, y_align: Clutter.ActorAlign.CENTER});
        row.price = new St.Label({
            text: '\u2026',
            x_align: Clutter.ActorAlign.END,
            style: `font-weight: 700; font-size: ${fs + 5}px;`,
        });
        row.change = new St.Label({
            text: '',
            x_align: Clutter.ActorAlign.END,
            style: `font-size: ${fs - 1}px; color: ${css(c.muted)};`,
        });
        row.change.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        priceBox.add_child(row.price);
        priceBox.add_child(row.change);
        inner.add_child(priceBox);

        btn.connect('clicked', () => this._toggle(i));
        block.add_child(btn);

        // Expandable chart area.
        row.chartBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style: 'padding: 2px 2px 8px 2px; spacing: 6px;',
        });
        const rangeRow = new St.BoxLayout({style: 'spacing: 4px;'});
        row.rangeButtons = {};
        for (const key of RANGE_ORDER) {
            const rb = new St.Button({
                label: key,
                style_class: 'bullion-btn',
                can_focus: true,
                reactive: true,
            });
            rb.connect('clicked', () => this._setRange(i, key));
            row.rangeButtons[key] = rb;
            rangeRow.add_child(rb);
        }
        row.chartBox.add_child(rangeRow);

        row.area = new St.DrawingArea({
            x_expand: true,
            reactive: true,
            height: this._settings.get_int('chart-height'),
        });
        row.area.connect('repaint', () => this._paint(i));
        row.area.connect('motion-event', (a, ev) => {
            const [x, y] = ev.get_coords();
            const [ok, lx] = a.transform_stage_point(x, y);
            const chart = this._chartFor(i);
            const pts = chart?.points ?? [];
            let idx = null;
            if (ok) {
                idx = chart?.xRange
                    ? timeIndexAt(lx, a.get_width(), pts, chart.xRange[0], chart.xRange[1])
                    : indexAt(lx, a.get_width(), pts.length);
            }
            if (idx !== row.hoverIdx) {
                row.hoverIdx = idx;
                a.queue_repaint();
            }
            return Clutter.EVENT_PROPAGATE;
        });
        row.area.connect('leave-event', () => {
            row.hoverIdx = null;
            row.area.queue_repaint();
            return Clutter.EVENT_PROPAGATE;
        });
        row.chartBox.add_child(row.area);
        block.add_child(row.chartBox);

        this._actor.add_child(block);

        this._applyExpanded(i);
        this._styleRangeButtons(i);
        this._updateRow(i);
    }

    // ---------- placement and dragging ----------

    _attach() {
        this._layer = this._settings.get_string('layer');
        this._place();
        this._actor.visible = !Main.overview.visible;
        if (this._layer === 'above')
            Main.layoutManager.addChrome(this._actor);
        else
            Main.layoutManager._backgroundGroup.add_child(this._actor);
    }

    _teardown() {
        this._dragEnd(true);
        if (!this._actor)
            return;
        if (this._layer === 'above')
            Main.layoutManager.removeChrome(this._actor);
        else
            this._actor.get_parent()?.remove_child(this._actor);
        this._actor.destroy();
        this._actor = null;
        this._header = null;
        this._updatedLabel = null;
        this._rows = [];
    }

    _place() {
        if (!this._actor)
            return;
        const mon = Main.layoutManager.primaryMonitor;
        const width = this._settings.get_int('width');
        let x = this._settings.get_int('pos-x');
        let y = this._settings.get_int('pos-y');
        if (x < 0 || y < 0) {
            x = mon.x + mon.width - width - 40;
            y = mon.y + 70;
        }
        this._actor.set_position(...this._clamp(x, y));
    }

    _clamp(x, y) {
        const sw = global.stage.width;
        const sh = global.stage.height;
        return [
            Math.round(Math.min(Math.max(0, x), Math.max(0, sw - 80))),
            Math.round(Math.min(Math.max(0, y), Math.max(0, sh - 40))),
        ];
    }

    _dragBegin(ev) {
        if (this._settings.get_boolean('locked') || ev.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        const [px, py] = ev.get_coords();
        this._dragOffset = [px - this._actor.x, py - this._actor.y];
        this._dragging = true;
        this._grab = global.stage.grab(this._header);
        return Clutter.EVENT_STOP;
    }

    _dragMove(ev) {
        if (!this._dragging)
            return Clutter.EVENT_PROPAGATE;
        const [px, py] = ev.get_coords();
        this._actor.set_position(...this._clamp(px - this._dragOffset[0], py - this._dragOffset[1]));
        return Clutter.EVENT_STOP;
    }

    _dragEnd(skipSave = false) {
        if (!this._dragging && !this._grab)
            return Clutter.EVENT_PROPAGATE;
        this._dragging = false;
        this._grab?.dismiss();
        this._grab = null;
        if (!skipSave && this._actor && this._settings) {
            this._settings.set_int('pos-x', Math.round(this._actor.x));
            this._settings.set_int('pos-y', Math.round(this._actor.y));
        }
        return Clutter.EVENT_STOP;
    }

    // ---------- interaction ----------

    _rangeOf(i) {
        const sym = this._rows[i].tracker.symbol;
        return this._ranges.get(sym) ?? this._settings.get_string('default-range');
    }

    _chartFor(i) {
        const sym = this._rows[i]?.tracker.symbol;
        const rangeKey = this._rangeOf(i);
        if (this._src.get(sym) === 'recorder') {
            const arr = this._store[goldapiCode(sym)] ?? [];
            const now = Math.floor(Date.now() / 1000);
            const span = WINDOW_SECONDS[rangeKey];
            // Time-scaled axis: a few minutes of recorded data must not look like a trend.
            return {points: windowSeries(arr, now, span), baseline: null, xRange: [now - span, now]};
        }
        return this._charts.get(`${sym}|${rangeKey}`);
    }

    _toggle(i) {
        const sym = this._rows[i].tracker.symbol;
        if (this._expanded.has(sym))
            this._expanded.delete(sym);
        else
            this._expanded.add(sym);
        this._settings.set_strv('expanded', [...this._expanded]);
        this._applyExpanded(i);
        if (this._expanded.has(sym))
            this._refreshChart(i);
    }

    _applyExpanded(i) {
        const row = this._rows[i];
        const open = this._expanded.has(row.tracker.symbol);
        row.chartBox.visible = open;
        row.arrow.icon_name = open ? 'pan-down-symbolic' : 'pan-end-symbolic';
        if (open)
            row.area.queue_repaint();
    }

    _setRange(i, key) {
        this._ranges.set(this._rows[i].tracker.symbol, key);
        this._rows[i].hoverIdx = null;
        this._styleRangeButtons(i);
        this._rows[i].area.queue_repaint();
        this._refreshChart(i);
    }

    _styleRangeButtons(i) {
        const c = this._c;
        const cur = this._rangeOf(i);
        const onAccent = readableOn(c.accent);
        for (const [key, btn] of Object.entries(this._rows[i].rangeButtons)) {
            btn.style = key === cur
                ? `background-color: ${css(c.accent)}; color: ${css(onAccent)}; font-size: ${this._fs - 2}px; font-weight: 700;`
                : `color: ${css(c.muted)}; font-size: ${this._fs - 2}px;`;
        }
    }

    // ---------- data ----------

    // Raw GET. Never throws for HTTP errors; returns the status and body text.
    async _httpText(url) {
        const msg = Soup.Message.new('GET', url);
        const hdr = msg.get_request_headers();
        hdr.replace('Accept', 'application/json');
        hdr.replace('Accept-Language', 'en-US,en;q=0.9');
        const bytes = await this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, this._cancellable);
        const data = bytes?.get_data();
        return {status: statusOf(msg), text: data ? new TextDecoder().decode(data) : ''};
    }

    async _fetchJson(url) {
        // Yahoo serves the same API on query1 and query2; retry on the other host
        // if the first one rate-limits us or errors.
        let lastError = new Error('No response');
        const hosts = url.includes('//query1.') ? ['query1', 'query2'] : [null];
        for (const host of hosts) {
            const {status, text} = await this._httpText(host ? url.replace('query1', host) : url);
            let json = null;
            try {
                json = JSON.parse(text);
            } catch (_e) {
                // not JSON (e.g. a plain-text 429 body); handled below
            }
            if (status === 200 && json !== null)
                return json;
            lastError = new Error(json?.chart?.error?.description ?? json?.message ?? `HTTP ${status}`);
            if (status !== 429 && status < 500)
                break;
        }
        throw lastError;
    }

    // onlyStale: skip trackers that have a recent quote and no error. Used after
    // rebuilds and retries so a settings change doesn't re-spend API credits.
    _refreshAll(onlyStale = false) {
        const maxAge = this._settings.get_int('refresh-minutes') * 60 * 1000 * 0.9;
        this._rows.forEach((r, i) => {
            if (onlyStale) {
                const q = this._quotes.get(r.tracker.symbol);
                if (q && !this._errors.has(r.tracker.symbol) && Date.now() - q.fetchedAt < maxAge)
                    return;
            }
            this._refreshQuote(i);
        });
    }

    // Yahoo: quote + 1D chart in one request.
    async _yahooQuote(sym) {
        const parsed = parseChart(await this._fetchJson(buildUrl(sym, '1D')), '1D');
        const dc = dayChange(parsed);
        this._charts.set(`${sym}|1D`, {points: parsed.points, baseline: parsed.prevClose});
        this._src.set(sym, 'yahoo');
        return {
            price: parsed.price,
            prevClose: parsed.prevClose,
            change: dc?.change ?? null,
            pct: dc?.pct ?? null,
            marketTime: parsed.marketTime,
            rolling: false,
        };
    }

    // ---- Twelve Data (free key: gold XAU/USD and US stocks/ETFs; 8 credits/min, 800/day) ----

    _tdKey() {
        return this._settings.get_string('twelvedata-key').trim();
    }

    _sleep(ms) {
        return new Promise(resolve => {
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                this._sleepIds?.delete(id);
                resolve();
                return GLib.SOURCE_REMOVE;
            });
            this._sleepIds?.add(id);
        });
    }

    // Serializes Twelve Data calls and spaces them out so a refresh of several
    // trackers stays under the per-minute credit limit.
    _tdFetch(url) {
        const run = async () => {
            const wait = this._tdLast + TD_MIN_SPACING_MS - Date.now();
            if (wait > 0)
                await this._sleep(wait);
            this._tdLast = Date.now();
            const {status, text} = await this._httpText(url);
            return parseTdResponse(status, text);
        };
        const p = this._tdChain.then(run, run);
        this._tdChain = p.catch(() => {});
        return p;
    }

    _tdNoteError(e) {
        if (e.tdCode !== 429)
            return;
        const next = new Date();
        next.setUTCHours(24, 1, 0, 0);
        const daily = isDailyLimit(e.tdMessage);
        this._tdBlockedUntil = daily ? next.getTime() : Date.now() + 90 * 1000;
        console.warn(`Bullion Ticker: Twelve Data limit hit (${daily ? 'daily' : 'per-minute'}): ${e.tdMessage || e.message}`);
        if (!daily)
            this._scheduleRetry();
    }

    // After a per-minute limit, try again once the window has passed.
    // Only trackers that failed or are stale are refreshed, so no credits are wasted.
    _scheduleRetry() {
        if (this._retryId)
            return;
        this._retryId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 100, () => {
            this._retryId = 0;
            this._refreshAll(true);
            return GLib.SOURCE_REMOVE;
        });
    }

    async _tdQuote(sym, tdSym) {
        let parsed;
        try {
            parsed = await this._tdFetch(tdUrl(tdSym, '1D', this._tdKey()));
        } catch (e) {
            this._tdNoteError(e);
            throw e;
        }
        const today = tdToday(parsed);
        this._charts.set(`${sym}|1D`, {points: today.points, baseline: today.baseline});
        this._src.set(sym, 'td');
        const change = today.prevClose ? today.price - today.prevClose : null;
        return {
            price: today.price,
            prevClose: today.prevClose,
            change,
            pct: change === null ? null : change / today.prevClose * 100,
            marketTime: today.ts,
            rolling: today.rolling,
        };
    }

    async _tdRefreshChart(sym, rangeKey) {
        const tdSym = tdSymbol(sym);
        const parsed = await this._tdFetch(tdUrl(tdSym, rangeKey, this._tdKey()));
        this._charts.set(`${sym}|${rangeKey}`, {points: tdChart(parsed, rangeKey), baseline: null});
        this._tdChartAt.set(`${sym}|${rangeKey}`, Date.now());
    }

    // gold-api.com: live price only; history is recorded locally from here on.
    async _goldQuote(sym, code) {
        const {price, ts} = parseGoldApi(await this._fetchJson(goldapiUrl(code)));
        if (!this._store)
            throw new Error('Extension disabled');
        addSample(this._store, code, ts, price);
        this._src.set(sym, 'recorder');
        const now = Math.floor(Date.now() / 1000);
        const dc = change24h(this._store[code], now, price);
        this._saveStoreSoon();
        return {price, prevClose: null, change: dc?.change ?? null, pct: dc?.pct ?? null, marketTime: ts, rolling: true};
    }

    // Yahoo first (it has real history, indices and stocks). On a 429 it is left alone
    // for 15 minutes, and metals fall back to gold-api.com.
    async _getQuote(t) {
        const sym = t.symbol;
        const gcode = goldapiCode(sym);
        const tdSym = this._tdKey() ? tdSymbol(sym) : null;
        const forced = goldapiOnly(sym) || tdOnly(sym);
        const yahooReady = Date.now() >= this._yahooBlockedUntil;
        const tdReady = Date.now() >= this._tdBlockedUntil;
        let lastError = null;

        // 1. Yahoo: real history, indices and stocks, no quota. Skipped for 15 min after a 429.
        if (!forced && yahooReady) {
            try {
                return await this._yahooQuote(sym);
            } catch (e) {
                if (isCancelled(e))
                    throw e;
                if (/429/.test(e.message))
                    this._yahooBlockedUntil = Date.now() + YAHOO_BACKOFF_MS;
                lastError = e;
            }
        }

        // 2. Twelve Data (needs a key in preferences): gold and US stocks/ETFs.
        if (tdSym && tdReady && !goldapiOnly(sym)) {
            try {
                return await this._tdQuote(sym, tdSym);
            } catch (e) {
                if (isCancelled(e))
                    throw e;
                lastError = e;
            }
        }

        // 3. gold-api.com: live metal prices, history recorded locally.
        if (gcode)
            return this._goldQuote(sym, gcode);

        if (lastError)
            throw lastError;
        if (tdSym && !tdReady)
            throw new Error('Twelve Data limit reached');
        throw new Error(yahooReady ? 'No data source available' : 'Rate limited (HTTP 429)');
    }

    async _refreshQuote(i) {
        const row = this._rows[i];
        if (!row)
            return;
        const sym = row.tracker.symbol;
        try {
            const q = await this._getQuote(row.tracker);
            if (!this._quotes)
                return;
            q.fetchedAt = Date.now();
            this._quotes.set(sym, q);
            this._errors.delete(sym);
            this._lastUpdated = GLib.DateTime.new_now_local();
        } catch (e) {
            if (isCancelled(e) || !this._errors)
                return;
            if (this._errors.get(sym) !== e.message)
                console.warn(`Bullion Ticker: ${sym}: ${e.message}`);
            this._errors.set(sym, e.message);
        }
        this._afterData(sym);
        // Open charts on ranges other than 1D need their own Yahoo fetch (1D came with the quote).
        const src = this._src?.get(sym);
        if ((src === 'yahoo' || src === 'td') && this._expanded?.has(sym) && this._rangeOf(i) !== '1D')
            this._refreshChart(i);
    }

    _afterAll() {
        if (!this._actor)
            return;
        this._rows.forEach((r, i) => {
            this._updateRow(i);
            r.area.queue_repaint();
        });
    }

    async _refreshChart(i) {
        const row = this._rows[i];
        if (!row)
            return;
        const sym = row.tracker.symbol;
        const rangeKey = this._rangeOf(i);
        const key = `${sym}|${rangeKey}`;
        if (rangeKey === '1D' || this._src.get(sym) === 'recorder') {
            row.area.queue_repaint();
            return;
        }
        if (this._src.get(sym) === 'td') {
            // Twelve Data charts cost one credit each, so reuse a recent fetch.
            const age = Date.now() - (this._tdChartAt.get(key) ?? 0);
            if (this._charts.has(key) && age < TD_RANGES[rangeKey].ttl * 1000) {
                row.area.queue_repaint();
                return;
            }
            if (Date.now() < this._tdBlockedUntil) {
                this._errors.set(key, 'Twelve Data limit reached');
                row.area.queue_repaint();
                return;
            }
            if (this._loading.has(key))
                return;
            this._loading.add(key);
            row.area.queue_repaint();
            try {
                await this._tdRefreshChart(sym, rangeKey);
                this._errors?.delete(key);
            } catch (e) {
                if (isCancelled(e) || !this._errors)
                    return;
                this._tdNoteError(e);
                this._errors.set(key, e.message);
            } finally {
                this._loading?.delete(key);
            }
            this._afterData(sym);
            return;
        }
        if (Date.now() < this._yahooBlockedUntil) {
            this._errors.set(key, 'Rate limited (HTTP 429)');
            row.area.queue_repaint();
            return;
        }
        if (this._loading.has(key))
            return;
        this._loading.add(key);
        row.area.queue_repaint();
        try {
            const parsed = parseChart(await this._fetchJson(buildUrl(sym, rangeKey)), rangeKey);
            if (!this._charts)
                return;
            this._charts.set(key, {points: parsed.points, baseline: null});
            this._errors.delete(`${key}`);
        } catch (e) {
            if (isCancelled(e) || !this._errors)
                return;
            if (/429/.test(e.message))
                this._yahooBlockedUntil = Date.now() + YAHOO_BACKOFF_MS;
            this._errors.set(key, e.message);
        } finally {
            this._loading?.delete(key);
        }
        this._afterData(sym);
    }

    _afterData(sym) {
        if (!this._actor)
            return;
        this._rows.forEach((r, i) => {
            if (r.tracker.symbol === sym) {
                this._updateRow(i);
                r.area.queue_repaint();
            }
        });
        this._setUpdatedLabel();
    }

    _setUpdatedLabel() {
        if (!this._updatedLabel)
            return;
        this._updatedLabel.text = this._lastUpdated
            ? this._lastUpdated.format('%l:%M %p').trim()
            : '\u2026';
    }

    _updateRow(i) {
        const row = this._rows[i];
        const c = this._c;
        const t = row.tracker;
        const q = this._quotes.get(t.symbol);
        const err = this._errors.get(t.symbol);

        if (!q) {
            row.price.text = err ? 'n/a' : '\u2026';
            row.change.text = shortErr(err);
            row.change.style = `font-size: ${this._fs - 1}px; color: ${css(c.muted)};`;
            return;
        }

        const recorded = q.rolling === true;
        // A newer refresh failed: keep showing the last good quote, but mark it.
        const stale = err ? ' \u26A0' : '';
        row.price.text = `${t.prefix}${fmtNum(q.price, t.decimals)}`;
        if (q.change === null) {
            row.change.text = (recorded ? '24h change: collecting\u2026' : '') + stale;
            row.change.style = `font-size: ${this._fs - 1}px; color: ${css(c.muted)};`;
            return;
        }
        const up = q.change >= 0;
        const sign = up ? '+' : '';
        row.change.text = `${up ? '\u25B2' : '\u25BC'} ${sign}${fmtNum(q.change, t.decimals)} (${sign}${q.pct.toFixed(2)}%)${recorded ? ' 24h' : ''}${stale}`;
        row.change.style = `font-size: ${this._fs - 1}px; font-weight: 600; color: ${css(up ? c.up : c.down)};`;
    }

    // ---------- drawing ----------

    _paint(i) {
        const row = this._rows[i];
        if (!row)
            return;
        const area = row.area;
        const cr = area.get_context();
        try {
            const [w, h] = area.get_surface_size();
            const t = row.tracker;
            const rangeKey = this._rangeOf(i);
            const spec = RANGES[rangeKey];
            const chart = this._chartFor(i);
            const q = this._quotes.get(t.symbol);
            const c = this._c;

            const trend = this._settings.get_boolean('chart-trend-color') && q && q.change !== null;
            const line = trend ? (q.change >= 0 ? c.up : c.down) : c.line;

            const key = `${t.symbol}|${rangeKey}`;
            let message = 'No data';
            if (this._src.get(t.symbol) === 'recorder')
                message = 'Chart fills in as prices are recorded';
            else if (this._loading.has(key))
                message = 'Loading\u2026';
            else if (this._errors.get(key) ?? this._errors.get(t.symbol))
                message = shortErr(this._errors.get(key) ?? this._errors.get(t.symbol));
            else if (!chart)
                message = 'Loading\u2026';

            drawChart(cr, Cairo, {
                w, h,
                points: chart?.points ?? [],
                baseline: chart?.baseline ?? null,
                xRange: chart?.xRange ?? null,
                showBaseline: rangeKey === '1D',
                colors: {text: c.text, muted: c.muted, line},
                hoverIdx: row.hoverIdx,
                message,
                decimals: t.decimals,
                prefix: t.prefix,
                axisFmt: spec.axisFmt,
                tipFmt: spec.tipFmt,
                fontFamily: this._family,
                fontSize: this._fs,
                fmtTime: formatTime,
                fmtNum,
            });
        } catch (e) {
            console.error(`Bullion Ticker: chart paint failed: ${e.message}`);
        } finally {
            cr.$dispose();
        }
    }
}
