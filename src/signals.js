// Lead-quality signals that need no SMTP (port 25): does the email belong to the
// business's own domain, who hosts the mail, and is the business website up.
import { promises as dnsPromises } from 'node:dns';
import net from 'node:net';

// Second-level public suffixes common in lead data (foo.co.uk -> registrable "foo.co.uk").
const MULTI_PART_SUFFIXES = new Set([
    'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'ltd.uk', 'plc.uk', 'me.uk',
    'com.au', 'net.au', 'org.au', 'co.nz', 'org.nz', 'co.za', 'com.br', 'com.mx', 'com.ar',
    'co.jp', 'co.kr', 'com.cn', 'com.hk', 'com.sg', 'com.my', 'com.tr', 'com.pl', 'co.in',
    'co.il', 'com.ua', 'com.ro', 'co.at', 'or.at', 'com.es', 'com.co', 'com.pe', 'com.ph',
]);

export function registrableDomain(host) {
    if (!host || typeof host !== 'string') return null;
    const parts = host.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
    if (parts.length < 2) return null;
    const lastTwo = parts.slice(-2).join('.');
    if (MULTI_PART_SUFFIXES.has(lastTwo) && parts.length >= 3) return parts.slice(-3).join('.');
    return lastTwo;
}

export function hostFromUrl(url) {
    if (!url || typeof url !== 'string') return null;
    try {
        return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase();
    } catch {
        return null;
    }
}

// Google Maps links are not the business's own website.
export function isGoogleMapsUrl(url) {
    const host = hostFromUrl(url);
    return !!host && (/(^|\.)google\.[a-z.]+$/.test(host) || host === 'goo.gl' || host === 'maps.app.goo.gl');
}

// Mail host patterns -> provider name. Order matters: first match wins.
const PROVIDERS = [
    [/\.google\.com$|\.googlemail\.com$/, 'Google Workspace'],
    [/\.protection\.outlook\.com$|\.outlook\.com$|\.hotmail\.com$/, 'Microsoft 365'],
    [/\.zoho\.(com|eu|in)$/, 'Zoho Mail'],
    [/\.mimecast\.com$/, 'Mimecast'],
    [/\.pphosted\.com$|\.ppe-hosted\.com$/, 'Proofpoint'],
    [/\.barracudanetworks\.com$/, 'Barracuda'],
    [/\.secureserver\.net$/, 'GoDaddy'],
    [/\.ionos\.(com|de|co\.uk|es|fr)$|\.1and1\.|\.kundenserver\.de$/, 'IONOS'],
    [/\.ovh\.net$/, 'OVH'],
    [/\.privateemail\.com$|\.registrar-servers\.com$/, 'Namecheap'],
    [/\.yahoodns\.net$/, 'Yahoo'],
    [/\.icloud\.com$/, 'iCloud'],
    [/\.gmx\.net$|\.web\.de$/, 'GMX / Web.de'],
    [/\.yandex\.(net|ru)$/, 'Yandex'],
    [/\.messagingengine\.com$/, 'Fastmail'],
    [/\.protonmail\.ch$/, 'Proton Mail'],
    [/\.emailsrvr\.com$/, 'Rackspace'],
    [/\.hostinger\.com$/, 'Hostinger'],
    [/\.titan\.email$/, 'Titan'],
];

// Providers with well-run, actively managed business inboxes.
const MANAGED_PROVIDERS = new Set(['Google Workspace', 'Microsoft 365', 'Zoho Mail', 'Mimecast', 'Proofpoint', 'Barracuda', 'Fastmail', 'Proton Mail', 'Rackspace']);

// Consumer inboxes: same mail servers as the business products, but personal accounts.
const PERSONAL_LABELS = [
    [/^(gmail|googlemail)\.com$/, 'Gmail (personal)'],
    [/^(outlook|hotmail|live|msn)\.[a-z.]+$/, 'Outlook.com (personal)'],
    [/^(yahoo|ymail)\.[a-z.]+$/, 'Yahoo (personal)'],
    [/^(icloud|me|mac)\.com$/, 'iCloud (personal)'],
];

export function personalProviderLabel(domain) {
    for (const [re, label] of PERSONAL_LABELS) if (re.test(domain || '')) return label;
    return 'Free / personal provider';
}

export function detectMailProvider(mxHosts) {
    if (!Array.isArray(mxHosts) || !mxHosts.length) return null;
    for (const host of mxHosts) {
        const h = `.${String(host).toLowerCase().replace(/\.$/, '')}`;
        for (const [re, name] of PROVIDERS) if (re.test(h)) return name;
    }
    return 'Other / self-hosted';
}

// Is the website still online? Checks that the hostname resolves and that a web server
// accepts connections on 443 or 80. No page is downloaded, so bot protection on the site
// can't distort the answer. true = online, false = domain or server is gone,
// null = could not tell (timeout). Never throws.
function tcpOpen(host, port, timeoutMs, connect) {
    return new Promise((resolve) => {
        let settled = false;
        const done = (v) => { if (!settled) { settled = true; try { socket.destroy(); } catch { /* ignore */ } resolve(v); } };
        const socket = connect({ host, port });
        socket.setTimeout(timeoutMs, () => done('timeout'));
        socket.once('connect', () => done('open'));
        socket.once('error', (e) => done(e.code || 'error'));
    });
}

export async function checkWebsite(url, { lookup = dnsPromises.lookup, connect = net.connect, timeoutMs = 5000 } = {}) {
    const host = hostFromUrl(url);
    if (!host) return null;
    const candidates = host.startsWith('www.') ? [host, host.slice(4)] : [host, `www.${host}`];
    let sawTimeout = false;
    for (const h of candidates) {
        try {
            await lookup(h);
        } catch (err) {
            if (err.code === 'ENOTFOUND' || err.code === 'ENODATA') continue; // this name doesn't exist
            sawTimeout = true; // resolver trouble: can't conclude
            continue;
        }
        for (const port of [443, 80]) {
            const r = await tcpOpen(h, port, timeoutMs, connect);
            if (r === 'open') return true;
            if (r === 'timeout') sawTimeout = true;
        }
    }
    return sawTimeout ? null : false;
}

const DELIVERABLE = new Set(['valid', 'valid_domain', 'catch_all']);

export function qualityLabel(status, score) {
    if (status === 'invalid' || status === 'disposable') return 'bad';
    if (status === 'unknown') return 'unknown';
    if (score >= 80) return 'high';
    if (score >= 60) return 'medium';
    return 'low';
}

// Adds lead-quality fields to a verification result and adjusts the score.
export function enrich(result, { sourceWebsite = null, mxHosts = [], websiteAlive = null } = {}) {
    const emailDomain = registrableDomain(result.domain);
    const siteDomain = registrableDomain(hostFromUrl(sourceWebsite));
    const matchesBusinessWebsite = siteDomain && emailDomain ? siteDomain === emailDomain : null;
    let mailProvider = null;
    if (result.hasMx) mailProvider = result.isFreeProvider ? personalProviderLabel(result.domain) : detectMailProvider(mxHosts);

    let { score } = result;
    const notes = [];
    if (DELIVERABLE.has(result.status)) {
        // The strongest signal for scraped leads: the email sits on the business's own domain.
        if (matchesBusinessWebsite) { score += 15; notes.push("matches the business's website"); }
        if (result.isFreeProvider && siteDomain) { score -= 10; notes.push('personal inbox although the business has its own domain'); }
        if (MANAGED_PROVIDERS.has(mailProvider)) score += 5;
        // A dead website usually means a closed business: never better than "low".
        if (websiteAlive === false) { score = Math.min(score - 25, 55); notes.push('business website is down'); }
        score = Math.max(1, Math.min(99, score));
    }
    return {
        ...result,
        score,
        reason: notes.length ? `${result.reason}; ${notes.join('; ')}` : result.reason,
        quality: qualityLabel(result.status, score),
        matchesBusinessWebsite,
        mailProvider,
        websiteAlive,
    };
}
