export type InfinityPersistedState = {
  game: {
    board: Array<Array<number | null>>;
    score: number;
    won: boolean;
    over: boolean;
    keepPlaying: boolean;
    moveCount: number;
    maxTile: number;
    bestScore: number;
    history: Array<{
      board: Array<Array<number | null>>;
      score: number;
      won: boolean;
      over: boolean;
      keepPlaying: boolean;
      moveCount: number;
      maxTile: number;
    }>;
    achievements: Array<{
      id: string;
      title: string;
      description: string;
      unlocked: boolean;
    }>;
    status: 'idle' | 'playing' | 'won' | 'over';
  };
  settings: {
    soundEnabled: boolean;
    vibrationEnabled: boolean;
    theme: 'light' | 'dark' | 'system';
  };
};

export type SaveInfinityHistoryPayload = {
  state: InfinityPersistedState;
};