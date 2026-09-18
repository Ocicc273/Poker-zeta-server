export const TOURNAMENT = {
  name: 'Zeta Hold’em', buyIn: 2_000, minPlayers: 2, maxPlayers: 6,
  startingStack: 1_500, registrationMs: 30_000, levelMs: 120_000,
  turnMs: 25_000, betweenHandsMs: 4_000, leaseMs: 90_000,
  // Nessun rake: il vincitore riceve tutte le iscrizioni.
  blinds: [20, 40, 80, 120, 200, 400, 800, 1_600, 3_200, 6_400, 12_800],
} as const;

export function tournamentBlinds(elapsed: number) {
  const level = Math.min(TOURNAMENT.blinds.length - 1, Math.floor(Math.max(0, elapsed) / TOURNAMENT.levelMs));
  const bigBlind = TOURNAMENT.blinds[level]!;
  return { level: level + 1, smallBlind: bigBlind / 2, bigBlind, ante: 0 };
}
