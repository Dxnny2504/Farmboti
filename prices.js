import { cents } from './store.js';
export function dkPrice(tiers) {
  if (!Array.isArray(tiers)) throw new Error('Preisstaffeln fehlen.');
  const tier = tiers.find(t => Number(t.stacks) === 54) || tiers.find(t => Number(t.stacks) === 1);
  if (!tier) throw new Error('Keine Staffel für 54 oder 1 Stack vorhanden. DK Preis bitte manuell angeben.');
  return cents(tier.totalPrice) * (Number(tier.stacks) === 54 ? 1 : 54);
}
const normalize = value => String(value ?? '').trim().toLocaleLowerCase('de-DE').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss').replace(/[^a-z0-9]/g, '');
const leaves = [
  { name: 'Eichenblätter', english: 'Oak Leaves', aliases: ['eichenlaub', 'eichenblatter', 'oakleaves'] },
  { name: 'Fichtenblätter', english: 'Spruce Leaves', aliases: ['fichtenlaub', 'fichtenblatter', 'spruceleaves'] },
  { name: 'Birkenblätter', english: 'Birch Leaves', aliases: ['birkenlaub', 'birkenblatter', 'birchleaves'] },
  { name: 'Dschungelblätter', english: 'Jungle Leaves', aliases: ['dschungellaub', 'dschungelblatter', 'tropenbaumlaub', 'tropenbaumblatter', 'tropenlaub', 'tropenblatter', 'jungleleaves'] },
  { name: 'Akazienblätter', english: 'Acacia Leaves', aliases: ['akazienlaub', 'akazienblatter', 'acacialeaves'] },
  { name: 'Schwarzeichenblätter', english: 'Dark Oak Leaves', aliases: ['schwarzeichenlaub', 'schwarzeichenblatter', 'dunkeleichenlaub', 'dunkeleichenblatter', 'darkoakleaves'] }
];
export async function lookup(base, query) {
  if (!base) throw new Error('PREISRECHNER_URL fehlt. Alternativ den DK Preis manuell angeben.');
  const raw = String(query || '').trim();
  const key = normalize(raw);
  const leaf = leaves.find(l => l.aliases.includes(key) || normalize(l.name) === key);
  const terms = leaf ? [leaf.name, leaf.english] : [raw];
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
    return leaf
      ? names.some(v => normalize(v) === normalize(leaf.name) || normalize(v) === normalize(leaf.english))
      : names.some(v => normalize(v) === key);
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
