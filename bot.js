import { Client, GatewayIntentBits, Events, MessageFlags, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, escapeMarkdown } from 'discord.js';
import { createServer } from 'node:http';
import { Store, cents, remaining, amount } from './store.js';
import { lookup } from './prices.js';

const env = process.env;
for (const key of ['DISCORD_TOKEN', 'GUILD_ID', 'FARM_CHANNEL_ID', 'MANAGER_ROLE_IDS']) if (!env[key]?.trim()) throw new Error(`${key} fehlt.`);
if (!/^\d{17,20}$/.test(env.ADMIN_CHANNEL_ID || '')) throw new Error('ADMIN_CHANNEL_ID fehlt oder ist ungültig.');
const ids = s => (s || '').split(',').map(v => v.trim()).filter(Boolean);
const managers = ids(env.MANAGER_ROLE_IDS), farmers = ids(env.FARMER_ROLE_IDS);
for (const id of [env.GUILD_ID, env.FARM_CHANNEL_ID, ...managers, ...farmers]) if (!/^\d{17,20}$/.test(id)) throw new Error('Ungültige Discord ID in der Konfiguration.');
const store = new Store(env.DATA_PATH || './data/farmboti.sqlite');
const client = new Client({ intents: [GatewayIntentBits.Guilds], allowedMentions: { parse: [] } });
const money = n => (n / 100).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' $';
const safe = s => escapeMarkdown(String(s));
const states = { reserved: '🟡 In Bearbeitung', ready: '📦 Bereit zur Abgabe', received: '💰 Auszahlung offen', paid: '✅ Ausgezahlt', released: '↩ Freigegeben' };
const button = (id, label, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
const row = (...buttons) => new ActionRowBuilder().addComponents(buttons);
const privateReply = (i, content) => i.reply({ content, flags: MessageFlags.Ephemeral });
const option = (name, description, type, required = false, extra = {}) => ({ name, description, type, required, ...extra });
const commands = [
  { name: 'auftrag', description: 'Farmauftrag erstellen · nur Shopteam', options: [
    option('item', 'Exakter Itemname oder Item ID im Preisrechner', 3, true, { max_length: 100 }),
    option('dk', 'Anzahl ganzer Doppelkisten', 4, true, { min_value: 1, max_value: 10000 }),
    option('preis', 'Optionaler Preis pro DK ohne Tausenderpunkte, z. B. 32346,00', 3),
    option('aufwand', 'Zusätzlicher Aufwand in Prozent, Standard 0', 4, false, { min_value: 0, max_value: 100 }),
    option('teilmengen', 'Teilmengen erlauben, Standard ja', 5),
    option('notiz', 'Abgabeort oder Hinweise', 3, false, { max_length: 500 }) ] },
  { name: 'panel', description: 'Bedienfenster im Farmerchannel veröffentlichen · nur Shopteam' },
  { name: 'meine', description: 'Eigene Reservierungen und Auszahlungen ansehen' },
  { name: 'pruefen', description: 'Lieferungen und offene Auszahlungen prüfen · nur Shopteam' },
  { name: 'stornieren', description: 'Auftrag ohne aktive Reservierungen schließen · nur Shopteam', options: [option('id', 'Vollständige Auftrags ID aus dem Auftrag', 3, true)] }
].map(c => ({ ...c, dm_permission: false, default_member_permissions: ['auftrag', 'panel', 'pruefen', 'stornieren'].includes(c.name) ? '0' : null }));

function orderPayload(o) {
  const open = remaining(o), total = o.dk * o.price;
  const embed = new EmbedBuilder().setColor(o.cancelled ? 0x747f8d : 0x3ba55c).setTitle(`🌾 ${o.dk} DK ${safe(o.item)} gesucht`)
    .setDescription(`Erstellt von <@${o.creator}>${o.note ? '\n\n' + safe(o.note) : ''}`)
    .addFields(
      { name: 'Noch verfügbar', value: `${o.cancelled ? 0 : open} DK`, inline: true },
      { name: 'Preis pro DK', value: money(o.price), inline: true },
      { name: 'Aufwand', value: `${o.bonus} %`, inline: true },
      { name: 'Gesamter Warenwert', value: money(total), inline: true },
      { name: 'Auszahlung für den Gesamtauftrag', value: money(amount(o.price, o.dk, o.bonus).total), inline: true },
      { name: 'Status', value: o.cancelled ? 'Geschlossen' : open ? '🟢 Verfügbar' : 'Vollständig vergeben' },
      { name: 'Auftrags ID', value: o.id })
    ;
  return { embeds: [embed], components: [row(button(`take:${o.id}`, '🌾 Auftrag annehmen', ButtonStyle.Success).setDisabled(o.cancelled || !open), button(`status:${o.id}`, 'Mein Status'), button(`claimants:${o.id}`, 'Übernahmen ansehen'))], allowedMentions: { parse: [] } };
}
let syncing = false;
async function sync() {
  if (syncing || !client.isReady()) return;
  syncing = true;
  try {
    const channel = await client.channels.fetch(env.FARM_CHANNEL_ID);
    if (!channel?.isTextBased() || channel.guildId !== env.GUILD_ID) throw new Error('Farmerchannel ist ungültig.');
    for (const o of store.all().filter(o => o.dirty)) {
      try {
        const snapshot = JSON.stringify(o);
        const payload = orderPayload(o);
        if (o.message) await channel.messages.edit(o.message, payload);
        else {
          const msg = await channel.send({ ...payload, nonce: o.id.replaceAll('-', '').slice(0, 24), enforceNonce: true });
          o.message = msg.id;
        }
        const latest = store.get(o.id);
        latest.message = o.message;
        latest.dirty = JSON.stringify(store.get(o.id)) !== snapshot;
        store.put(latest);
      } catch (error) { console.error('Auftragssynchronisierung fehlgeschlagen:', o.id, error.code || error.name); }
    }
  } finally { syncing = false; }
}
function overview(user, teamView, page = 0) {
  const all = store.all().flatMap(o => o.claims.map(c => ({ o, c }))).filter(({ c }) => teamView ? c.status !== 'released' : c.user === user);
  const max = Math.max(0, Math.ceil(all.length / 4) - 1);
  page = Math.max(0, Math.min(max, page));
  const slice = all.slice(page * 4, page * 4 + 4);
  const embeds = slice.map(({ o, c }) => new EmbedBuilder().setColor(0x3ba55c).setTitle(`${c.dk} DK ${safe(o.item)}`)
    .setDescription(`${states[c.status]}\nFarmer: <@${c.user}>\nWarenwert: ${money(c.base)}\nAufwand: ${money(c.extra)}\n**Auszahlung: ${money(c.total)}**${c.paidAt ? `\nBestätigt von <@${c.paidBy}> am <t:${Math.floor(c.paidAt / 1000)}:f>` : ''}`)
    .setFooter({ text: `Beleg / Reservierung: ${c.id}` }));
  const components = slice.map(({ o, c }) => {
    const key = `${o.id}:${c.id}`;
    if (teamView) return c.status === 'ready' || c.status === 'received' ? row(button(`${c.status === 'ready' ? 'receive' : 'confirm'}:${key}`, `${c.status === 'ready' ? 'Wareneingang' : 'Auszahlung'} bestätigen`, ButtonStyle.Success)) : null;
    return c.status === 'reserved' ? row(button(`ready:${key}`, '📦 Zur Abgabe bereit', ButtonStyle.Success), button(`release:${key}`, 'Freigeben')) : null;
  }).filter(Boolean);
  const prefix = teamView ? 'management' : 'mine';
  if (max) components.push(row(button(`${prefix}:${page - 1}`, 'Zurück').setDisabled(!page), button(`${prefix}:${page + 1}`, 'Weiter').setDisabled(page === max)));
  const paid = all.filter(({ c }) => c.status === 'paid').reduce((sum, { c }) => sum + c.total, 0);
  return { content: teamView ? `**Auftragsverwaltung** · Seite ${page + 1}/${max + 1}${all.length ? '' : '\nKeine Auftragsübernahmen vorhanden.'}` : `**Meine Aufträge** · Seite ${page + 1}/${max + 1}\nBisher ausgezahlt: ${money(paid)}${all.length ? '' : '\nDu hast noch keine Aufträge angenommen.'}`, embeds, components, allowedMentions: { parse: [] } };
}
function modal(id, title, fields) {
  return new ModalBuilder().setCustomId(id).setTitle(title).addComponents(...fields.map(([id, label, value, required = true]) => row(new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setRequired(required).setMaxLength(id === 'item' ? 100 : 50).setValue(value))));
}
client.on(Events.InteractionCreate, async i => {
  if (!(i.isChatInputCommand() || i.isButton() || i.isModalSubmit())) return;
  try {
    if (i.guildId !== env.GUILD_ID) return await privateReply(i, 'Dieser Bot ist für einen anderen Server eingerichtet.');
    // Fetch live roles: neither cached roles nor administrator permissions bypass the allowlist.
    const member = await i.guild.members.fetch({ user: i.user.id, force: true });
    const team = member.permissions.has(PermissionFlagsBits.Administrator);
    const management = team || managers.some(id => member.roles.cache.has(id));
    const farmer = !farmers.length || farmers.some(id => member.roles.cache.has(id));
    const parts = (i.customId || '').split(':');
    const action = i.isChatInputCommand() ? i.commandName : parts[0];
    const staff = ['auftrag', 'panel', 'pruefen', 'stornieren', 'create', 'new', 'review', 'receive', 'confirm', 'pay'];
    if (action === 'management' && !management) return await privateReply(i, 'Nur Management und Administratoren dürfen diese Übersicht sehen.');
    if (staff.includes(action) && !team) return await privateReply(i, '🔒 Dafür brauchst du eine freigegebene Teamrolle.');
    if (action === 'claimants' && !management) return await privateReply(i, '🔒 Nur Management und Administratoren können Übernahmen einsehen.');
    if (['take', 'reserve'].includes(action) && !farmer) return await privateReply(i, 'Dafür brauchst du eine Farmerrolle.');
    if (action === 'status' || action === 'claimants') {
      const o = store.get(parts[1]);
      const claims = o.claims.filter(claim => action === 'claimants' || claim.user === i.user.id);
      const visible = claims.filter(claim => claim.status !== 'released');
      const title = action === 'status' ? 'Dein Auftragsstatus' : 'Auftragsübernahmen';
      const lines = visible.map(claim => `${action === 'claimants' ? '<@' + claim.user + '> · ' : ''}${claim.dk} DK · ${states[claim.status]} · Auszahlung: ${money(claim.total)}`);
      const content = `**${title}: ${safe(o.item)}**\n${lines.length ? lines.join('\n').slice(0, 1750) : action === 'status' ? 'Du hast diesen Auftrag noch nicht angenommen.' : 'Noch niemand hat diesen Auftrag angenommen.'}`;
      if (action === 'status') {
        const active = visible.filter(claim => claim.status === 'reserved').slice(0, 4);
        const components = active.map(claim => row(
          button(`ready:${o.id}:${claim.id}`, `${claim.dk} DK zur Lieferung freigeben`, ButtonStyle.Success),
          button(`release:${o.id}:${claim.id}`, `${claim.dk} DK Reservierung aufheben`)
        ));
        return await i.reply({ content, components, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      }
      return await privateReply(i, content);
    }
    if (action === 'create') return await i.showModal(modal('new', 'Farmauftrag erstellen', [['item', 'Itemname oder Item ID', ''], ['dk', 'Ganze DK', '2'], ['preis', 'DK Preis (leer = Preisrechner)', '', false], ['bonus', 'Zusätzlicher Aufwand in Prozent', '0']]));
    if (action === 'take') {
      const o = store.get(parts[1]);
      if (o.cancelled || !remaining(o)) throw new Error('Auftrag ist nicht mehr verfügbar.');
      return await i.showModal(modal(`reserve:${o.id}`, 'Auftrag übernehmen', [['dk', `Ganze DK (noch ${remaining(o)})`, String(o.partial ? 1 : remaining(o))]]));
    }
    if (action === 'confirm') {
      const o = store.get(parts[1]), c = o.claims.find(c => c.id === parts[2]);
      if (!c || c.status !== 'received') throw new Error('Keine offene Auszahlung für diese Reservierung.');
      return await privatePayment(i, o, c);
    }
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    if (['meine', 'mine', 'pruefen', 'review', 'management'].includes(action)) return await i.editReply(overview(i.user.id, ['pruefen', 'review', 'management'].includes(action), Number(parts[1]) || 0));
    if (action === 'panel') {
      const channel = await client.channels.fetch(env.ADMIN_CHANNEL_ID);
      if (!channel?.isTextBased() || channel.guildId !== env.GUILD_ID) throw new Error('Adminchannel ist ungültig.');
      await channel.send({ embeds: [new EmbedBuilder().setColor(0x5865f2).setTitle('🌾 Farmboti | Verwaltung').setDescription('Erstelle Farmaufträge und prüfe, welche Farmer sie übernommen haben.\n\nDie Auftragsverwaltung zeigt Farmer, Mengen, Bearbeitungsstatus und Auszahlungen.')], components: [row(button('create', '＋ Auftrag erstellen', ButtonStyle.Primary), button('management:0', 'Übernahmen verwalten'), button('review:0', 'Lieferungen prüfen'))] });
      return await i.editReply('Adminpanel im privaten Adminchannel veröffentlicht.');
    }
    if (['auftrag', 'new'].includes(action)) {
      const slash = i.isChatInputCommand();
      const item = (slash ? i.options.getString('item') : i.fields.getTextInputValue('item')).trim();
      const rawPrice = slash ? i.options.getString('preis') : i.fields.getTextInputValue('preis');
      const quote = rawPrice?.trim() ? { item, price: cents(rawPrice), source: 'Manuell' } : await lookup(env.PREISRECHNER_URL, item);
      const o = store.create({ ...quote, dk: slash ? i.options.getInteger('dk') : Number(i.fields.getTextInputValue('dk')), bonus: slash ? i.options.getInteger('aufwand') ?? 0 : Number(i.fields.getTextInputValue('bonus')), partial: slash ? i.options.getBoolean('teilmengen') ?? true : true, note: slash ? i.options.getString('notiz') : '' }, i.user.id, i.id);
      await sync();
      return await i.editReply(`Auftrag gespeichert: ${o.id}\n${store.get(o.id).message ? 'Im Farmerchannel veröffentlicht.' : 'Veröffentlichung wird automatisch erneut versucht.'}`);
    }
    if (action === 'stornieren') {
      store.change(i.options.getString('id').trim(), i.user.id, 'cancel', {}, team, i.id);
      await sync(); return await i.editReply('Auftrag geschlossen.');
    }
    if (action === 'reserve') {
      const o = store.change(parts[1], i.user.id, 'take', { dk: Number(i.fields.getTextInputValue('dk')) }, team, i.id);
      const c = o.claims.at(-1);
      await sync(); return await i.editReply(`✅ ${c.dk} DK ${safe(o.item)} reserviert. Vereinbarte Auszahlung: **${money(c.total)}**\nÜber „Mein Status“ beim Auftrag kannst du die Lieferung freigeben oder die Reservierung aufheben.`);
    }
    if (['ready', 'release', 'receive', 'pay'].includes(action)) {
      const o = store.change(parts[1], i.user.id, action, { claim: parts[2] }, team, i.id);
      await sync();
      const c = o.claims.find(c => c.id === parts[2]);
      if (action === 'ready') {
        try {
          const adminChannel = await client.channels.fetch(env.ADMIN_CHANNEL_ID);
          if (!adminChannel?.isTextBased() || adminChannel.guildId !== env.GUILD_ID) throw new Error('Farmpanel Channel nicht erreichbar.');
          const notice = new EmbedBuilder()
            .setColor(0xf1c40f)
            .setTitle('📦 Neue Lieferung zur Prüfung')
            .setDescription(`<@${c.user}> hat eine Lieferung zur Abgabe freigegeben.`)
            .addFields(
              { name: 'Item', value: safe(o.item), inline: true },
              { name: 'Menge', value: `${c.dk} DK`, inline: true },
              { name: 'Auszahlung', value: money(c.total), inline: true },
              { name: 'Status', value: states[c.status] },
              { name: 'Auftrag', value: o.id }
            );
          await adminChannel.send({
            embeds: [notice],
            components: [row(button('management:0', 'Übernahmen verwalten', ButtonStyle.Primary), button('review:0', 'Lieferung prüfen', ButtonStyle.Success))],
            allowedMentions: { parse: [] }
          });
        } catch (notifyError) {
          console.error('Farmpanel Benachrichtigung fehlgeschlagen:', notifyError.code || notifyError.message);
        }
      }
      return await i.editReply(`${states[c.status]}\nReservierung: ${c.id}\nAuszahlung: ${money(c.total)}${action === 'pay' ? '\nDie manuell erfolgte Zahlung wurde dokumentiert.' : action === 'ready' ? '\nDeine Lieferung wurde zur Prüfung durch das Shopteam freigegeben.' : ''}`);
    }
    throw new Error('Unbekannte Aktion. Bitte /meine oder /pruefen verwenden.');
  } catch (error) {
    console.error('Aktion fehlgeschlagen:', error.code || error.name);
    const content = error.code || error.name !== 'Error' ? 'Aktion fehlgeschlagen. Bitte die Übersicht erneut öffnen und noch einmal versuchen.' : error.message;
    try { if (i.deferred || i.replied) await i.editReply({ content, embeds: [], components: [] }); else await privateReply(i, content); } catch {}
  }
});
async function privatePayment(i, o, c) {
  return i.reply({ flags: MessageFlags.Ephemeral, content: `Hast du **${money(c.total)}** an <@${c.user}> im Spiel bezahlt?\nDieser Button dokumentiert die Zahlung. Er überweist kein Geld.`, components: [row(button(`pay:${o.id}:${c.id}`, 'Ja, Zahlung ist erfolgt', ButtonStyle.Success))], allowedMentions: { parse: [] } });
}
client.once(Events.ClientReady, async () => {
  try {
    const guild = await client.guilds.fetch(env.GUILD_ID);
    await guild.commands.set(commands);
    console.log('Farmboti bereit. Befehle registriert.');
    await sync();
  } catch (error) { console.error('Start fehlgeschlagen:', error.code || error.name); process.exitCode = 1; clearInterval(timer); client.destroy(); server.close(); }
});
const timer = setInterval(() => sync().catch(e => console.error('Synchronisierung:', e.code || e.name)), 15000);
const server = createServer((req, res) => { res.writeHead(req.url === '/health' && client.isReady() ? 200 : 503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ready: client.isReady() })); });
server.listen(Number(env.PORT || 8080), '0.0.0.0');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { clearInterval(timer); client.destroy(); server.close(); store.db.close(); process.exit(0); });
client.login(env.DISCORD_TOKEN).catch(e => { console.error('Discord Anmeldung fehlgeschlagen:', e.code || e.name); clearInterval(timer); server.close(); process.exitCode = 1; client.destroy(); });
