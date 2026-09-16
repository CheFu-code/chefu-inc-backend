import test from 'node:test';
import assert from 'node:assert/strict';
import { InfinityService } from './infinity.service';

void test('sanitizeStateForStorage strips unsupported values before writing to Firestore', () => {
  const service = new InfinityService({} as any);

  const legacyState = {
    game: {
      board: [[undefined, 2, null, 4],[null, 4, 8, null],[16, null, 32, 64],[128, 256, NaN, 512]],
      score: 180,
      won: false,
      over: false,
      keepPlaying: false,
      moveCount: 3,
      maxTile: 512,
      bestScore: 512,
      history: [{
        board: [[undefined, 2, null, 4],[null, 4, 8, null],[16, null, 32, 64],[128, 256, NaN, 512]],
        score: 160,
        won: false,
        over: false,
        keepPlaying: false,
        moveCount: 2,
        maxTile: 512,
      }],
      achievements: [{
        id: 'first-merge',
        title: 'First merge',
        description: 'Merged your first pair of tiles.',
        unlocked: true,
      }],
      status: 'playing',
    },
    settings: {
      soundEnabled: true,
      vibrationEnabled: true,
      theme: 'system',
    },
  } as any;

  const sanitized = (service as any).sanitizeStateForStorage(legacyState);

  assert.deepEqual(sanitized.game.board[0][0], null);
  assert.deepEqual(sanitized.game.history[0].board[3][2], null);
  assert.equal(sanitized.game.status, 'playing');
  assert.equal(sanitized.settings.theme, 'system');
});

void test('sanitizeStateForStorage rejects malformed payloads', () => {
  const service = new InfinityService({} as any);

  const invalidState = {
    game: {
      board: [[1, 2], [3, 4]],
      score: 4,
      won: false,
      over: false,
      keepPlaying: false,
      moveCount: 1,
      maxTile: 4,
      bestScore: 4,
      history: [],
      achievements: [],
      status: 'playing',
    },
    settings: {
      soundEnabled: true,
      vibrationEnabled: true,
      theme: 'invalid',
    },
  } as any;

  assert.equal((service as any).sanitizeStateForStorage(invalidState), null);
});
