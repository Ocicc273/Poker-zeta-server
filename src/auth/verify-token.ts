/**
 * Poker Zeta — Verifica dell'identità del giocatore
 *
 * Il client si connette passando il proprio access token.
 * Il server chiede a Supabase se quel token è valido: se lo è,
 * Supabase restituisce l'utente. Nessun segreto necessario.
 *
 * Invariante: l'identità non è MAI quella che il client dichiara.
 * È solo quella che Supabase conferma.
 */

import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env.js';

const authOptions = {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
} as const;

const anon = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_PUBLISHABLE_KEY,
  authOptions,
);

export interface AuthenticatedPlayer {
  userId: string;
  username: string | null;
}

export async function verifyAccessToken(
  token: string,
): Promise<AuthenticatedPlayer> {
  const { data, error } = await anon.auth.getUser(token);

  if (error || !data.user) {
    // Il motivo esatto resta nei log, non va al client.
    console.error('Token rifiutato:', error?.message ?? 'nessun utente');
    throw new Error('Token non valido o scaduto');
  }

  const userId = data.user.id;

  // Per leggere il profilo ci presentiamo CON il token del
  // giocatore: le RLS lo riconoscono e lasciano leggere la sua
  // riga. Se fallisce, l'autenticazione resta valida: il nome
  // è cosmetico.
  let username: string | null = null;

  const asUser = createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
    ...authOptions,
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const profile = await asUser
    .from('profiles')
    .select('username')
    .eq('id', userId)
    .maybeSingle();

  if (!profile.error && profile.data) {
    username = (profile.data as { username: string | null }).username ?? null;
  }

  return { userId, username };
}
