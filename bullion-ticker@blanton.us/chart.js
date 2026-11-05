// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Phillip Blanton

// Cairo chart renderer. No GNOME imports: the cairo namespace and the time
// formatter are passed in, so the drawing logic can be exercised under Node.

export const PAD = {l: 6, r: 56, t: 18, b: 18};

function setC(cr, c, alphaMul = 1) {
    cr.setSourceRGBA(c[0], c[1], c[2], c[3] * alphaMul);
}

function drawText(cr, str, x, y, align, color, size, family) {
    cr.selectFontFace(family || 'Sans', 0, 0);
    cr.setFontSize(size);
    const w = cr.textExtents(str).width;
    const px = align === 'right' ? x - w : (align === 'center' ? x - w / 2 : x);
    setC(cr, color);
    cr.moveTo(px, y);
    cr.showText(str);
}

export function indexAt(localX, w, n) {
    if (n < 2)
        return null;
    const pw = w - PAD.l - PAD.r;
    if (localX < PAD.l - 4 || localX > PAD.l + pw + 4)
        return null;
    const idx = Math.round((localX - PAD.l) / pw * (n - 1));
    return Math.min(n - 1, Math.max(0, idx));
}

// Hover lookup for a time-scaled chart: nearest point to the pointer, or null if none is close.
export function timeIndexAt(localX, w, pts, t0, t1) {
    if (!pts.length || t1 <= t0)
        return null;
    const pw = w - PAD.l - PAD.r;
    if (localX < PAD.l - 4 || localX > PAD.l + pw + 4)
        return null;
    const t = t0 + (localX - PAD.l) / pw * (t1 - t0);
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < pts.length; i++) {
        const d = Math.abs(pts[i][0] - t);
        if (d < bestDist) {
            bestDist = d;
            best = i;
        } else if (pts[i][0] > t) {
            break;
        }
    }
    return bestDist <= (t1 - t0) * 0.05 ? best : null;
}

/**
 * p: {
 *   xRange: [t0, t1] | null  -- when set, x is scaled by time over this span (points that
 *                               cover only part of it sit at the right edge); otherwise
 *                               points are spread evenly by index.
 *   w, h, points: [[ts, value]...], baseline: number|null,
 *   colors: {text, muted, line} (each [r,g,b,a] in 0..1),
 *   hoverIdx: number|null, message: string,
 *   decimals, prefix, axisFmt, tipFmt, fontFamily, fontSize,
 *   fmtTime(ts, fmt) -> string, fmtNum(n, decimals) -> string
 * }
 */
export function drawChart(cr, Cairo, p) {
    const {w, h, points: pts, colors} = p;
    const small = Math.max(9, p.fontSize - 3);
    const n = pts.length;

    if (n < 2) {
        drawText(cr, p.message || 'No data', w / 2, h / 2, 'center', colors.muted, p.fontSize - 1, p.fontFamily);
        return;
    }

    const pw = w - PAD.l - PAD.r;
    const ph = h - PAD.t - PAD.b;

    let min = Infinity;
    let max = -Infinity;
    for (const [, v] of pts) {
        if (v < min) min = v;
        if (v > max) max = v;
    }
    const showBase = p.baseline !== null && p.baseline !== undefined && p.showBaseline;
    if (showBase) {
        min = Math.min(min, p.baseline);
        max = Math.max(max, p.baseline);
    }
    if (min === max) {
        min -= 1;
        max += 1;
    }
    const margin = (max - min) * 0.08;
    min -= margin;
    max += margin;

    const xr = p.xRange && p.xRange[1] > p.xRange[0] ? p.xRange : null;
    const xAt = xr
        ? i => PAD.l + pw * Math.min(1, Math.max(0, (pts[i][0] - xr[0]) / (xr[1] - xr[0])))
        : i => PAD.l + pw * (i / (n - 1));
    const yAt = v => PAD.t + ph * (1 - (v - min) / (max - min));

    // Grid and y-axis labels.
    cr.setLineWidth(1);
    for (let k = 0; k < 4; k++) {
        const y = Math.round(PAD.t + ph * k / 3) + 0.5;
        setC(cr, colors.muted, 0.18);
        cr.moveTo(PAD.l, y);
        cr.lineTo(PAD.l + pw, y);
        cr.stroke();
        const v = max - (max - min) * k / 3;
        drawText(cr, p.fmtNum(v, p.decimals), w - 2, y + small / 3, 'right', colors.muted, small, p.fontFamily);
    }

    // Previous-close baseline (1D only).
    if (showBase) {
        const y = yAt(p.baseline);
        cr.setDash([4, 4], 0);
        setC(cr, colors.muted, 0.55);
        cr.moveTo(PAD.l, y);
        cr.lineTo(PAD.l + pw, y);
        cr.stroke();
        cr.setDash([], 0);
    }

    // Area fill under the line.
    const lc = colors.line;
    const grad = new Cairo.LinearGradient(0, PAD.t, 0, PAD.t + ph);
    grad.addColorStopRGBA(0, lc[0], lc[1], lc[2], 0.32);
    grad.addColorStopRGBA(1, lc[0], lc[1], lc[2], 0.0);
    cr.moveTo(xAt(0), yAt(pts[0][1]));
    for (let i = 1; i < n; i++)
        cr.lineTo(xAt(i), yAt(pts[i][1]));
    cr.lineTo(xAt(n - 1), PAD.t + ph);
    cr.lineTo(xAt(0), PAD.t + ph);
    cr.closePath();
    cr.setSource(grad);
    cr.fill();

    // The line itself.
    cr.setLineWidth(1.7);
    cr.setLineJoin(1);
    setC(cr, lc);
    cr.moveTo(xAt(0), yAt(pts[0][1]));
    for (let i = 1; i < n; i++)
        cr.lineTo(xAt(i), yAt(pts[i][1]));
    cr.stroke();

    // X-axis labels: start, middle, end.
    const labelY = h - 4;
    const tStart = xr ? xr[0] : pts[0][0];
    const tMid = xr ? (xr[0] + xr[1]) / 2 : pts[Math.floor(n / 2)][0];
    const tEnd = xr ? xr[1] : pts[n - 1][0];
    drawText(cr, p.fmtTime(Math.round(tStart), p.axisFmt), PAD.l, labelY, 'left', colors.muted, small, p.fontFamily);
    drawText(cr, p.fmtTime(Math.round(tMid), p.axisFmt), PAD.l + pw / 2, labelY, 'center', colors.muted, small, p.fontFamily);
    drawText(cr, p.fmtTime(Math.round(tEnd), p.axisFmt), PAD.l + pw, labelY, 'right', colors.muted, small, p.fontFamily);

    // Hover crosshair and tooltip.
    const hi = p.hoverIdx;
    if (hi !== null && hi !== undefined && hi >= 0 && hi < n) {
        const x = xAt(hi);
        const y = yAt(pts[hi][1]);
        cr.setLineWidth(1);
        setC(cr, colors.text, 0.35);
        cr.moveTo(x, PAD.t);
        cr.lineTo(x, PAD.t + ph);
        cr.stroke();
        setC(cr, lc);
        cr.arc(x, y, 3.5, 0, 2 * Math.PI);
        cr.fill();
        const tip = `${p.prefix}${p.fmtNum(pts[hi][1], p.decimals)}   ${p.fmtTime(pts[hi][0], p.tipFmt).trim()}`;
        drawText(cr, tip, PAD.l, PAD.t - 5, 'left', colors.text, small, p.fontFamily);
    }
}
