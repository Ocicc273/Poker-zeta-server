/**
 * Poker Zeta — PZ Journey: invio della progressione
 *
 * Fratello di `src/wallet/table-session.ts` ma verso un'altra porta:
 * quella muove Z-Coins, questa muove XP. Sono due materie diverse e
 * due Edge Function diverse, di proposito.
 *
 * IL SERVER MANDA I FATTI, NON GLI XP. Quante mani, quante vinte, se
 * si è alzato in utile. Quanto vale ogni cosa lo decide la Edge
 * Function: cambiare un numero lì non richiede di ridistribuire
 * questo server.
 *
 * L'IDEMPOTENZA È LA FONDAMENTA. Ogni evento porta un `eventId`
 * costruito come sessione + numero della mano. Se la chiamata va in
 * timeout e si ritenta, l'identificatore è lo stesso e il database
 * riconosce il doppione: l'XP non raddoppia. Per questo il
 * ritentativo qui sotto è sicuro — senza `eventId` non lo sarebbe.
 *
 * NON SOLLEVA MAI. La progressione è un contorno: un guasto qui non
 * deve poter far cadere una mano vera.
 */

import { env } from '../config/env.js';

/** Quanto si aspetta prima di dichiarare irraggiungibile il servizio. */
const TIMEOUT_MS = 8000;

/** Quanto si aspetta prima dell'unico ritentativo. */
const RITENTATIVO_MS = 2000;

export type Modalita = 'holdem' | 'omaha' | 'twister' | 'tournaments';

export interface EventoProgresso {
  /**
   * Identificatore stabile dell'evento: sessione + numero della mano.
   * DEVE restare identico fra un tentativo e il suo ritentativo,
   * altrimenti l'idempotenza non protegge da niente.
   */
  eventId: string;
  userId: string;
  mode: Modalita;
  handsPlayed?: number;
  handsWon?: number;
  /** Vero se il giocatore si è alzato dal tavolo con più di quanto è entrato. */
  leftInProfit?: boolean;
  twisterWon?: boolean;
  /** 1, 2 o 3. Fuori da questo intervallo non vale niente. */
  tournamentPlace?: number;
}

async function chiama(evento: EventoProgresso): Promise<Response> {
  return fetch(env.PROGRESS_FUNCTION_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-match-server-secret': env.MATCH_SERVER_SECRET,
    },
    body: JSON.stringify({ action: 'progress-event', ...evento }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/**
 * Registra cosa ha fatto un giocatore. Da chiamare senza attendere:
 * la mano è già conclusa e nessuno deve aspettare il database per
 * vederne il risultato.
 */
export async function inviaProgresso(evento: EventoProgresso): Promise<void> {
  for (let tentativo = 1; tentativo <= 2; tentativo += 1) {
    try {
      const risposta = await chiama(evento);

      if (risposta.ok) return;

      // Una richiesta rifiutata non migliora ritentandola: il
      // payload è sbagliato o il segreto non combacia. Si lascia la
      // traccia e si smette.
      if (risposta.status >= 400 && risposta.status < 500) {
        console.error(
          `Progressione rifiutata (${risposta.status}) per ` +
            `${evento.eventId}: ${await risposta.text()}`,
        );
        return;
      }
    } catch (error) {
      // Rete caduta o timeout: è esattamente il caso per cui esiste
      // l'eventId. Si ritenta una volta sola.
      if (tentativo === 2) {
        console.error(
          `Progressione non consegnata per ${evento.eventId}:`,
          error,
        );
        return;
      }
    }

    if (tentativo === 1) {
      await new Promise((risolvi) => setTimeout(risolvi, RITENTATIVO_MS));
    }
  }
}
