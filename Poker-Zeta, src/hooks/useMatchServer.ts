/**
 * Poker Zeta — Connessione al Match Server
 *
 * Apre un socket autenticato passando l'access token Supabase
 * nell'handshake. Se il token manca o è scaduto, il server
 * rifiuta e lo stato diventa 'error'.
 */

import { useEffect, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { supabase } from '@/integrations/supabase/client';
import { MATCH_SERVER_URL } from '@/lib/match-server';

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'error';

export interface ServerPlayer {
  userId: string;
  username: string | null;
}

export function useMatchServer() {
  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [player, setPlayer] = useState<ServerPlayer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);

  useEffect(() => {
    let active = true;
    let current: Socket | null = null;

    async function connect() {
      setStatus('connecting');

      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;

      if (!token) {
        if (active) {
          setStatus('error');
          setError('Nessuna sessione attiva: fai login.');
        }
        return;
      }

      if (!active) return;

      current = io(MATCH_SERVER_URL, {
        auth: { token },
        transports: ['websocket'],
      });

      setSocket(current);

      current.on('connect', () => {
        if (active) setStatus('connected');
      });

      current.on('server:welcome', (p: ServerPlayer) => {
        if (active) setPlayer(p);
      });

      current.on('connect_error', (err) => {
        if (!active) return;
        setStatus('error');
        setError(err.message);
      });

      current.on('disconnect', () => {
        if (active) setStatus('idle');
      });
    }

    connect();

    return () => {
      active = false;
      current?.disconnect();
    };
  }, []);

  return { status, player, error, socket };
}
