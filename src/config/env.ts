/**
 * Poker Zeta — Configurazione d'ambiente
 *
 * Le credenziali non sono MAI nel codice: vengono lette da
 * process.env, cioè dalle Variables di Railway. Questo file
 * verifica solo che esistano, e fa crashare il server subito
 * se manca qualcosa — meglio un errore all'avvio che un
 * comportamento imprevedibile a partita in corso.
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

export const env = {
  PORT: Number(process.env.PORT) || 3001,
  SUPABASE_URL: required('SUPABASE_URL'),
  SUPABASE_SERVICE_ROLE_KEY: required('SUPABASE_SERVICE_ROLE_KEY'),
} as const;
