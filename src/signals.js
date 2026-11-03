// Lead-quality signals that need no SMTP (port 25): does the email belong to the
// business's own domain, who hosts the mail, and is the business website up.

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

export function detectMailProvider(mxHosts) {
    if (!Array.isArray(mxHosts) || !mxHosts.length) return null;
    for (const host of mxHosts) {
        const h = `.${String(host).toLowerCase().replace(/\.$/, '')}`;
        for (const [re, name] of PROVIDERS) if (re.test(h)) return name;
    }
    return 'Other / self-hosted';
}

// Is the website reachable? true = server answered, false = domain or server is gone,
// null = could not tell (timeout, blocked). Never throws.
const DEAD_CODES = new Set(['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET']);

export async function checkWebsite(url, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
    const tryOnce = async (u) => {
        const res = await fetchImpl(u, {
            method: 'GET',
            redirect: 'follow',
            signal: AbortSignal.timeout(timeoutMs),
            headers: { 'user-agent': 'Mozilla/5.0 (compatible; LeadQualityCheck/1.0)', accept: 'text/html,*/*' },
        });
        try { await res.body?.cancel(); } catch { /* ignore */ }
        return res.status < 500;
    };
    const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    try {
        return await tryOnce(target);
    } catch (err) {
        const code = err?.cause?.code || err?.code;
        if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return null;
        if (code && /CERT|SSL|TLS/i.test(code)) return true; // a server is there, just a bad certificate
        if (code === 'ECONNREFUSED' && target.startsWith('https://')) {
            try { return await tryOnce(target.replace(/^https:/, 'http:')); } catch { return false; }
        }
        if (code && DEAD_CODES.has(code)) return false;
        return null;
    }
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
    const mailProvider = result.hasMx ? detectMailProvider(mxHosts) : null;

    let { score } = result;
    const notes = [];
    if (DELIVERABLE.has(result.status)) {
        if (matchesBusinessWebsite) { score += 10; notes.push("matches the business's website"); }
        if (result.isFreeProvider && siteDomain) { score -= 10; notes.push('personal inbox although the business has its own domain'); }
        if (MANAGED_PROVIDERS.has(mailProvider)) score += 5;
        if (websiteAlive === false) { score -= 25; notes.push('business website is down'); }
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
