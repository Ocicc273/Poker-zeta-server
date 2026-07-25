/**
 * Poker Zeta — Configurazione d'ambiente
 *
 * Legge tutto da process.env (Variables di Railway) e fa
 * crashare il server all'avvio se manca qualcosa.
 *
 * Nota: qui basta la publishable key. Verificare un token non
 * richiede privilegi — è Supabase a dire se è valido o no.
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
  SUPABASE_PUBLISHABLE_KEY: required('SUPABASE_PUBLISHABLE_KEY'),
} as const;
