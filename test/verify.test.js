import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {
    normalizeEmail, staticChecks, lookupMx, smtpProbe, decide, suggestDomain,
} from '../src/verify.js';
import { extractEmails, sourceContext } from '../src/extract.js';

// Fake SMTP server: accepts only mailboxes in `existing`, or everything if catchAll.
function fakeSmtp({ existing = [], catchAll = false, multilineEhlo = true } = {}) {
    const server = net.createServer((sock) => {
        sock.write('220 fake.mx ESMTP ready\r\n');
        let buf = '';
        sock.on('data', (d) => {
            buf += d.toString();
            let idx;
            while ((idx = buf.indexOf('\r\n')) >= 0) {
                const line = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                if (line.startsWith('EHLO')) {
                    // Send the multi-line reply split across two writes to test buffering.
                    if (multilineEhlo) { sock.write('250-fake.mx hello\r\n250-SIZE 1000'); setTimeout(() => sock.write('0\r\n250 OK\r\n'), 20); } else sock.write('250 OK\r\n');
                } else if (line.startsWith('MAIL FROM')) sock.write('250 OK\r\n');
                else if (line.startsWith('RCPT TO')) {
                    const addr = line.match(/<(.+)>/)[1];
                    sock.write(catchAll || existing.includes(addr) ? '250 OK\r\n' : '550 5.1.1 User unknown\r\n');
                } else if (line.startsWith('QUIT')) { sock.write('221 bye\r\n'); sock.end(); }
            }
        });
    });
    return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}
const connectTo = (server) => () => net.connect(server.address().port, '127.0.0.1');
const opts = { heloDomain: 'test.local', mailFrom: 'check@test.local' };

test('normalizeEmail strips scraping noise', () => {
    assert.equal(normalizeEmail(' mailto:Info@Example.COM?subject=hi '), 'info@example.com');
    assert.equal(normalizeEmail('<john@acme.io>.'), 'john@acme.io');
    assert.equal(normalizeEmail(42), null);
});

test('static checks: syntax, disposable, role, free, typo', () => {
    assert.equal(staticChecks('not-an-email').syntaxValid, false);
    assert.equal(staticChecks('a@mailinator.com').isDisposable, true);
    assert.equal(staticChecks('info@acme.com').isRoleBased, true);
    assert.equal(staticChecks('john@gmail.com').isFreeProvider, true);
    assert.equal(suggestDomain('gmial.com'), 'gmail.com');
    assert.equal(suggestDomain('acme-industries.com'), null);
});

test('lookupMx sorts by priority and falls back to A record', async () => {
    const resolver = { resolveMx: async () => [{ exchange: 'b.mx', priority: 20 }, { exchange: 'a.mx', priority: 10 }] };
    assert.deepEqual((await lookupMx('x.com', resolver)).mxHosts, ['a.mx', 'b.mx']);
    const noMx = { resolveMx: async () => { const e = new Error(); e.code = 'ENODATA'; throw e; }, resolve4: async () => ['1.2.3.4'] };
    assert.deepEqual(await lookupMx('y.com', noMx), { hasMx: true, mxHosts: ['y.com'], dnsError: null });
    const nx = { resolveMx: async () => { const e = new Error(); e.code = 'ENOTFOUND'; throw e; } };
    assert.equal((await lookupMx('z.invalid', nx)).dnsError, 'ENOTFOUND');
});

test('SMTP probe: existing vs missing mailbox, multi-line + split replies', async () => {
    const server = await fakeSmtp({ existing: ['real@acme.com'] });
    const r = await smtpProbe('ignored', ['real@acme.com', 'fake@acme.com'], { ...opts, connect: connectTo(server) });
    server.close();
    assert.equal(r.error, null);
    assert.equal(r.results['real@acme.com'].code, 250);
    assert.equal(r.results['fake@acme.com'].code, 550);
});

test('SMTP probe: unreachable server returns error, not a verdict', async () => {
    const r = await smtpProbe('127.0.0.1', ['a@b.com'], { ...opts, port: 1, timeoutMs: 2000 });
    assert.ok(r.error);
});

test('decide: verdicts and scores', () => {
    const mx = { hasMx: true, mxHosts: ['mx.acme.com'], dnsError: null };
    const c = staticChecks('john@acme.com');
    assert.equal(decide({ checks: c, mx, smtp: { code: 250, catchAll: false }, smtpEnabled: true }).status, 'valid');
    assert.equal(decide({ checks: c, mx, smtp: { code: 250, catchAll: true }, smtpEnabled: true }).status, 'catch_all');
    assert.equal(decide({ checks: c, mx, smtp: { code: 550, message: '5.1.1 User unknown' }, smtpEnabled: true }).status, 'invalid');
    // A policy block is not proof the mailbox is missing.
    assert.equal(decide({ checks: c, mx, smtp: { code: 550, message: 'Blocked by spam policy' }, smtpEnabled: true }).status, 'unknown');
    assert.equal(decide({ checks: c, mx, smtp: { code: 451 }, smtpEnabled: true }).status, 'unknown');
    assert.equal(decide({ checks: c, mx, smtp: { error: 'TIMEOUT' }, smtpEnabled: true }).status, 'unknown');
    assert.equal(decide({ checks: c, mx: { hasMx: false, mxHosts: [], dnsError: 'ENOTFOUND' }, smtp: null, smtpEnabled: true }).status, 'invalid');
    assert.equal(decide({ checks: staticChecks('x@mailinator.com'), mx: null, smtp: null, smtpEnabled: true }).status, 'disposable');
    const role = decide({ checks: staticChecks('info@acme.com'), mx, smtp: { code: 250, catchAll: false }, smtpEnabled: true });
    assert.equal(role.status, 'valid');
    assert.equal(role.score, 85);
});

test('extractEmails reads Google Maps Scraper fields', () => {
    const item = { title: 'Joe Pizza', website: 'https://joe.com', emails: ['joe@joe.com'], leadsEnrichment: [{ email: 'owner@joe.com' }] };
    assert.deepEqual(extractEmails(item), ['joe@joe.com', 'owner@joe.com']);
    assert.deepEqual(extractEmails({ contact: { email: 'a@b.com' } }, 'contact.email'), ['a@b.com']);
    assert.equal(sourceContext(item).sourceName, 'Joe Pizza');
});
