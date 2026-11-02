# Farmboti

Discordbot für BotShop_CB6. Node.js 24, discord.js und dauerhaft gespeicherte SQLite Daten.

## Enthalten

Aufträge per /auftrag oder Bedienfenster, Rollenfreigabe ohne Administratorbypass, ganze DK und optionale Teilmengen, persönliche Übersicht, Freigabe eigener Reservierungen, Wareneingang, getrennte Zahlungsbestätigung und Beleg mit Betrag, Datum und bestätigendem Teammitglied.

Jede Mutation wird mit der Discord Interaktions ID dedupliziert. Reservierungen werden innerhalb einer Datenbanktransaktion geprüft. Bereits ausgezahlte Lieferungen können nicht erneut bestätigt werden. Buttons funktionieren auch nach Neustarts.

Der Bot führt keine Zahlung im Spiel aus. Das Team zahlt im Spiel und dokumentiert anschließend die Zahlung.

## Railway Einrichtung

1. Repository als Service importieren. Das Dockerfile wird verwendet.
2. Persistentes Volume unter `/data` einhängen. Ohne dieses Volume gehen Daten beim Ersetzen des Containers verloren.
3. Genau eine Instanz betreiben. SQLite wird nicht zwischen getrennten Instanzen synchronisiert.
4. Variablen aus `.env.example` übernehmen und ausfüllen. `DATA_PATH=/data/farmboti.sqlite` setzen.
5. Bot im Discord Developer Portal erstellen. Mit den Scopes `bot` und `applications.commands` auf den Server einladen.
6. Kanalrechte: Kanal ansehen, Nachrichten senden, Links einbetten, Nachrichtenverlauf anzeigen. Administratorrechte und privilegierte Intents sind nicht erforderlich.
7. Deployment starten. Die Serverbefehle werden automatisch registriert.
8. Ein Mitglied einer freigegebenen Teamrolle führt `/panel` aus.

`DISCORD_TOKEN` ist geheim und gehört ausschließlich in Railway Variables oder lokal in `.env`. Nicht in GitHub oder einen Chat kopieren.

`GUILD_ID`: Server ID.

`FARM_CHANNEL_ID`: Textchannel für Aufträge.

`MANAGER_ROLE_IDS`: Kommagetrennte Rollen IDs für Erstellung, Prüfung und Auszahlung. Keine automatische Freigabe für Administratoren.

`FARMER_ROLE_IDS`: Optional, kommagetrennte Rollen IDs für Annahme. Leer bedeutet alle Servermitglieder. Bereits zugewiesene Farmer dürfen ihre eigene Lieferung auch nach Rollenwechsel melden oder freigeben.

`PREISRECHNER_URL`: Optional, Basisadresse des bestehenden Preisrechners.

`PORT`: Standard 8080. `/health` liefert den Verbindungsstatus.

## Befehle

`/auftrag item:Sand dk:2 preis:32346,00 aufwand:10 teilmengen:true`

Preis ohne Tausenderpunkte eingeben. Für automatische Preise die Option `preis` weglassen.

`/meine`: Eigene Reservierungen inklusive gespeicherter Belege und Gesamtauszahlung. Die Antwort ist nur für den Benutzer sichtbar.

`/pruefen`: Lieferungen und ausstehende Auszahlungen. Nur Shopteam.

`/stornieren id:AUFTRAGS_ID`: Offenen Rest schließen, wenn keine aktiven Reservierungen bestehen. Bezahlte Belege bleiben erhalten.

`/panel`: Bedienfenster im konfigurierten Channel veröffentlichen. Erneutes Ausführen veröffentlicht ein weiteres Fenster.

## Preise

Verwendet die vorhandene Route `/api/items/search?q=Sand` des Repositorys Dxnny2504/Preisrechner. Der Adapter verlangt einen eindeutigen exakten Namen oder eine Item ID.

Vorrang hat eine Staffel mit `stacks: 54`. Sonst wird die Staffel für einen Stack mit 54 multipliziert. Andere Staffeln werden nicht geraten. Fehlt ein verwendbarer Preis oder ist der Preisrechner nicht erreichbar, wird kein Auftrag angelegt. Ein manueller DK Preis ist weiterhin möglich.

Keine Verkaufsprovision und keine Liefergebühr. Beispiel: 2 DK zu 32.346 $ plus 10 % ergeben 71.161,20 $.

Der Preis wird bereits beim Erstellen gespeichert und gilt für sämtliche Reservierungen dieses Auftrags. Dadurch entspricht die Auszahlung immer dem veröffentlichten Angebot. Preisänderungen im Rechner gelten für neue Aufträge. Aufwand wird je Reservierung auf Cent gerundet; bei vielen Teilmengen kann die Summe um wenige Cent von der Gesamtvorschau abweichen.

## Speicherung und Veröffentlichung

Aufträge werden zuerst gespeichert und anschließend auf Discord veröffentlicht. Bei Fehlern versucht der Bot die Synchronisierung alle 15 Sekunden erneut. Ein Discord Nonce reduziert doppelte Veröffentlichungen nach kurzen Unterbrechungen. Discord begrenzt die zeitliche Deduplizierung; nach einem Absturz genau zwischen Versand und Speicherung kann außerhalb dieses Fensters ein doppelter Beitrag entstehen. Reservierungen und Zahlungen bleiben dennoch auf denselben Auftrag bezogen und transaktional geschützt.

Auftragsnachrichten bitte nicht manuell löschen. Bei einer gelöschten Nachricht kann der Bot sie nicht mehr aktualisieren. Die Daten und Belege bleiben in SQLite erhalten.

Regelmäßig das persistente Volume sichern. Für eine konsistente SQLite Sicherung die Anwendung vorher stoppen oder das SQLite Backupverfahren verwenden.

## Lokal

```sh
npm ci
cp .env.example .env
```

In `.env` die Werte einsetzen, lokal `DATA_PATH=./data/farmboti.sqlite` verwenden.

```sh
npm test
npm start
```

## Bewusst noch nicht enthalten

Der neue Reiter im Preisrechner, Erstellung aus dem Browser, Discord Anmeldung für den Preisrechner, Fristen und Erinnerungen, Level, Ranglisten sowie Itemabonnements sind weitere Ausbauschritte. Diese Version verändert das Preisrechner Repository nicht und bietet keine ungeschützte HTTP Schnittstelle zum Erstellen von Aufträgen.

Ein echter Discord Test erfordert den eigenen Bot Token, Server und Rollen. Automatisiert getestet sind Geldberechnung, Zustandswechsel, Rollenbedingungen im Auftragsmodell, Deduplizierung, Mengenreservierung, Persistenz und der Preisadapter mit simulierten Antworten.

## Sand als Dauerauftrag

`/sand` erstellt genau einen Sanddauerauftrag mit 5 DK gleichzeitig reservierbarer Kapazität, dem vereinbarten Preis von 32.346 $ pro DK und 10 % Aufwand. Pro DK werden damit 35.580,60 $ ausgezahlt. Nur freigegebene Teamrollen können ihn erstellen. Erneutes Ausführen zeigt den bestehenden Auftrag, statt einen zweiten anzulegen. Das neue `/panel` hat dafür den Button „Sand · 5 DK“.

Andere Daueraufträge sind über `/auftrag` mit `dauerauftrag:true` möglich. Die normale Preisübernahme funktioniert dabei wie bei Einzelaufträgen. `/sand` nutzt bewusst den vereinbarten festen Preis, unabhängig vom aktuellen Preisrechner.

Reservierte und zur Abgabe gemeldete Mengen belegen die Kapazität. Erst „Wareneingang bestätigen“ durch das Team gibt die gelieferte Menge wieder frei. Der Beleg und die offene Auszahlung bleiben erhalten, auch wenn bereits der nächste Farmer annimmt. Das Bestätigen einer Zahlung füllt nicht erneut auf.

Die 5 DK begrenzen gleichzeitig ausstehende Lieferungen, nicht die Gesamtmenge oder das Gesamtbudget über die Zeit. Der Auftrag bleibt bei seinem veröffentlichten Preis, bis er geschlossen und neu erstellt wird.

„Pausieren · Team“ verhindert neue Annahmen, auch aus vorher geöffneten Formularen. „Fortsetzen · Team“ gibt sie wieder frei. Bestehende Lieferungen und Zahlungen bleiben während einer Pause bearbeitbar. `/stornieren` schließt endgültig, sobald alle Reservierungen freigegeben oder bezahlt sind.

Ältere gespeicherte Aufträge funktionieren unverändert. Vor dem Deployment auf ein neues Volume muss eine vorhandene Datenbank des laufenden Containers gesichert und übernommen werden. Ein leeres Volume übernimmt diese Daten nicht automatisch.
