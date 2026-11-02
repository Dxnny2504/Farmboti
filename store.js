import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label} muss zwischen ${min} und ${max} liegen.`);
  return value;
}
export function cents(value) {
  const n = Number(String(value).trim().replace(',', '.'));
  if (!Number.isFinite(n) || n < 0.01 || n > 1000000000) throw new Error('Preis ungültig. Ohne Tausenderpunkte eingeben, z. B. 32346,00.');
  return Math.round(n * 100);
}
export function amount(price, dk, bonus) {
  integer(price, 1, 100000000000, 'Preis'); integer(dk, 1, 10000, 'DK'); integer(bonus, 0, 100, 'Aufwand');
  const base = price * dk;
  const extra = Number((BigInt(base) * BigInt(bonus) + 50n) / 100n);
  return { base, extra, total: base + extra };
}
// Recurring capacity becomes available only after staff confirms receipt.
// Ordinary orders continue counting received and paid deliveries against their total.
export const remaining = o => o.dk - o.claims.filter(c => o.recurring
  ? ['reserved', 'ready'].includes(c.status)
  : c.status !== 'released').reduce((sum, c) => sum + c.dk, 0);
export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY);');
  }
  all() { return this.db.prepare('SELECT payload FROM orders ORDER BY rowid DESC').all().map(r => JSON.parse(r.payload)); }
  get(id) { const row = this.db.prepare('SELECT payload FROM orders WHERE id=?').get(id); if (!row) throw new Error('Auftrag nicht gefunden.'); return JSON.parse(row.payload); }
  put(o) { this.db.prepare('INSERT INTO orders VALUES (?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(o.id, JSON.stringify(o)); }
  transaction(request, fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.db.prepare('SELECT 1 FROM requests WHERE id=?').get(request)) throw new Error('Diese Aktion wurde bereits verarbeitet.');
      const result = fn();
      this.db.prepare('INSERT INTO requests VALUES (?)').run(request);
      this.db.exec('COMMIT'); return result;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  create(data, actor, request) {
    return this.transaction(request, () => {
      const item = String(data.item || '').trim();
      if (!item || item.length > 100) throw new Error('Itemname fehlt oder ist zu lang.');
      const note = String(data.note || '').trim();
      if (note.length > 500) throw new Error('Notiz darf maximal 500 Zeichen haben.');
      amount(data.price, data.dk, data.bonus);
      if (data.recurring && this.all().some(o => o.recurring && !o.cancelled && o.item.toLowerCase() === item.toLowerCase())) throw new Error('Für dieses Item besteht bereits ein Dauerauftrag. Nutze den vorhandenen Auftrag.');
      const o = { id: randomUUID(), item, dk: data.dk, price: data.price, bonus: data.bonus, partial: !!data.partial, recurring: !!data.recurring, paused: false, note, source: data.source || 'Manuell', creator: actor, created: Date.now(), cancelled: false, claims: [], message: null, dirty: true };
      this.put(o); return o;
    });
  }
  change(id, actor, action, args, team, request) {
    return this.transaction(request, () => {
      const o = this.get(id);
      if (['pause', 'resume'].includes(action)) {
        if (!team) throw new Error('Nur freigegebene Teamrollen dürfen Daueraufträge verwalten.');
        if (!o.recurring || o.cancelled) throw new Error('Kein aktiver Dauerauftrag.');
        if (!!o.paused === (action === 'pause')) throw new Error('Dieser Status ist bereits gesetzt.');
        o.paused = action === 'pause';
        o.history = [...(o.history || []), { action, actor, at: Date.now() }];
      } else if (action === 'cancel') {
        if (!team) throw new Error('Nur freigegebene Teamrollen dürfen stornieren.');
        if (o.cancelled) throw new Error('Auftrag ist bereits storniert.');
        if (o.claims.some(c => !['released', 'paid'].includes(c.status))) throw new Error('Es bestehen noch aktive Reservierungen.');
        o.cancelled = true;
      } else if (action === 'take') {
        if (o.cancelled || o.paused || !o.message) throw new Error('Auftrag ist nicht verfügbar.');
        integer(args.dk, 1, 10000, 'DK');
        if (args.dk > remaining(o) || (!o.partial && args.dk !== remaining(o))) throw new Error('Diese Menge ist nicht verfügbar oder Teilmengen sind nicht erlaubt.');
        o.claims.push({ id: randomUUID(), user: actor, dk: args.dk, status: 'reserved', ...amount(o.price, args.dk, o.bonus), created: Date.now(), history: [{ action, actor, at: Date.now() }] });
      } else {
        const c = o.claims.find(c => c.id === args.claim);
        if (!c) throw new Error('Reservierung nicht gefunden.');
        const transitions = { ready: ['reserved', 'ready'], release: ['reserved', 'released'], receive: ['ready', 'received'], pay: ['received', 'paid'] };
        const t = transitions[action];
        if (!t) throw new Error('Unbekannte Aktion.');
        if (['receive', 'pay'].includes(action) ? !team : c.user !== actor) throw new Error('Keine Berechtigung für diese Aktion.');
        if (c.status !== t[0]) throw new Error('Der Status hat sich geändert. Bitte die Übersicht erneut öffnen.');
        c.status = t[1]; c.history.push({ action, actor, at: Date.now() });
        if (action === 'pay') { c.paidAt = Date.now(); c.paidBy = actor; }
      }
      o.dirty = true; this.put(o); return o;
    });
  }
}
