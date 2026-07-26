/**
 * Poker Zeta — Configurazione d'ambiente
 *
 * Legge tutto da process.env (Variables di Railway) e fa
 * crashare il server all'avvio se manca qualcosa.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `Variabile d'ambiente mancante: ${name}. ` +
        `Impostala nelle Variables del servizio su Railway.`,
    );
  }
  return value.trim();
}

const SUPABASE_URL = required('SUPABASE_URL');

export const env = {
  PORT: Number(process.env.PORT) || 3001,

  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY: required('SUPABASE_PUBLISHABLE_KEY'),

  /**
   * Endpoint della Edge Function che muove le Z-Coins.
   * Derivato dall'URL del progetto: è pubblico, non è un segreto.
   */
  WALLET_FUNCTION_URL: `${SUPABASE_URL}/functions/v1/table-session`,

  /**
   * Segreto condiviso con la Edge Function. È l'unica credenziale
   * privilegiata che vive qui: non dà accesso al database, solo
   * il permesso di aprire e chiudere sessioni di tavolo.
   */
  MATCH_SERVER_SECRET: required('MATCH_SERVER_SECRET'),
} as const;
