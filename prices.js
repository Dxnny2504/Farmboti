import { cents } from './store.js';
export function dkPrice(tiers) {
  if (!Array.isArray(tiers)) throw new Error('Preisstaffeln fehlen.');
  const tier = tiers.find(t => Number(t.stacks) === 54) || tiers.find(t => Number(t.stacks) === 1);
  if (!tier) throw new Error('Keine Staffel für 54 oder 1 Stack vorhanden. DK Preis bitte manuell angeben.');
  return cents(tier.totalPrice) * (Number(tier.stacks) === 54 ? 1 : 54);
}
const aliases = new Map([
  ['tropenbaumlaub', 'Dschungelblätter'],
  ['tropenbaumblätter', 'Dschungelblätter'],
  ['tropenbaumblatter', 'Dschungelblätter'],
  ['tropenblätter', 'Dschungelblätter'],
  ['tropenlaub', 'Dschungelblätter'],
  ['jungle leaves', 'Dschungelblätter']
]);
const normalize = value => String(value ?? '').trim().toLocaleLowerCase('de-DE').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss').replace(/[^a-z0-9]/g, '');
export async function lookup(base, query) {
  if (!base) throw new Error('PREISRECHNER_URL fehlt. Alternativ den DK Preis manuell angeben.');
  const raw = String(query || '').trim();
  const key = normalize(raw);
  const jungle = ['tropenbaumlaub', 'tropenbaumblatter', 'tropenlaub', 'dschungelblatter', 'jungleleaves', '183'].includes(key);
  const terms = jungle ? ['Dschungelblätter', 'Jungle Leaves', '18:3', 'Tropenbaumlaub'] : [aliases.get(raw.toLocaleLowerCase('de-DE')) || raw];
  const candidates = [];
  for (const term of terms) {
    const url = new URL('/api/items/search', base);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('PREISRECHNER_URL ist ungültig.');
    url.searchParams.set('q', term);
    const response = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'error' });
    if (!response.ok) throw new Error('Preisrechner ist nicht erreichbar (HTTP ' + response.status + ').');
    const data = await response.json();
    if (!data.success || !Array.isArray(data.items)) throw new Error('Ungültige Antwort vom Preisrechner.');
    for (const item of data.items) {
      if (!candidates.some(existing => existing.id === item.id && existing.name === item.name)) candidates.push(item);
    }
  }
  const matches = candidates.filter(item => {
    const names = [item.name, item.originalName, item.id, item.itemId, item.legacyId, item.numericalId];
    return jungle
      ? names.some(v => ['dschungelblatter', 'jungleleaves', 'tropenbaumlaub', '183'].includes(normalize(v)))
      : names.some(v => normalize(v) === key || normalize(v) === normalize(terms[0]));
  });
  if (matches.length !== 1) {
    throw new Error(matches.length ? 'Mehrere passende Items gefunden. Bitte eine eindeutige Item ID verwenden.' : 'Item im Preisrechner nicht gefunden: ' + raw + '. Prüfe, ob es dort angelegt ist.');
  }
  const item = matches[0];
  let price;
  try { price = dkPrice(item.priceTiers); }
  catch { throw new Error('Item gefunden (' + item.name + '), aber kein gültiger Preis für 1 Stack oder 54 Stacks hinterlegt. Bitte im Preisrechner ergänzen oder DK Preis manuell angeben.'); }
  return { item: item.name, price: Math.round(price * 70 / 100), source: 'Preisrechner × 0,7' };
}
