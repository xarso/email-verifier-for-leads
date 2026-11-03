# Email Verifier for Leads (Google Maps ready)

Clean the emails from your **Google Maps Scraper** results, or any lead list, in one step. Paste the dataset ID from your scrape and get back a ready-to-use lead list: every email with a **valid domain / invalid / disposable / typo** verdict, a **lead quality rating (high / medium / low)**, and the **business name, website, phone and city** right next to it.

**You only pay for decisive results.** If a domain's DNS can't be checked, the email is marked `unknown` and you are not charged for it.

## Why use this email verifier?

- **Built for scraped leads.** Point it at a Google Maps Scraper dataset and it finds emails in `email`, `emails` and `leadsEnrichment` automatically. No CSV exports, no copy-paste.
- **Scores the lead, not just the address.** Tells you whether the email belongs to the business's own domain, who hosts its mail (Google Workspace, Microsoft 365...) and whether the business website is still online. A dead website usually means a closed business.
- **Keeps the context.** Each verified email stays attached to the business it came from, so the output is a lead list you can import straight into your outreach tool.
- **Fast and cheap.** Thousands of emails in minutes, with mail-server lookups shared across every address on the same domain.
- **Fair billing.** Unknown results are free.
- **Protects your sender reputation.** Remove invalid and disposable addresses before a cold email campaign and keep your bounce rate low.

## What it checks

| Check | What it means |
|---|---|
| Syntax | The address is well-formed |
| Typo suggestion | `john@gmial.com` → suggests `gmail.com` |
| Disposable | Temporary inbox providers (10,000+ domains) |
| Role address | Shared inboxes like `info@`, `sales@`, `support@` |
| Free provider | Gmail, Yahoo, Outlook and similar |
| Mail server (MX) | The domain can receive email |
| Matches business website | The email uses the same domain as the business's website (e.g. `info@joespizza.com` for joespizza.com) |
| Mail provider | Google Workspace, Microsoft 365, Zoho, GoDaddy, self-hosted... |
| Website online | The business website (or the email's domain) still answers |

> **Coming soon:** mailbox-level (SMTP) verification and catch-all detection.

## How to verify emails from Google Maps

1. Run [Google Maps Scraper](https://apify.com/compass/crawler-google-places) with contact details enabled.
2. Copy the **dataset ID** from the run's Storage tab.
3. Paste it into **Dataset ID** here and click **Start**.
4. Download the verified list as CSV, Excel or JSON, or send it on with Make, Zapier or n8n.

You can also paste a plain list of emails into **Emails**.

## Input

```json
{
    "datasetId": "YOUR_DATASET_ID",
    "emails": ["info@example.com"],
    "checkWebsite": true,
    "maxEmails": 0,
    "concurrency": 10
}
```

## Output

One row per unique email:

```json
{
    "email": "info@joespizza.com",
    "status": "valid_domain",
    "quality": "high",
    "score": 80,
    "reason": "Domain receives email; mailbox not checked; matches the business's website",
    "sourceName": "Joe's Pizza",
    "sourceWebsite": "https://joespizza.com",
    "sourcePhone": "+1 212 555 0100",
    "sourceCity": "New York",
    "matchesBusinessWebsite": true,
    "mailProvider": "Google Workspace",
    "websiteAlive": true,
    "isRoleBased": true,
    "isFreeProvider": false,
    "isDisposable": false,
    "didYouMean": null,
    "mxHost": "mx.joespizza.com"
}
```

### Status values

- `valid_domain` — well-formed, not disposable, and the domain receives email. Score is lower for shared inboxes like `info@`.
- `invalid` — bad syntax, a typo of a big provider (`gmial.com`), or a domain with no mail server. Remove it.
- `disposable` — a temporary inbox. Remove it.
- `unknown` — the domain's DNS couldn't be checked. **Not charged.**

### Lead quality

- `high` — deliverable domain plus strong signals (e.g. matches the business website, managed mail provider). Send first.
- `medium` — deliverable, fewer signals (e.g. shared `info@` inbox, unknown provider).
- `low` — deliverable domain but warning signs (e.g. business website is down). Send last or skip.
- `bad` — invalid or disposable. Remove.

Filter on `quality` to send to your best leads first.

A run summary with counts per status is saved as `SUMMARY` in the key-value store.

## Pricing

Pay per event: you are charged once per email with a decisive result (`valid_domain`, `invalid`, `disposable`). `unknown` results are free.

## FAQ

**Does it send emails?** No. It only checks the address format and the domain's mail records.

**Does it confirm the mailbox exists?** Not yet. Mailbox-level (SMTP) checks are coming in the next version.

**Can I use it from my own code or an AI agent?** Yes, through the Apify API, the official clients, or the Apify MCP server.

**Is it legal?** Verifying that an address can receive mail is standard practice for email hygiene. You are responsible for how you use the contacts and for complying with anti-spam and data protection laws (such as CAN-SPAM and GDPR) in your outreach.

## Feedback

Found a wrong verdict or need a field added? Open an issue on the Actor's Issues tab and it will be looked at quickly.
