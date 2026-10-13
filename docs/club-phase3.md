# Club Fase 3 — bozza non attivata

CLUB_PHASE3_ENABLED è false se assente. Non attivarlo prima della migrazione,
della Edge Function compatibile e delle verifiche PostgreSQL/socket reali.

Il percorso è separato dai tavoli non-Club. Gli interi del motore rappresentano
centesimi di chip; l'adattatore chipView riconverte i valori del protocollo.
Ogni membro ha uno stack autorizzato per un ingresso: dopo l’uscita serve
una nuova autorizzazione. La riconnessione conserva la stessa sessione. Le ricariche sono additive, tra le mani,
con permessi controllati prima della mutazione e nel database.

Il gate serializza comandi e timer. I checkpoint precedono trasmissioni e conferme.
In caso di risposta persa il commit viene ritentato con lo stesso identificativo.
Un salvataggio incerto sospende il tavolo. La disconnessione non liquida il conto.
L'uscita registra il finale; la chiusura registra atomicamente tutti i finali.

Una mano interrotta da crash viene annullata e ogni giocatore recupera il saldo
prima di quella mano. Il recupero riparte in lobby e conserva le sessioni.
Si salvano saldi, ricariche, finali e ricevute, mai mazzo o carte private.
È richiesta UNA SOLA istanza server, come nella riconciliazione esistente.

Verifiche locali: 141 test passati, compresi pot, rake, Hold’em, Omaha,
showdown, Twister, tornei e riconnessione. I test Club simulano l'archivio:
non sostituiscono la verifica della migrazione e delle policy reali.
TypeScript dei moduli contabili Club passa con npm run typecheck:club.
Il trasporto è definito da un confine minimo compatibile con il server; nessuna
dichiarazione fittizia di Socket.IO. Il controllo completo resta bloccato dalla
dipendenza socket.io mancante. Rifiuti definitivi e conflitti sospendono il tavolo
senza ripetizioni infinite; gli errori temporanei conservano i tentativi idempotenti.

Il repository frontend contiene docs/CLUB_FASE3.md, lo script additivo
supabase/scripts/club_phase3.sql e i controlli di staging
supabase/tests/club_phase3_checks.sql. Non applicati alla produzione.
