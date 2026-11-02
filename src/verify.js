// Core email verification logic. Network access (DNS, SMTP) is injected so the
// logic can be unit-tested without a network.
import { promises as dnsPromises } from 'node:dns';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const DISPOSABLE = new Set(
    readFileSync(new URL('./data/disposable.txt', import.meta.url), 'utf8')
        .split('\n')
        .map((l) => l.trim().toLowerCase())
        .filter(Boolean),
);

const ROLE_PREFIXES = new Set([
    'admin', 'administrator', 'billing', 'booking', 'bookings', 'careers', 'contact', 'contacto',
    'enquiries', 'enquiry', 'finance', 'hello', 'help', 'hr', 'info', 'informacion', 'inquiries',
    'jobs', 'kontakt', 'mail', 'marketing', 'media', 'no-reply', 'noreply', 'office', 'orders',
    'press', 'reception', 'reservations', 'sales', 'service', 'support', 'team', 'webmaster',
]);

const FREE_PROVIDERS = new Set([
    'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'yahoo.fr', 'yahoo.de', 'ymail.com',
    'hotmail.com', 'hotmail.co.uk', 'hotmail.fr', 'hotmail.de', 'outlook.com', 'live.com', 'msn.com',
    'icloud.com', 'me.com', 'mac.com', 'aol.com', 'gmx.com', 'gmx.de', 'gmx.net', 'web.de',
    'mail.com', 'proton.me', 'protonmail.com', 'yandex.com', 'yandex.ru', 'zoho.com', 'mail.ru',
]);

// Common domains used for typo suggestions.
const TYPO_TARGETS = [
    'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'aol.com', 'live.com',
    'gmx.com', 'gmx.de', 'web.de', 'yandex.com', 'protonmail.com',
];

// Practical syntax check (not full RFC 5322, which allows things no real mailbox uses).
const EMAIL_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export function normalizeEmail(raw) {
    if (typeof raw !== 'string') return null;
    // Strip mailto:, surrounding spaces/brackets and trailing punctuation scraped from web pages.
    let e = raw.trim().replace(/^mailto:/i, '').replace(/^[<("'\s]+|[>)"'.,;:\s]+$/g, '');
    e = e.split('?')[0];
    return e ? e.toLowerCase() : null;
}

function levenshtein(a, b) {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            dp[i][j] = Math.min(
                dp[i - 1][j] + 1,
                dp[i][j - 1] + 1,
                dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
            );
        }
    }
    return dp[a.length][b.length];
}

export function suggestDomain(domain) {
    if (TYPO_TARGETS.includes(domain)) return null;
    let best = null;
    for (const t of TYPO_TARGETS) {
        const d = levenshtein(domain, t);
        // Distance 2 only for longer domains, so short real domains (gmx.at) aren't flagged.
        const allowed = d === 1 || (d === 2 && domain.length >= 9);
        if (d > 0 && allowed && (!best || d < best.d)) best = { t, d };
    }
    return best ? best.t : null;
}

export function staticChecks(email) {
    const syntaxValid = EMAIL_RE.test(email) && email.length <= 254 && email.split('@')[0].length <= 64;
    const [local = '', domain = ''] = email.split('@');
    return {
        syntaxValid,
        local,
        domain,
        isDisposable: syntaxValid && DISPOSABLE.has(domain),
        isRoleBased: ROLE_PREFIXES.has(local.split('+')[0]),
        isFreeProvider: FREE_PROVIDERS.has(domain),
        didYouMean: syntaxValid ? suggestDomain(domain) : null,
    };
}

export async function lookupMx(domain, resolver = dnsPromises, retried = false) {
    try {
        const records = await resolver.resolveMx(domain);
        const hosts = records
            .filter((r) => r.exchange && r.exchange !== '.')
            .sort((a, b) => a.priority - b.priority)
            .map((r) => r.exchange);
        if (hosts.length) return { hasMx: true, mxHosts: hosts, dnsError: null };
        return { hasMx: false, mxHosts: [], dnsError: 'NO_MX' };
    } catch (err) {
        // RFC 5321 fallback: a domain with an A record and no MX can still receive mail.
        if (err.code === 'ENODATA') {
            try {
                const a = await resolver.resolve4(domain);
                if (a.length) return { hasMx: true, mxHosts: [domain], dnsError: null };
            } catch { /* fall through */ }
        }
        // Re-check before calling a domain dead: a single resolver hiccup must not produce a billed "invalid".
        if (!retried && ['ENOTFOUND', 'ETIMEOUT', 'ESERVFAIL', 'ECONNREFUSED'].includes(err.code)) {
            await new Promise((r) => setTimeout(r, 300));
            return lookupMx(domain, resolver, true);
        }
        return { hasMx: false, mxHosts: [], dnsError: err.code || 'DNS_ERROR' };
    }
}

// One SMTP conversation: EHLO, MAIL FROM, RCPT TO for each address, QUIT.
// Returns the RCPT response code per address, or an error if the server could not be reached.
export function smtpProbe(host, addresses, { heloDomain, mailFrom, timeoutMs = 12000, port = 25, connect = net.connect } = {}) {
    return new Promise((resolve) => {
        const results = {};
        const steps = [
            { cmd: null, expect: 220 }, // greeting
            { cmd: `EHLO ${heloDomain}`, expect: 250 },
            { cmd: `MAIL FROM:<${mailFrom}>`, expect: 250 },
            ...addresses.map((a) => ({ cmd: `RCPT TO:<${a}>`, rcpt: a })),
        ];
        let step = 0;
        let buffer = '';
        let done = false;
        const socket = connect(port, host);

        const finish = (error = null) => {
            if (done) return;
            done = true;
            try { socket.write('QUIT\r\n'); } catch { /* ignore */ }
            socket.destroy();
            resolve({ error, results });
        };

        socket.setTimeout(timeoutMs, () => finish('TIMEOUT'));
        socket.on('error', (e) => finish(e.code || 'CONNECTION_ERROR'));
        socket.on('close', () => finish(step < steps.length ? 'CONNECTION_CLOSED' : null));

        const sendNext = () => {
            step += 1;
            if (step >= steps.length) return finish();
            socket.write(`${steps[step].cmd}\r\n`);
        };

        socket.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            if (!buffer.endsWith('\n')) return; // wait for complete lines
            // A complete reply ends with a line "NNN text" (space after code, not dash).
            const lines = buffer.split(/\r?\n/);
            const last = lines.filter(Boolean).pop() || '';
            if (!/^\d{3} /.test(last) && !/^\d{3}$/.test(last)) return;
            buffer = '';
            const code = parseInt(last.slice(0, 3), 10);
            const current = steps[step];
            if (current.rcpt) {
                results[current.rcpt] = { code, message: last.slice(4, 200) };
                return sendNext();
            }
            if (code !== current.expect) return finish(`SMTP_${current.cmd ? current.cmd.split(' ')[0] : 'GREETING'}_${code}`);
            return sendNext();
        });
    });
}

export function randomLocalPart() {
    return `zz${randomBytes(6).toString('hex')}`;
}

// Turns raw signals into a verdict, a 0-100 score and a human-readable reason.
export function decide({ checks, mx, smtp, smtpEnabled }) {
    const base = { ...checks };
    delete base.local;
    const out = (status, score, reason, smtpCode = null) => ({
        ...base,
        hasMx: mx ? mx.hasMx : false,
        mxHost: mx && mx.mxHosts.length ? mx.mxHosts[0] : null,
        smtpCode,
        isCatchAll: smtp && typeof smtp.catchAll === 'boolean' ? smtp.catchAll : null,
        status,
        score,
        reason,
    });

    if (!checks.syntaxValid) return out('invalid', 0, 'Invalid email syntax');
    // A typo of a big provider (gmial.com) is a dead lead even if the typo domain exists or is a trap.
    if (checks.didYouMean && (checks.isDisposable || !mx || !mx.hasMx)) {
        return out('invalid', 1, `Likely typo of ${checks.didYouMean}`);
    }
    if (checks.isDisposable) return out('disposable', 5, 'Disposable / temporary email provider');
    if (!mx.hasMx) {
        if (['ENOTFOUND', 'NO_MX', 'ENODATA'].includes(mx.dnsError)) return out('invalid', 2, 'Domain has no mail server');
        return out('unknown', 40, `DNS lookup failed (${mx.dnsError})`);
    }

    const roleAdj = checks.isRoleBased ? -10 : 0;
    if (!smtpEnabled) return out('valid_domain', 70 + roleAdj, 'Domain receives email; mailbox not checked');
    if (!smtp || smtp.error) return out('unknown', 50 + roleAdj, `Mail server did not answer (${smtp ? smtp.error : 'no attempt'})`);

    const code = smtp.code;
    if (code >= 500 && code < 600) {
        // 550/551/553 = mailbox does not exist. Other 5xx (e.g. policy blocks) are not proof.
        if ([550, 551, 553].includes(code) && !/(block|spam|policy|reputation|denied|banned)/i.test(smtp.message || '')) {
            return out('invalid', 3, 'Mailbox does not exist', code);
        }
        return out('unknown', 40 + roleAdj, `Mail server refused the check (${code})`, code);
    }
    if (code >= 400) return out('unknown', 50 + roleAdj, `Temporary error / greylisting (${code})`, code);
    if (code === 250 || code === 251) {
        if (smtp.catchAll) return out('catch_all', 60 + roleAdj, 'Domain accepts every address; mailbox cannot be confirmed', code);
        return out('valid', 95 + roleAdj, checks.isRoleBased ? 'Mailbox exists (role / shared address)' : 'Mailbox exists', code);
    }
    return out('unknown', 45 + roleAdj, `Unexpected SMTP response (${code})`, code);
}

// Statuses we are confident about. Only these are billed.
export const BILLABLE_STATUSES = new Set(['valid', 'valid_domain', 'invalid', 'disposable', 'catch_all']);
