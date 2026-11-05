// Fallback provider: gold-api.com (keyless, live spot price for four metals).
// No GNOME imports, so it can be unit-tested with plain Node.

const BY_SYMBOL = {
    'XAUUSD=X': 'XAU', 'GC=F': 'XAU',
    'XAGUSD=X': 'XAG', 'SI=F': 'XAG',
    'XPTUSD=X': 'XPT', 'PL=F': 'XPT',
    'XPDUSD=X': 'XPD', 'PA=F': 'XPD',
};

// Returns 'XAU' | 'XAG' | 'XPT' | 'XPD', or null when gold-api.com has no equivalent.
// A tracker whose symbol is written GOLDAPI:XAU always uses gold-api.com.
export function goldapiCode(symbol) {
    const s = String(symbol ?? '').toUpperCase();
    if (BY_SYMBOL[s])
        return BY_SYMBOL[s];
    const m = /^GOLDAPI:(XAU|XAG|XPT|XPD)$/.exec(s);
    return m ? m[1] : null;
}

export function goldapiOnly(symbol) {
    return /^GOLDAPI:/i.test(String(symbol ?? ''));
}

export function goldapiUrl(code) {
    return `https://api.gold-api.com/price/${code}`;
}

// -> {price, ts} with ts in unix seconds.
export function parseGoldApi(json) {
    const price = json?.price;
    if (typeof price !== 'number' || !Number.isFinite(price))
        throw new Error('Bad response from gold-api.com');
    let ts = Date.parse(json.updatedAt) / 1000;
    if (!Number.isFinite(ts))
        ts = Math.floor(Date.now() / 1000);
    return {price, ts: Math.floor(ts)};
}
