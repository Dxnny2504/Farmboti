import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, amount, cents, remaining } from './store.js';
import { dkPrice, lookup } from './prices.js';
import { randomUUID } from 'node:crypto';
const request = () => randomUUID();
function setup(t, partial = true) {
  const s = new Store(':memory:'); t.after(() => s.db.close());
  const o = s.create({ item: 'Sand', dk: 2, price: 3234600, bonus: 10, partial }, 'manager', request());
  o.message = 'message'; s.put(o); return { s, id: o.id };
}
test('Exaktes Sandbeispiel mit deutschem Dezimaltrennzeichen', () => {
  assert.equal(cents('32346,00'), 3234600);
  assert.deepEqual(amount(3234600, 2, 10), { base: 6469200, extra: 646920, total: 7116120 });
  assert.throws(() => cents('32.346,00'));
  for (const n of [NaN, Infinity, -1, 0, 1.5]) assert.throws(() => amount(100, n, 10));
});
test('Reservierungen überschreiten nie die verfügbare Menge', t => {
  const { s, id } = setup(t);
  s.change(id, 'a', 'take', { dk: 1 }, false, request());
  assert.throws(() => s.change(id, 'b', 'take', { dk: 2 }, false, request()));
  s.change(id, 'b', 'take', { dk: 1 }, false, request());
  assert.equal(remaining(s.get(id)), 0);
  assert.throws(() => s.change(id, 'c', 'take', { dk: 1 }, false, request()));
});
test('Gleiche Discord Interaktion wird nicht doppelt gebucht', t => {
  const { s, id } = setup(t); const r = request();
  s.change(id, 'a', 'take', { dk: 1 }, false, r);
  assert.throws(() => s.change(id, 'a', 'take', { dk: 1 }, false, r));
  assert.equal(s.get(id).claims.length, 1);
});
test('Berechtigungen, Reihenfolge und doppelte Auszahlung', t => {
  const { s, id } = setup(t); const o = s.change(id, 'farmer', 'take', { dk: 2 }, false, request());
  const arg = { claim: o.claims[0].id };
  assert.throws(() => s.change(id, 'other', 'ready', arg, true, request()));
  assert.throws(() => s.change(id, 'manager', 'pay', arg, true, request()));
  assert.throws(() => s.change(id, 'manager', 'cancel', {}, true, request()));
  s.change(id, 'farmer', 'ready', arg, false, request());
  assert.throws(() => s.change(id, 'farmer', 'receive', arg, false, request()));
  s.change(id, 'manager', 'receive', arg, true, request());
  assert.throws(() => s.change(id, 'farmer', 'pay', arg, false, request()));
  s.change(id, 'manager', 'pay', arg, true, request());
  assert.throws(() => s.change(id, 'manager', 'pay', arg, true, request()));
  assert.equal(s.get(id).claims[0].total, 7116120);
  assert.equal(s.get(id).claims[0].paidBy, 'manager');
});
test('Freigabe und gesperrte Teilmengen', t => {
  const { s, id } = setup(t, false);
  assert.throws(() => s.change(id, 'a', 'take', { dk: 1 }, false, request()));
  const o = s.change(id, 'a', 'take', { dk: 2 }, false, request());
  s.change(id, 'a', 'release', { claim: o.claims[0].id }, false, request());
  assert.equal(remaining(s.get(id)), 2);
  assert.throws(() => s.change(id, 'a', 'cancel', {}, false, request()));
  s.change(id, 'manager', 'cancel', {}, true, request());
  assert.throws(() => s.change(id, 'a', 'take', { dk: 2 }, false, request()));
});
test('Reservierung und Preis bleiben nach Neustart erhalten', () => {
  const dir = mkdtempSync(join(tmpdir(), 'farmboti-test-')); const path = join(dir, 'db.sqlite');
  let s;
  try {
    s = new Store(path); const o = s.create({ item: 'Sand', dk: 2, price: 3234600, bonus: 10, partial: true }, 'manager', request());
    o.message = 'message'; s.put(o); s.change(o.id, 'a', 'take', { dk: 2 }, false, request());
    s.db.close(); s = new Store(path);
    assert.equal(s.get(o.id).claims[0].total, 7116120); assert.equal(remaining(s.get(o.id)), 0);
  } finally { s?.db.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('Preisstaffeln: DK bevorzugt, sonst Stack mal 54, kein erfundener Preis', () => {
  assert.equal(dkPrice([{ stacks: 1, totalPrice: 600 }, { stacks: 54, totalPrice: 32346 }]), 3234600);
  assert.equal(dkPrice([{ stacks: 1, totalPrice: 599 }]), 3234600);
  assert.throws(() => dkPrice([{ stacks: 9, totalPrice: 100 }]));
  assert.throws(() => dkPrice([]));
  assert.throws(() => dkPrice([{ stacks: 54, totalPrice: -1 }]));
});
test('Preisadapter liest das bestehende API Format ohne Provision', async t => {
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(url.pathname, '/api/items/search'); assert.equal(url.searchParams.get('q'), 'Sand');
    return { ok: true, json: async () => ({ success: true, items: [{ name: 'Sand', id: 'sand', priceTiers: [{ stacks: 54, totalPrice: 32346 }] }] }) };
  });
  assert.deepEqual(await lookup('https://example.com', 'Sand'), { item: 'Sand', price: 3234600, source: 'Preisrechner' });
  await assert.rejects(lookup('', 'Sand'));
});
test('Mehrdeutige und fehlende Items werden abgewiesen', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ success: true, items: [{ name: 'Sand' }, { name: 'Sand' }] }) }));
  await assert.rejects(lookup('https://example.com', 'Sand'));
  await assert.rejects(lookup('https://example.com', 'Kies'));
});
function recurring(t) {
  const s = new Store(':memory:'); t.after(() => s.db.close());
  const o = s.create({ item: 'Sand', dk: 5, price: 3234600, bonus: 10, partial: true, recurring: true }, 'manager', request());
  o.message = 'message'; s.put(o); return { s, id: o.id };
}
test('Dauerauftrag: fünf DK Kapazität, Auffüllen erst bei Wareneingang', t => {
  const { s, id } = recurring(t);
  const c = s.change(id, 'farmer', 'take', { dk: 5 }, false, request()).claims[0];
  assert.equal(c.total, 17790300);
  assert.equal(remaining(s.get(id)), 0);
  s.change(id, 'farmer', 'ready', { claim: c.id }, false, request());
  assert.equal(remaining(s.get(id)), 0);
  s.change(id, 'manager', 'receive', { claim: c.id }, true, request());
  assert.equal(remaining(s.get(id)), 5);
  s.change(id, 'other', 'take', { dk: 5 }, false, request());
  s.change(id, 'manager', 'pay', { claim: c.id }, true, request());
  assert.equal(remaining(s.get(id)), 0, 'Zahlung füllt nicht ein zweites Mal auf');
  assert.equal(s.get(id).claims[0].status, 'paid');
  assert.equal(s.get(id).claims[1].status, 'reserved');
});
test('Teillieferung gibt exakt ihre Menge frei, wiederholte Bestätigung scheitert', t => {
  const { s, id } = recurring(t);
  const c = s.change(id, 'a', 'take', { dk: 2 }, false, request()).claims[0];
  s.change(id, 'b', 'take', { dk: 3 }, false, request());
  s.change(id, 'a', 'ready', { claim: c.id }, false, request());
  s.change(id, 'manager', 'receive', { claim: c.id }, true, request());
  assert.equal(remaining(s.get(id)), 2);
  assert.throws(() => s.change(id, 'manager', 'receive', { claim: c.id }, true, request()));
  assert.throws(() => s.change(id, 'c', 'take', { dk: 3 }, false, request()));
  assert.equal(remaining(s.get(id)), 2);
});
test('Pause blockiert alte Annahmeformulare, aber nicht bestehende Lieferungen', t => {
  const { s, id } = recurring(t);
  const c = s.change(id, 'a', 'take', { dk: 2 }, false, request()).claims[0];
  assert.throws(() => s.change(id, 'a', 'pause', {}, false, request()));
  s.change(id, 'manager', 'pause', {}, true, request());
  assert.throws(() => s.change(id, 'b', 'take', { dk: 1 }, false, request()));
  s.change(id, 'a', 'ready', { claim: c.id }, false, request());
  s.change(id, 'manager', 'receive', { claim: c.id }, true, request());
  assert.equal(s.get(id).paused, true);
  assert.throws(() => s.change(id, 'b', 'take', { dk: 1 }, false, request()));
  s.change(id, 'manager', 'resume', {}, true, request());
  s.change(id, 'b', 'take', { dk: 5 }, false, request());
  assert.equal(remaining(s.get(id)), 0);
});
test('Doppelter Dauerauftrag ist auch während Pause gesperrt', t => {
  const { s, id } = recurring(t);
  s.change(id, 'manager', 'pause', {}, true, request());
  assert.throws(() => s.create({ item: 'sand', dk: 5, price: 100, bonus: 10, recurring: true }, 'manager', request()));
  s.change(id, 'manager', 'cancel', {}, true, request());
  assert.throws(() => s.change(id, 'manager', 'resume', {}, true, request()));
  assert.doesNotThrow(() => s.create({ item: 'Sand', dk: 5, price: 100, bonus: 10, recurring: true }, 'manager', request()));
});
test('Alte Aufträge ohne neue Felder behalten das bisherige Mengenverhalten', t => {
  const { s, id } = setup(t);
  const o = s.get(id); delete o.recurring; delete o.paused; s.put(o);
  const c = s.change(id, 'a', 'take', { dk: 2 }, false, request()).claims[0];
  s.change(id, 'a', 'ready', { claim: c.id }, false, request());
  s.change(id, 'manager', 'receive', { claim: c.id }, true, request());
  assert.equal(remaining(s.get(id)), 0);
  assert.throws(() => s.change(id, 'manager', 'pause', {}, true, request()));
});
