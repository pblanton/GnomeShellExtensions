// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Phillip Blanton

// Pure data helpers for the Yahoo Finance chart endpoint.
// No GNOME imports here, so this file can be unit-tested with plain Node.

export const RANGE_ORDER = ['1D', '3D', '1W', '1M', '1Y'];

export const RANGES = {
    '1D': {range: '1d',  interval: '5m',  trimSeconds: 0,           axisFmt: '%l:%M %p', tipFmt: '%a %b %d  %l:%M %p'},
    '3D': {range: '5d',  interval: '15m', trimSeconds: 3 * 86400,   axisFmt: '%a %l %p', tipFmt: '%a %b %d  %l:%M %p'},
    '1W': {range: '5d',  interval: '30m', trimSeconds: 0,           axisFmt: '%a %b %d', tipFmt: '%a %b %d  %l:%M %p'},
    '1M': {range: '1mo', interval: '60m', trimSeconds: 0,           axisFmt: '%b %d',    tipFmt: '%b %d  %l:%M %p'},
    '1Y': {range: '1y',  interval: '1d',  trimSeconds: 0,           axisFmt: '%b %Y',    tipFmt: '%b %d, %Y'},
};

export function buildUrl(symbol, rangeKey) {
    const r = RANGES[rangeKey];
    if (!r)
        throw new Error(`Unknown range ${rangeKey}`);
    return 'https://query1.finance.yahoo.com/v8/finance/chart/' +
        `${encodeURIComponent(symbol)}?range=${r.range}&interval=${r.interval}&includePrePost=false`;
}

// Turns a Yahoo chart response into {price, prevClose, currency, marketTime, points}.
// points is [[unixSeconds, close], ...] with null closes removed.
export function parseChart(json, rangeKey) {
    const chart = json?.chart;
    if (!chart)
        throw new Error('Unexpected response');
    if (chart.error)
        throw new Error(chart.error.description || chart.error.code || 'Provider error');

    const res = chart.result?.[0];
    if (!res)
        throw new Error('No data for this symbol');

    const meta = res.meta ?? {};
    const ts = res.timestamp ?? [];
    const closes = res.indicators?.quote?.[0]?.close ?? [];

    let points = [];
    for (let i = 0; i < ts.length; i++) {
        const v = closes[i];
        if (typeof v === 'number' && Number.isFinite(v))
            points.push([ts[i], v]);
    }

    const trim = RANGES[rangeKey]?.trimSeconds ?? 0;
    if (trim && points.length) {
        const cutoff = points[points.length - 1][0] - trim;
        points = points.filter(p => p[0] >= cutoff);
    }

    let price = typeof meta.regularMarketPrice === 'number' ? meta.regularMarketPrice : null;
    if (price === null && points.length)
        price = points[points.length - 1][1];

    const prev = typeof meta.chartPreviousClose === 'number'
        ? meta.chartPreviousClose
        : (typeof meta.previousClose === 'number' ? meta.previousClose : null);

    if (price === null && !points.length)
        throw new Error('No price available');

    return {
        price,
        prevClose: prev,
        currency: meta.currency ?? '',
        marketTime: meta.regularMarketTime ?? (points.length ? points[points.length - 1][0] : 0),
        points,
    };
}

// Day change from a 1D parse. Returns null when there is no previous close.
export function dayChange(parsed) {
    if (parsed.price === null || !parsed.prevClose)
        return null;
    const change = parsed.price - parsed.prevClose;
    return {change, pct: change / parsed.prevClose * 100};
}

export function fmtNum(n, decimals) {
    if (!Number.isFinite(n))
        return '—';
    const [i, f] = Math.abs(n).toFixed(decimals).split('.');
    const grouped = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (n < 0 ? '-' : '') + grouped + (f ? `.${f}` : '');
}
