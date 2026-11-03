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
  const searchTerm = aliases.get(String(query).trim().toLocaleLowerCase('de-DE')) || query;
  if (!base) throw new Error('PREISRECHNER_URL fehlt. Alternativ den DK Preis manuell angeben.');
  const url = new URL('/api/items/search', base);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('PREISRECHNER_URL ist ungültig.');
  url.searchParams.set('q', searchTerm);
  const response = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'error' });
  if (!response.ok) throw new Error('Preisrechner ist nicht erreichbar.');
  const data = await response.json();
  if (!data.success || !Array.isArray(data.items)) throw new Error('Ungültige Antwort vom Preisrechner.');
  const matches = data.items.filter(i => [i.name, i.id, i.numericalId].some(v => String(v).toLowerCase() === String(searchTerm).toLowerCase() || normalize(v) === normalize(searchTerm)));
  if (matches.length !== 1) throw new Error('Item nicht eindeutig gefunden. Bitte den exakten Namen oder die Item ID eingeben.');
  return { item: matches[0].name, price: Math.round(dkPrice(matches[0].priceTiers) * 70 / 100), source: 'Preisrechner × 0,7' };
}
