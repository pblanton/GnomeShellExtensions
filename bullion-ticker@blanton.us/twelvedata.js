// Twelve Data provider helpers (free key: gold XAU/USD and US stocks/ETFs).
// No GNOME imports, so this file can be unit-tested with plain Node.

import {WINDOW_SECONDS, change24h, windowSeries} from './history.js';

// ttl: seconds a fetched chart stays fresh (each fetch costs one API credit).
export const TD_RANGES = {
    '1D': {interval: '5min',  outputsize: 300, ttl: 0},
    '3D': {interval: '15min', outputsize: 300, ttl: 15 * 60},
    '1W': {interval: '1h',    outputsize: 170, ttl: 30 * 60},
    '1M': {interval: '4h',    outputsize: 190, ttl: 2 * 3600},
    '1Y': {interval: '1day',  outputsize: 260, ttl: 12 * 3600},
};

// Maps a tracker symbol to a Twelve Data symbol, or null if it has no equivalent.
//   TD:XAU/USD      -> XAU/USD (forces Twelve Data)
//   XAUUSD=X, GC=F  -> XAU/USD
//   AAPL, SPY, BRK.B -> same
export function tdSymbol(symbol) {
    const s = String(symbol ?? '').trim();
    const forced = /^TD:(.+)$/i.exec(s);
    if (forced)
        return forced[1].toUpperCase();
    const u = s.toUpperCase();
    if (u === 'XAUUSD=X' || u === 'GC=F')
        return 'XAU/USD';
    if (/^[A-Z]{1,5}(\.[A-Z])?$/.test(u))
        return u;
    return null;
}

export function tdOnly(symbol) {
    return /^TD:/i.test(String(symbol ?? ''));
}

export function tdUrl(tdSym, rangeKey, apiKey) {
    const r = TD_RANGES[rangeKey];
    if (!r)
        throw new Error(`Unknown range ${rangeKey}`);
    return 'https://api.twelvedata.com/time_series' +
        `?symbol=${encodeURIComponent(tdSym)}&interval=${r.interval}&outputsize=${r.outputsize}` +
        `&timezone=UTC&order=desc&apikey=${encodeURIComponent(apiKey)}`;
}

function parseDatetime(s) {
    const str = String(s);
    const iso = str.length <= 10 ? `${str}T00:00:00Z` : `${str.replace(' ', 'T')}Z`;
    return Math.floor(Date.parse(iso) / 1000);
}

export function isDailyLimit(message) {
    return /for the day|per day|daily/i.test(String(message ?? ''));
}

function friendlyError(json) {
    const msg = String(json.message ?? '');
    if (/run out of API credits/i.test(msg))
        return isDailyLimit(msg) ? 'Twelve Data daily credits used up' : 'Twelve Data rate limit';
    if (/Grow|Venture|Pro plan|upgrad/i.test(msg))
        return 'Needs a paid Twelve Data plan';
    if (/apikey|api key/i.test(msg))
        return 'Twelve Data key rejected';
    return msg || 'Twelve Data error';
}

// -> {points: [[ts, close]...] ascending, type: 'Common Stock' | 'Precious Metal' | ...}
export function parseTd(json) {
    if (!json || typeof json !== 'object')
        throw new Error('Unexpected response');
    if (json.status === 'error' || (typeof json.code === 'number' && json.code >= 400)) {
        const e = new Error(friendlyError(json));
        e.tdCode = json.code;
        e.tdMessage = String(json.message ?? '');
        throw e;
    }
    const values = json.values;
    if (!Array.isArray(values) || !values.length)
        throw new Error('No data for this symbol');

    const points = [];
    for (const v of values) {
        const ts = parseDatetime(v.datetime);
        const close = Number(v.close);
        if (Number.isFinite(ts) && Number.isFinite(close))
            points.push([ts, close]);
    }
    if (!points.length)
        throw new Error('No data for this symbol');
    points.sort((a, b) => a[0] - b[0]);
    return {points, type: json.meta?.type ?? ''};
}

// Handles the raw HTTP result, so errors carry tdCode even when the server answers with a
// non-200 status (Twelve Data sends HTTP 429 for exhausted credits) or a non-JSON body.
export function parseTdResponse(status, text) {
    let json = null;
    try {
        json = JSON.parse(text);
    } catch (_e) {
        // not JSON; handled below
    }
    try {
        if (json && typeof json === 'object')
            return parseTd(json);
    } catch (e) {
        if (e.tdCode === undefined && status >= 400)
            e.tdCode = status;
        throw e;
    }
    const e = new Error(status === 429 ? 'Twelve Data rate limit' : `Twelve Data HTTP ${status}`);
    e.tdCode = status;
    e.tdMessage = '';
    throw e;
}

// Interprets a 5-minute series as a "today" view.
//  - stocks/ETFs: today's session, change vs the previous session's last bar
//  - metals (24h markets): last 24 hours, rolling 24h change
export function tdToday(parsed) {
    const pts = parsed.points;
    const last = pts[pts.length - 1];
    const price = last[1];

    if (/stock|etf|fund|index|equity/i.test(parsed.type)) {
        const day = Math.floor(last[0] / 86400);
        let i = pts.length - 1;
        while (i >= 0 && Math.floor(pts[i][0] / 86400) === day)
            i--;
        const prev = i >= 0 ? pts[i][1] : null;
        return {price, prevClose: prev, points: pts.slice(i + 1), baseline: prev, ts: last[0], rolling: false};
    }

    const dc = change24h(pts, last[0], price);
    return {
        price,
        prevClose: dc ? price - dc.change : null,
        points: pts.filter(p => p[0] >= last[0] - 86400),
        baseline: null,
        ts: last[0],
        rolling: true,
    };
}

// Points for a longer chart range, trimmed to the window ending at the latest bar.
export function tdChart(parsed, rangeKey) {
    const last = parsed.points[parsed.points.length - 1][0];
    return windowSeries(parsed.points, last, WINDOW_SECONDS[rangeKey]);
}
