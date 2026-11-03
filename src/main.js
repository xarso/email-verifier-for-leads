import { Actor, log } from 'apify';
import {
    normalizeEmail, staticChecks, lookupMx, smtpProbe, randomLocalPart, decide, BILLABLE_STATUSES,
} from './verify.js';
import { extractEmails, sourceContext } from './extract.js';

const CHARGE_EVENT = 'email-verified';

async function collectInputs(input) {
    const map = new Map(); // email -> source item (first seen)
    const push = (raw, item) => {
        const e = normalizeEmail(raw);
        if (e && !map.has(e)) map.set(e, item || null);
    };
    for (const e of input.emails || []) push(e, null);

    if (input.datasetId) {
        const dataset = await Actor.openDataset(input.datasetId, { forceCloud: true });
        const pageSize = 1000;
        for (let offset = 0; ; offset += pageSize) {
            const { items } = await dataset.getData({ offset, limit: pageSize, clean: true });
            for (const item of items) extractEmails(item, input.emailField).forEach((e) => push(e, item));
            if (items.length < pageSize) break;
        }
    }
    return map;
}

await Actor.init();

const input = (await Actor.getInput()) || {};
// The mailbox (SMTP) check needs outbound port 25, which the Apify cloud blocks.
// It stays off until an SMTP relay is configured through the SMTP_ENABLED env var.
const smtpEnabled = process.env.SMTP_ENABLED === 'true';
const concurrency = Math.min(Math.max(input.concurrency || 10, 1), 50);
const heloDomain = input.heloDomain || 'mail.verifier.local';
const mailFrom = input.mailFrom || `check@${heloDomain}`;
const maxEmails = input.maxEmails || 0;

const emailMap = await collectInputs(input);
let entries = [...emailMap.entries()];
if (maxEmails > 0) entries = entries.slice(0, maxEmails);

if (!entries.length) {
    await Actor.fail('No emails found. Provide "emails" or a "datasetId" whose items contain email fields.');
}
log.info(`Verifying ${entries.length} unique emails (SMTP check: ${smtpEnabled ? 'on' : 'off'}, concurrency ${concurrency}).`);

// Per-domain caches: MX lookups and catch-all status are shared by every address on a domain.
const mxCache = new Map();
const catchAllCache = new Map();

async function verifyOne(email) {
    const checks = staticChecks(email);
    if (!checks.syntaxValid || checks.isDisposable) return decide({ checks, mx: null, smtp: null, smtpEnabled });

    if (!mxCache.has(checks.domain)) mxCache.set(checks.domain, lookupMx(checks.domain));
    const mx = await mxCache.get(checks.domain);
    if (!mx.hasMx || !smtpEnabled) return decide({ checks, mx, smtp: null, smtpEnabled });

    const knownCatchAll = catchAllCache.get(checks.domain);
    const probeAddresses = knownCatchAll === undefined ? [email, `${randomLocalPart()}@${checks.domain}`] : [email];

    let probe = null;
    for (const host of mx.mxHosts.slice(0, 2)) {
        probe = await smtpProbe(host, probeAddresses, { heloDomain, mailFrom });
        if (!probe.error) break;
    }
    const r = probe.results[email];
    let catchAll = knownCatchAll;
    if (catchAll === undefined && !probe.error) {
        const fake = probe.results[probeAddresses[1]];
        if (fake) {
            catchAll = fake.code === 250 || fake.code === 251;
            catchAllCache.set(checks.domain, catchAll);
        }
    }
    const smtp = probe.error || !r ? { error: probe.error || 'NO_RCPT_RESPONSE' } : { ...r, catchAll };
    return decide({ checks, mx, smtp, smtpEnabled });
}

let processed = 0;
let billed = 0;
let stop = false;
const counts = {};

async function worker(queue) {
    while (!stop && queue.length) {
        const [email, item] = queue.shift();
        let result;
        try {
            result = await verifyOne(email);
        } catch (err) {
            // Never write customer emails to logs: log only the domain and the error.
            log.warning(`Failed to verify an address on ${email.split('@')[1] || 'unknown domain'}: ${err.message}`);
            result = { ...staticChecks(email), status: 'unknown', score: 0, reason: 'Internal error' };
            delete result.local;
        }
        const row = { email, ...result, ...sourceContext(item), verifiedAt: new Date().toISOString() };
        await Actor.pushData(row);
        counts[row.status] = (counts[row.status] || 0) + 1;
        processed += 1;

        // Users only pay for decisive results; "unknown" is free.
        if (BILLABLE_STATUSES.has(row.status)) {
            const charge = await Actor.charge({ eventName: CHARGE_EVENT });
            billed += 1;
            if (charge.eventChargeLimitReached) {
                log.info('Maximum charge reached, stopping.');
                stop = true;
            }
        }
        if (processed % 100 === 0) log.info(`Progress: ${processed}/${entries.length}`);
    }
}

const queue = [...entries];
await Promise.all(Array.from({ length: concurrency }, () => worker(queue)));

const summary = { total: processed, billed, byStatus: counts };
await Actor.setValue('SUMMARY', summary);
log.info(`Done. ${JSON.stringify(summary)}`);
await Actor.exit();
