// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Phillip Blanton

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// Yahoo Finance symbols. Gold/silver "spot" use Yahoo's XAU/XAG currency pairs;
// platinum/palladium are the front-month futures, which track spot closely.
const PRESETS = [
    {name: 'Gold (spot)',           label: 'Gold',      symbol: 'XAUUSD=X', prefix: '$', decimals: 2},
    {name: 'Silver (spot)',         label: 'Silver',    symbol: 'XAGUSD=X', prefix: '$', decimals: 3},
    {name: 'Platinum (futures)',    label: 'Platinum',  symbol: 'PL=F',     prefix: '$', decimals: 2},
    {name: 'Palladium (futures)',   label: 'Palladium', symbol: 'PA=F',     prefix: '$', decimals: 2},
    {name: 'Gold (futures)',        label: 'Gold Fut.', symbol: 'GC=F',     prefix: '$', decimals: 2},
    {name: 'Silver (futures)',      label: 'Silver Fut.', symbol: 'SI=F',   prefix: '$', decimals: 3},
    {name: 'Copper (futures)',      label: 'Copper',    symbol: 'HG=F',     prefix: '$', decimals: 4},
    {name: 'Dow Jones Industrial',  label: 'Dow Jones', symbol: '^DJI',     prefix: '',  decimals: 2},
    {name: 'S&P 500',               label: 'S&P 500',   symbol: '^GSPC',    prefix: '',  decimals: 2},
    {name: 'Nasdaq Composite',      label: 'Nasdaq',    symbol: '^IXIC',    prefix: '',  decimals: 2},
    {name: 'Russell 2000',          label: 'Russell 2000', symbol: '^RUT',  prefix: '',  decimals: 2},
    {name: 'Bitcoin',               label: 'Bitcoin',   symbol: 'BTC-USD',  prefix: '$', decimals: 2},
    // ETFs: not spot or index values, but they have full history on every data source,
    // including the free Twelve Data plan.
    {name: 'Dow Jones (DIA ETF)',   label: 'Dow (DIA)', symbol: 'DIA',      prefix: '$', decimals: 2},
    {name: 'S&P 500 (SPY ETF)',     label: 'S&P (SPY)', symbol: 'SPY',      prefix: '$', decimals: 2},
    {name: 'Nasdaq 100 (QQQ ETF)',  label: 'Nasdaq (QQQ)', symbol: 'QQQ',   prefix: '$', decimals: 2},
    {name: 'Silver (SLV ETF)',      label: 'Silver (SLV)', symbol: 'SLV',   prefix: '$', decimals: 2},
    {name: 'Platinum (PPLT ETF)',   label: 'Plat. (PPLT)', symbol: 'PPLT',  prefix: '$', decimals: 2},
    {name: 'Palladium (PALL ETF)',  label: 'Pall. (PALL)', symbol: 'PALL',  prefix: '$', decimals: 2},
    {name: 'Gold (GLD ETF)',        label: 'Gold (GLD)', symbol: 'GLD',     prefix: '$', decimals: 2},
];

const COLOR_KEYS = ['bg-color', 'text-color', 'muted-color', 'up-color', 'down-color', 'accent-color', 'line-color'];
const LOOK_KEYS = [...COLOR_KEYS, 'chart-trend-color', 'width', 'font-size', 'font-family', 'chart-height', 'corner-radius'];

function loadTrackers(settings) {
    try {
        const a = JSON.parse(settings.get_string('trackers'));
        return Array.isArray(a) ? a : [];
    } catch (_e) {
        return [];
    }
}

function spinRow(settings, title, key, lower, upper, step = 1, subtitle = '') {
    const row = new Adw.SpinRow({
        title,
        subtitle,
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 5}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function switchRow(settings, title, key, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function colorRow(settings, title, key) {
    const row = new Adw.ActionRow({title});
    const btn = new Gtk.ColorDialogButton({
        dialog: new Gtk.ColorDialog({with_alpha: true}),
        valign: Gtk.Align.CENTER,
    });
    const fromSetting = () => {
        const rgba = new Gdk.RGBA();
        if (!rgba.parse(settings.get_string(key)))
            rgba.parse('rgb(128,128,128)');
        return rgba;
    };
    btn.rgba = fromSetting();
    btn.connect('notify::rgba', () => {
        const s = btn.rgba.to_string();
        if (s !== settings.get_string(key))
            settings.set_string(key, s);
    });
    settings.connect(`changed::${key}`, () => {
        const next = fromSetting();
        if (!next.equal(btn.rgba))
            btn.rgba = next;
    });
    row.add_suffix(btn);
    row.activatable_widget = btn;
    return row;
}

function comboRow(title, labels, getIndex, onSelect) {
    const row = new Adw.ComboRow({title, model: Gtk.StringList.new(labels)});
    row.selected = getIndex();
    row.connect('notify::selected', () => onSelect(row.selected));
    return row;
}

export default class BullionTickerPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings; // keep alive for the window's lifetime
        window.set_default_size(660, 800);
        window.add(this._trackersPage(window, settings));
        window.add(this._appearancePage(settings));
        window.add(this._generalPage(settings));
    }

    // ---------- Trackers ----------

    _trackersPage(window, settings) {
        const page = new Adw.PreferencesPage({title: 'Trackers', icon_name: 'view-list-symbolic'});

        const list = new Adw.PreferencesGroup({
            title: 'Tracked markets',
            description: 'Expand a tracker to rename it or change its symbol. Symbols are Yahoo Finance symbols.',
        });
        page.add(list);

        let rows = [];
        const save = arr => settings.set_string('trackers', JSON.stringify(arr));
        const update = (i, patch) => {
            const a = loadTrackers(settings);
            if (a[i])
                save(a.map((t, k) => k === i ? {...t, ...patch} : t));
        };
        const rerender = () => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            render();
            return GLib.SOURCE_REMOVE;
        });

        const buildRow = (t, i, count) => {
            const row = new Adw.ExpanderRow({title: t.label || t.symbol, subtitle: t.symbol});

            const name = new Adw.EntryRow({title: 'Name', text: t.label ?? '', show_apply_button: true});
            name.connect('apply', () => {
                const v = name.text.trim() || t.symbol;
                row.title = v;
                update(i, {label: v});
            });
            row.add_row(name);

            const sym = new Adw.EntryRow({title: 'Symbol', text: t.symbol ?? '', show_apply_button: true});
            sym.connect('apply', () => {
                const v = sym.text.trim().toUpperCase();
                if (!v)
                    return;
                row.subtitle = v;
                update(i, {symbol: v});
            });
            row.add_row(sym);

            const prefix = new Adw.EntryRow({title: 'Currency prefix (e.g. $)', text: t.prefix ?? '', show_apply_button: true});
            prefix.connect('apply', () => update(i, {prefix: prefix.text.trim()}));
            row.add_row(prefix);

            const dec = new Adw.SpinRow({
                title: 'Decimals',
                adjustment: new Gtk.Adjustment({
                    lower: 0, upper: 6, step_increment: 1,
                    value: Number.isInteger(t.decimals) ? t.decimals : 2,
                }),
            });
            dec.connect('notify::value', () => update(i, {decimals: Math.round(dec.value)}));
            row.add_row(dec);

            const actions = new Adw.ActionRow({title: 'Order and removal'});
            const mk = (icon, tip, cb, cls = []) => {
                const b = new Gtk.Button({
                    icon_name: icon,
                    tooltip_text: tip,
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat', ...cls],
                });
                b.connect('clicked', cb);
                actions.add_suffix(b);
                return b;
            };
            const up = mk('go-up-symbolic', 'Move up', () => {
                const a = loadTrackers(settings);
                [a[i - 1], a[i]] = [a[i], a[i - 1]];
                save(a);
                rerender();
            });
            up.sensitive = i > 0;
            const down = mk('go-down-symbolic', 'Move down', () => {
                const a = loadTrackers(settings);
                [a[i + 1], a[i]] = [a[i], a[i + 1]];
                save(a);
                rerender();
            });
            down.sensitive = i < count - 1;
            mk('user-trash-symbolic', 'Remove this tracker', () => {
                const a = loadTrackers(settings);
                a.splice(i, 1);
                save(a);
                rerender();
            }, ['destructive-action']);
            row.add_row(actions);
            return row;
        };

        const render = () => {
            for (const r of rows)
                list.remove(r);
            rows = [];
            const arr = loadTrackers(settings);
            arr.forEach((t, i) => {
                const r = buildRow(t, i, arr.length);
                list.add(r);
                rows.push(r);
            });
        };

        const addTracker = t => {
            const a = loadTrackers(settings);
            if (a.some(x => x.symbol === t.symbol)) {
                window.add_toast(new Adw.Toast({title: `${t.symbol} is already tracked`}));
                return;
            }
            a.push(t);
            save(a);
            render();
        };

        render();

        // Presets.
        const add = new Adw.PreferencesGroup({
            title: 'Add a tracker',
            description: 'Pick a common market, or enter any Yahoo Finance symbol below.',
        });
        page.add(add);

        const presetRow = new Adw.ComboRow({
            title: 'Common markets',
            model: Gtk.StringList.new(PRESETS.map(p => `${p.name}  —  ${p.symbol}`)),
        });
        const presetBtn = new Gtk.Button({
            label: 'Add',
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        presetBtn.connect('clicked', () => {
            const p = PRESETS[presetRow.selected];
            addTracker({label: p.label, symbol: p.symbol, prefix: p.prefix, decimals: p.decimals});
        });
        presetRow.add_suffix(presetBtn);
        add.add(presetRow);

        // Custom symbol.
        const customSym = new Adw.EntryRow({title: 'Symbol (e.g. AAPL, ^DJI, XPTUSD=X)'});
        const customName = new Adw.EntryRow({title: 'Name (optional)'});
        const customBtn = new Gtk.Button({
            label: 'Add',
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        customBtn.connect('clicked', () => {
            const symbol = customSym.text.trim().toUpperCase();
            if (!symbol) {
                window.add_toast(new Adw.Toast({title: 'Enter a symbol first'}));
                return;
            }
            addTracker({
                label: customName.text.trim() || symbol,
                symbol,
                prefix: symbol.startsWith('^') ? '' : '$',
                decimals: 2,
            });
            customSym.text = '';
            customName.text = '';
        });
        customName.add_suffix(customBtn);
        add.add(customSym);
        add.add(customName);

        return page;
    }

    // ---------- Appearance ----------

    _appearancePage(settings) {
        const page = new Adw.PreferencesPage({title: 'Appearance', icon_name: 'applications-graphics-symbolic'});

        const colors = new Adw.PreferencesGroup({title: 'Colors'});
        colors.add(colorRow(settings, 'Background (includes opacity)', 'bg-color'));
        colors.add(colorRow(settings, 'Text', 'text-color'));
        colors.add(colorRow(settings, 'Secondary text', 'muted-color'));
        colors.add(colorRow(settings, 'Up on the day', 'up-color'));
        colors.add(colorRow(settings, 'Down on the day', 'down-color'));
        colors.add(colorRow(settings, 'Accent (selected range)', 'accent-color'));
        page.add(colors);

        const chart = new Adw.PreferencesGroup({title: 'Chart'});
        chart.add(switchRow(settings, 'Color the line by the day’s direction', 'chart-trend-color',
            'Green when up on the day, red when down. Turn off to use one fixed color.'));
        chart.add(colorRow(settings, 'Fixed line color', 'line-color'));
        chart.add(spinRow(settings, 'Chart height (px)', 'chart-height', 80, 400, 10));
        page.add(chart);

        const size = new Adw.PreferencesGroup({title: 'Size and font'});
        size.add(spinRow(settings, 'Widget width (px)', 'width', 240, 700, 10));
        size.add(spinRow(settings, 'Font size (px)', 'font-size', 9, 28, 1));
        size.add(spinRow(settings, 'Corner radius (px)', 'corner-radius', 0, 40, 1));

        const font = new Adw.EntryRow({title: 'Font family (empty = system default)', show_apply_button: true});
        font.text = settings.get_string('font-family');
        font.connect('apply', () => settings.set_string('font-family', font.text.trim()));
        size.add(font);
        page.add(size);

        const reset = new Adw.PreferencesGroup();
        const resetRow = new Adw.ActionRow({title: 'Reset appearance to defaults'});
        const resetBtn = new Gtk.Button({label: 'Reset', valign: Gtk.Align.CENTER, css_classes: ['destructive-action']});
        resetBtn.connect('clicked', () => {
            for (const k of LOOK_KEYS)
                settings.reset(k);
            font.text = settings.get_string('font-family');
        });
        resetRow.add_suffix(resetBtn);
        reset.add(resetRow);
        page.add(reset);

        return page;
    }

    // ---------- General ----------

    _generalPage(settings) {
        const page = new Adw.PreferencesPage({title: 'General', icon_name: 'preferences-system-symbolic'});

        const data = new Adw.PreferencesGroup({title: 'Data'});
        data.add(spinRow(settings, 'Refresh every (minutes)', 'refresh-minutes', 1, 60, 1,
            'Prices come from Yahoo Finance and may be delayed.'));
        const ranges = ['1D', '3D', '1W', '1M', '1Y'];
        data.add(comboRow('Default chart range', ranges,
            () => Math.max(0, ranges.indexOf(settings.get_string('default-range'))),
            i => settings.set_string('default-range', ranges[i])));
        page.add(data);

        const td = new Adw.PreferencesGroup({
            title: 'Twelve Data (optional)',
            description: 'A free key from twelvedata.com adds gold and US stocks/ETFs as a backup when Yahoo ' +
                'Finance refuses requests. The key is stored unencrypted in your settings. The free plan ' +
                'allows 800 credits a day, so keep the refresh interval at 15 minutes or more.',
        });
        const keyRow = new Adw.PasswordEntryRow({title: 'API key', show_apply_button: true});
        keyRow.text = settings.get_string('twelvedata-key');
        keyRow.connect('apply', () => settings.set_string('twelvedata-key', keyRow.text.trim()));
        td.add(keyRow);
        page.add(td);

        const place = new Adw.PreferencesGroup({title: 'Placement'});
        const layers = ['desktop', 'above'];
        place.add(comboRow('Layer',
            ['On the desktop (behind windows)', 'Floating above windows'],
            () => Math.max(0, layers.indexOf(settings.get_string('layer'))),
            i => settings.set_string('layer', layers[i])));
        place.add(switchRow(settings, 'Lock position', 'locked', 'Stops the widget from being dragged by its header.'));
        place.add(switchRow(settings, 'Show symbol under each name', 'show-symbol'));

        const posRow = new Adw.ActionRow({
            title: 'Reset position',
            subtitle: 'Return the widget to the top-right corner. Drag the header bar to move it.',
        });
        const posBtn = new Gtk.Button({label: 'Reset', valign: Gtk.Align.CENTER});
        posBtn.connect('clicked', () => {
            settings.set_int('pos-x', -1);
            settings.set_int('pos-y', -1);
        });
        posRow.add_suffix(posBtn);
        place.add(posRow);
        page.add(place);

        const note = new Adw.PreferencesGroup({
            description: 'Prices are informational only and are not investment advice.',
        });
        page.add(note);

        return page;
    }
}
