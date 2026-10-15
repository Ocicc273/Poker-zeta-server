# Tornei gratuiti persistenti

Il formato MTT riusa il motore poker e la proiezione del torneo classico.
Le modifiche a Deck sono additive: snapshot/restore privati, senza cambiare lo
shuffle o le regole Hold’em/Omaha. Lo scheduler MTT ha un timer indipendente:
un errore della sua Edge Function non rallenta il timer del torneo legacy.

## Moduli

- `mtt-engine.ts`: stato serializzabile, validazione mazzo/board, round,
  eliminazioni, riequilibrio e finale, proiezioni per giocatore.
- `mtt-service.ts`: catalogo, code per torneo, commit prima di ACK/broadcast,
  richieste dall'esito incerto, lease e ripristino dopo riavvio.
- `mtt-socket.ts`: adapter autenticato; l'identità arriva dal middleware esistente.
- `wallet/mtt.ts`: solo trasporto verso `mtt-session`; non accede al wallet.
- `mtt-protocol.ts`: contratto corrispondente al frontend.

Formato: 2–18 umani, tavoli da 6, 25 secondi di turno, round sincronizzati e
4 secondi tra round. Livelli e stack configurabili all'atto della creazione.
Premio fisso 100 punti torneo non spendibili al vincitore. Le parità di stack
all'eliminazione nello stesso round condividono il piazzamento.
Un solo processo pubblico Match Server: non estendere ad altre istanze senza
ripensare anche i registri e i gate delle modalità esistenti.

## Attivazione

Nel repository frontend, `docs/TORNEI_MULTIPLAYER.md` descrive migrazione,
Edge Function, permesso amministratore e ordine di rilascio. Solo il progetto
Supabase ufficiale `dtmqrumhckpfzzhmojxn`. I nuovi dati `pz_mtt_*` sono separati
perché il recupero del formato legacy annulla/rimborsa tornei scaduti.
Non fare deploy dei due componenti senza preparare schema e funzione compatibili.

## Comandi di verifica

```
node --import tsx src/tests/mtt.test.ts
node node_modules/typescript/bin/tsc -p tsconfig.mtt.json
PGLITE_MODULE=/percorso/pglite/dist/index.js MTT_MIGRATION=/percorso/20261015000100_mtt_durable.sql node --import tsx src/tests/mtt-postgres.test.ts
npm run build
```

Il typecheck mirato non sostituisce quello completo. Il test PostgreSQL richiede
un database PGlite effimero, non credenziali Supabase. Senza le due variabili
viene saltato esplicitamente. La suite completa include il test Socket.IO reale.
Le pipeline GitHub usano dipendenze vere; nessun servizio di produzione nei test.

## Limiti e recupero

I checkpoint comprendono tutte le carte, il cursore del mazzo e il timer.
Non pubblicarli nei log o nel browser. In caso di errore DB si sospende il torneo;
una risposta persa viene ritentata con lo stesso ID e stesso contenuto. Dopo
un rifiuto certo di versione/lease si acquisisce di nuovo il checkpoint.
Il successore aspetta al massimo la lease residua di 30 secondi; mantiene il
tempo residuo dall'ultimo checkpoint (heartbeat ogni 5 secondi). Il mazzo non
viene ricreato. Gli eventi contengono comandi e revisioni, non copie del mazzo.

Lo storico in lobby comprende i tornei attivi e gli ultimi 50 conclusi recuperati
all'avvio. Configurazione admin in `auth.users.raw_app_meta_data`, mai in
user_metadata. Nessun account viene automaticamente promosso dal server.
