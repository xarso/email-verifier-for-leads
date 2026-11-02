// Pulls emails out of one dataset item. Works with Google Maps Scraper output
// (emails[], leadsEnrichment[].email) and any dataset with an email field.
export function extractEmails(item, customField) {
    const found = [];
    const add = (v) => {
        if (typeof v === 'string') found.push(v);
        else if (Array.isArray(v)) v.forEach(add);
    };
    if (customField) {
        const value = customField.split('.').reduce((o, k) => (o == null ? undefined : o[k]), item);
        add(value);
    } else {
        add(item.email);
        add(item.emails);
        if (Array.isArray(item.leadsEnrichment)) item.leadsEnrichment.forEach((l) => add(l && l.email));
    }
    return found;
}

// Context copied from the source item so the output is a usable lead list.
export function sourceContext(item) {
    if (!item) return {};
    const pick = (v) => (typeof v === 'string' || typeof v === 'number' ? v : null);
    return {
        sourceName: pick(item.title) ?? pick(item.name) ?? pick(item.companyName),
        sourceWebsite: pick(item.website) ?? pick(item.url),
        sourcePhone: pick(item.phone),
        sourceCategory: pick(item.categoryName),
        sourceCity: pick(item.city),
    };
}

