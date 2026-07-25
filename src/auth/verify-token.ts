/**
 * Poker Zeta — Verifica dell'identità del giocatore
 *
 * Il client si connette passando il proprio access token di
 * Supabase. Il server lo verifica con la service_role key, che
 * ha privilegi pieni e vive solo qui, lato server.
 *
 * Invariante: l'identità di un giocatore non è MAI quella che il
 * client dichiara di avere. È solo quella che Supabase conferma.
 */

import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env.js';

const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

export interface AuthenticatedPlayer {
  userId: string;
  username: string | null;
}

export async function verifyAccessToken(
  token: string,
): Promise<AuthenticatedPlayer> {
  const { data, error } = await admin.auth.getUser(token);

  if (error || !data.user) {
    throw new Error('Token non valido o scaduto');
  }

  const userId = data.user.id;

  // Il nome visualizzato al tavolo. Se la lettura non riesce
  // l'autenticazione resta valida: il nome è cosmetico, non
  // un requisito di sicurezza.
  let username: string | null = null;
  const profile = await admin
    .from('profiles')
    .select('username')
    .eq('id', userId)
    .maybeSingle();

  if (!profile.error && profile.data) {
    username = (profile.data as { username: string | null }).username ?? null;
  }

  return { userId, username };
}
