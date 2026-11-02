import { cents } from './store.js';
export function dkPrice(tiers) {
  if (!Array.isArray(tiers)) throw new Error('Preisstaffeln fehlen.');
  const tier = tiers.find(t => Number(t.stacks) === 54) || tiers.find(t => Number(t.stacks) === 1);
  if (!tier) throw new Error('Keine Staffel für 54 oder 1 Stack vorhanden. DK Preis bitte manuell angeben.');
  return cents(tier.totalPrice) * (Number(tier.stacks) === 54 ? 1 : 54);
}
export async function lookup(base, query) {
  if (!base) throw new Error('PREISRECHNER_URL fehlt. Alternativ den DK Preis manuell angeben.');
  const url = new URL('/api/items/search', base);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('PREISRECHNER_URL ist ungültig.');
  url.searchParams.set('q', query);
  const response = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'error' });
  if (!response.ok) throw new Error('Preisrechner ist nicht erreichbar.');
  const data = await response.json();
  if (!data.success || !Array.isArray(data.items)) throw new Error('Ungültige Antwort vom Preisrechner.');
  const matches = data.items.filter(i => [i.name, i.id, i.numericalId].some(v => String(v).toLowerCase() === query.toLowerCase()));
  if (matches.length !== 1) throw new Error('Item nicht eindeutig gefunden. Bitte den exakten Namen oder die Item ID eingeben.');
  return { item: matches[0].name, price: Math.round(dkPrice(matches[0].priceTiers) * 70 / 100), source: 'Preisrechner × 0,7' };
}
