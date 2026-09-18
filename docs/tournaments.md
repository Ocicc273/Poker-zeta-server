# Tornei Hold'em single-table

2–6 umani, iscrizione 2.000 Z-Coins, stack 1.500 fiche senza valore monetario.
Avvio 30 secondi dopo il secondo iscritto oppure a sei iscritti. Livelli ogni
2 minuti, applicati alla mano successiva. Il vincitore riceve il 100% delle
iscrizioni, senza rake. Configurazione: `src/game/tournament-config.ts`.

Non si aprono `table_sessions`: il protocollo `tournament:*`, il registro e
le tabelle SQL sono separati da cash, Omaha, Twister e privati. Un gate per
utente esclude ingressi concorrenti. Il server assegna carte, turni e piazzamenti;
il client vede solo le carte autorizzate e invia azioni con mano/versione.

Una disconnessione conserva il posto: timeout check/fold e rientro dalla lobby.
Shutdown: rimborso di tutte le iscrizioni oppure liquidazione del vincitore gia
deciso. Dopo crash/sleep non si ricostruiscono le carte: la lease di 90 secondi
scade e il prossimo recupero annulla e rimborsa. Nessun recupero annulla una
lease ancora viva. Il recupero riparte quando il servizio torna disponibile.
Addebiti, rimborsi, classifiche e premi sono transazioni SQL idempotenti;
gli importi del premio derivano dalle iscrizioni, non dal client.

## Attivazione (repository client Poker-Zeta)

1. Applicare `supabase/migrations/20260918000100_tournaments.sql`.
2. Pubblicare `supabase/functions/tournament-session` con la configurazione
   `verify_jwt = false` gia inclusa: l'endpoint verifica il segreto condiviso
   `MATCH_SERVER_SECRET` e usa le variabili Supabase standard. Nessuna nuova
   chiave nel browser e nessun nuovo segreto da aggiungere al Match Server.
3. Pubblicare server e client. La lobby e `/play?mode=tournaments`.

Se il backend SQL/Edge non e ancora pubblicato, la lobby segnala indisponibilita
e non addebita iscrizioni. Push Git non applica automaticamente le migrazioni.

## Verifica

- `npm test` e `tsc --noEmit`: motore, tornei e regressioni degli altri formati.
- Client: `tsc --noEmit`.
- `strumenti/tournament-db.test.mjs` nel client esegue la migrazione su PostgreSQL
  effimero PGlite (nessun accesso a Supabase). `PGLITE_MODULE` puo puntare al file
  `dist/index.js` di una copia temporanea di `@electric-sql/pglite`.
  Eseguire `node --test strumenti/tournament-db.test.mjs`.
- Prova manuale con almeno due account: iscrizione, rientro, eliminazione e premio;
  poi riavvio server e rimborso.
