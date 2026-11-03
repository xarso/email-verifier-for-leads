import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    registrableDomain, hostFromUrl, isGoogleMapsUrl, detectMailProvider, checkWebsite, enrich, qualityLabel,
} from '../src/signals.js';
import { sourceContext } from '../src/extract.js';

test('registrableDomain handles subdomains and multi-part suffixes', () => {
    assert.equal(registrableDomain('www.joespizza.com'), 'joespizza.com');
    assert.equal(registrableDomain('mail.shop.co.uk'), 'shop.co.uk');
    assert.equal(registrableDomain('acme.com.au'), 'acme.com.au');
    assert.equal(registrableDomain('localhost'), null);
    assert.equal(hostFromUrl('https://www.Joe.com/?utm_source=google'), 'www.joe.com');
    assert.equal(hostFromUrl('joe.com'), 'joe.com');
});

test('Google Maps links are not treated as the business website', () => {
    assert.equal(isGoogleMapsUrl('https://www.google.com/maps/place/Joe'), true);
    assert.equal(isGoogleMapsUrl('https://maps.app.goo.gl/abc'), true);
    assert.equal(isGoogleMapsUrl('https://joespizza.com'), false);
    const ctx = sourceContext({ title: 'Joe', url: 'https://www.google.com/maps/place/Joe' });
    assert.equal(ctx.sourceWebsite, null);
    assert.equal(sourceContext({ title: 'Joe', website: 'https://joe.com', url: 'https://www.google.com/maps/x' }).sourceWebsite, 'https://joe.com');
});

test('detectMailProvider recognises common hosts', () => {
    assert.equal(detectMailProvider(['aspmx.l.google.com']), 'Google Workspace');
    assert.equal(detectMailProvider(['acme-com.mail.protection.outlook.com']), 'Microsoft 365');
    assert.equal(detectMailProvider(['us-smtp-inbound-2.mimecast.com']), 'Mimecast');
    assert.equal(detectMailProvider(['mx1.acme.com']), 'Other / self-hosted');
    assert.equal(detectMailProvider([]), null);
});

const fakeFetch = (behaviour) => async () => {
    if (behaviour instanceof Error) throw behaviour;
    return { status: behaviour, body: { cancel: async () => {} } };
};
const netError = (code) => Object.assign(new TypeError('fetch failed'), { cause: { code } });

test('checkWebsite: alive, dead, unknown', async () => {
    assert.equal(await checkWebsite('joe.com', { fetchImpl: fakeFetch(200) }), true);
    assert.equal(await checkWebsite('joe.com', { fetchImpl: fakeFetch(403) }), true); // bot-blocked but online
    assert.equal(await checkWebsite('joe.com', { fetchImpl: fakeFetch(503) }), false);
    assert.equal(await checkWebsite('joe.com', { fetchImpl: fakeFetch(netError('ENOTFOUND')) }), false);
    assert.equal(await checkWebsite('joe.com', { fetchImpl: fakeFetch(netError('CERT_HAS_EXPIRED')) }), true);
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    assert.equal(await checkWebsite('joe.com', { fetchImpl: fakeFetch(timeout) }), null);
});

const base = (over = {}) => ({
    domain: 'joespizza.com', isFreeProvider: false, hasMx: true, status: 'valid_domain', score: 70,
    reason: 'Domain receives email; mailbox not checked', ...over,
});

test('enrich: matching website + managed provider raises the score', () => {
    const r = enrich(base(), { sourceWebsite: 'https://www.joespizza.com/', mxHosts: ['aspmx.l.google.com'], websiteAlive: true });
    assert.equal(r.matchesBusinessWebsite, true);
    assert.equal(r.mailProvider, 'Google Workspace');
    assert.equal(r.score, 85);
    assert.equal(r.quality, 'high');
    assert.match(r.reason, /matches the business's website/);
});

test('enrich: dead website and personal inbox lower the score', () => {
    const dead = enrich(base(), { sourceWebsite: 'https://joespizza.com', mxHosts: ['mx.joespizza.com'], websiteAlive: false });
    assert.equal(dead.score, 55);
    assert.equal(dead.quality, 'low');
    assert.match(dead.reason, /website is down/);
    const personal = enrich(base({ domain: 'gmail.com', isFreeProvider: true }), {
        sourceWebsite: 'https://joespizza.com', mxHosts: ['gmail-smtp-in.l.google.com'], websiteAlive: true,
    });
    assert.equal(personal.matchesBusinessWebsite, false);
    assert.equal(personal.score, 65);
});

test('enrich leaves invalid results alone and handles missing data', () => {
    const bad = enrich(base({ status: 'invalid', score: 2, hasMx: false }), { sourceWebsite: 'https://joespizza.com' });
    assert.equal(bad.score, 2);
    assert.equal(bad.quality, 'bad');
    assert.equal(bad.mailProvider, null);
    const noSite = enrich(base(), { mxHosts: ['aspmx.l.google.com'] });
    assert.equal(noSite.matchesBusinessWebsite, null);
    assert.equal(qualityLabel('unknown', 50), 'unknown');
});
