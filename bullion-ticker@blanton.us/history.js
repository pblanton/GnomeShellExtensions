// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Phillip Blanton

// Local price recorder used when the data source has no history of its own.
// A store is a plain object: {CODE: [[unixSeconds, price], ...]} sorted ascending.
// No GNOME imports, so it can be unit-tested with plain Node.

export const DAY = 86400;
export const RAW_KEEP = 35 * DAY;   // full resolution
export const MAX_KEEP = 400 * DAY;  // older than RAW_KEEP is thinned to one point per day

export const WINDOW_SECONDS = {
    '1D': DAY,
    '3D': 3 * DAY,
    '1W': 7 * DAY,
    '1M': 30 * DAY,
    '1Y': 365 * DAY,
};

export function addSample(store, code, ts, price) {
    const arr = store[code] ?? (store[code] = []);
    const last = arr[arr.length - 1];
    if (last && ts <= last[0])
        return false; // duplicate or out of order
    arr.push([ts, price]);
    return true;
}

// Drops anything past MAX_KEEP and thins points older than RAW_KEEP to the last one of each day.
export function prune(arr, now) {
    const rawCut = now - RAW_KEEP;
    const maxCut = now - MAX_KEEP;
    const out = [];
    for (const p of arr) {
        if (p[0] < maxCut)
            continue;
        if (p[0] < rawCut) {
            const prev = out[out.length - 1];
            if (prev && prev[0] < rawCut && Math.floor(prev[0] / DAY) === Math.floor(p[0] / DAY)) {
                out[out.length - 1] = p;
                continue;
            }
        }
        out.push(p);
    }
    return out;
}

// Points inside the window, thinned to at most maxPoints (keeps the latest point of each bucket).
export function windowSeries(arr, now, seconds, maxPoints = 400) {
    const from = now - seconds;
    const pts = arr.filter(p => p[0] >= from);
    if (pts.length <= maxPoints)
        return pts;
    const t0 = pts[0][0];
    const step = (pts[pts.length - 1][0] - t0) / maxPoints || 1;
    const out = [];
    let bucket = -1;
    for (const p of pts) {
        const b = Math.floor((p[0] - t0) / step);
        if (b === bucket) {
            out[out.length - 1] = p;
        } else {
            out.push(p);
            bucket = b;
        }
    }
    return out;
}

// Rolling 24h change. Reference is the newest sample at or before 24h ago (if not stale),
// else the oldest sample inside the window once we have at least 10 minutes of data.
export function change24h(arr, now, price) {
    const from = now - DAY;
    let ref = null;
    for (const p of arr) {
        if (p[0] <= from)
            ref = p;
        else
            break;
    }
    if (ref && ref[0] < from - 12 * 3600)
        ref = null;
    if (!ref) {
        const first = arr.find(p => p[0] > from);
        if (first && now - first[0] >= 600)
            ref = first;
    }
    if (!ref || !ref[1])
        return null;
    const change = price - ref[1];
    return {change, pct: change / ref[1] * 100, since: ref[0]};
}

// Validates and merges a JSON-loaded store into `into` (used at startup).
export function mergeStore(into, loaded) {
    if (!loaded || typeof loaded !== 'object')
        return into;
    for (const [code, arr] of Object.entries(loaded)) {
        if (!Array.isArray(arr))
            continue;
        const clean = arr.filter(p => Array.isArray(p) && p.length === 2 &&
            Number.isFinite(p[0]) && Number.isFinite(p[1]));
        const live = into[code] ?? [];
        const merged = [...clean];
        for (const p of live) {
            if (!merged.length || p[0] > merged[merged.length - 1][0])
                merged.push(p);
        }
        into[code] = merged;
    }
    return into;
}
