import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { FieldValue } from 'firebase-admin/firestore';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { FirebaseAdminService } from '../firebase-admin/firebase-admin.service';
import { InfinityPersistedState } from './infinity.types';

@Injectable()
export class InfinityService {
    constructor(
        @Inject(FirebaseAdminService)
        private readonly firebaseAdmin: FirebaseAdminService,
    ) { }

    async getState(user: AuthenticatedUser) {
        const snapshot = await this.stateDocument(user).get();
        return { state: snapshot.exists ? snapshot.data()?.state ?? null : null };
    }

    async saveState(user: AuthenticatedUser, state: InfinityPersistedState) {
        if (!state || typeof state !== 'object') {
            throw new BadRequestException('state is required.');
        }

        const sanitized = this.sanitizeStateForStorage(state);
        if (!sanitized) {
            throw new BadRequestException('state is malformed.');
        }

        await this.stateDocument(user).set({
            state: sanitized,
            ownerUid: user.uid,
            ownerEmail: user.email,
            updatedAt: FieldValue.serverTimestamp(),
        });

        return { saved: true };
    }

    sanitizeStateForStorage(state: unknown): InfinityPersistedState | null {
        if (!state || typeof state !== 'object') {
            return null;
        }

        const candidate = state as Partial<InfinityPersistedState>;
        if (!candidate.game || !candidate.settings) {
            return null;
        }

        const game = candidate.game as Partial<InfinityPersistedState['game']>;
        const settings = candidate.settings as Partial<InfinityPersistedState['settings']>;

        const normalizedBoard = this.normalizeBoard(game.board);
        const normalizedHistory = Array.isArray(game.history)
            ? game.history.map((entry) => this.normalizeSnapshot(entry)).filter((entry): entry is NonNullable<typeof entry> => entry !== null)
            : [];

        const normalizedAchievements = Array.isArray(game.achievements)
            ? game.achievements
                .map((achievement) => this.normalizeAchievement(achievement))
                .filter((achievement): achievement is NonNullable<typeof achievement> => achievement !== null)
            : [];

        if (!normalizedBoard || typeof game.score !== 'number' || !Number.isFinite(game.score) ||
            typeof game.won !== 'boolean' || typeof game.over !== 'boolean' ||
            typeof game.keepPlaying !== 'boolean' || typeof game.moveCount !== 'number' || !Number.isFinite(game.moveCount) ||
            typeof game.maxTile !== 'number' || !Number.isFinite(game.maxTile) ||
            typeof game.bestScore !== 'number' || !Number.isFinite(game.bestScore) ||
            !['idle', 'playing', 'won', 'over'].includes(game.status as string) ||
            typeof settings.soundEnabled !== 'boolean' || typeof settings.vibrationEnabled !== 'boolean' ||
            !['light', 'dark', 'system'].includes(settings.theme as string)) {
            return null;
        }

        const normalizedState: InfinityPersistedState = {
            game: {
                board: normalizedBoard,
                score: game.score,
                won: game.won,
                over: game.over,
                keepPlaying: game.keepPlaying,
                moveCount: game.moveCount,
                maxTile: game.maxTile,
                bestScore: game.bestScore,
                history: normalizedHistory,
                achievements: normalizedAchievements,
                status: game.status as InfinityPersistedState['game']['status'],
            },
            settings: {
                soundEnabled: settings.soundEnabled,
                vibrationEnabled: settings.vibrationEnabled,
                theme: settings.theme as InfinityPersistedState['settings']['theme'],
            },
        };

        return normalizedState;
    }

    private normalizeBoard(board: unknown): InfinityPersistedState['game']['board'] | null {
        if (!Array.isArray(board) || board.length !== 4) {
            return null;
        }

        const normalizedRows = board.map((row) => {
            if (!Array.isArray(row) || row.length !== 4) {
                return null;
            }

            const normalizedRow = row.map((cell) => {
                if (cell === null || cell === undefined) {
                    return null;
                }

                return typeof cell === 'number' && Number.isFinite(cell) && cell > 0 ? cell : null;
            });

            return normalizedRow;
        });

        return normalizedRows.every((row) => row !== null) ? normalizedRows as InfinityPersistedState['game']['board'] : null;
    }

    private normalizeSnapshot(snapshot: unknown): InfinityPersistedState['game']['history'][number] | null {
        if (!snapshot || typeof snapshot !== 'object') {
            return null;
        }

        const candidate = snapshot as Partial<InfinityPersistedState['game']['history'][number]>;
        const board = this.normalizeBoard(candidate.board);
        if (!board || typeof candidate.score !== 'number' || !Number.isFinite(candidate.score) ||
            typeof candidate.won !== 'boolean' || typeof candidate.over !== 'boolean' ||
            typeof candidate.keepPlaying !== 'boolean' || typeof candidate.moveCount !== 'number' || !Number.isFinite(candidate.moveCount) ||
            typeof candidate.maxTile !== 'number' || !Number.isFinite(candidate.maxTile)) {
            return null;
        }

        return {
            board,
            score: candidate.score,
            won: candidate.won,
            over: candidate.over,
            keepPlaying: candidate.keepPlaying,
            moveCount: candidate.moveCount,
            maxTile: candidate.maxTile,
        };
    }

    private normalizeAchievement(achievement: unknown): InfinityPersistedState['game']['achievements'][number] | null {
        if (!achievement || typeof achievement !== 'object') {
            return null;
        }

        const candidate = achievement as Partial<InfinityPersistedState['game']['achievements'][number]>;
        if (typeof candidate.id !== 'string' || typeof candidate.title !== 'string' ||
            typeof candidate.description !== 'string' || typeof candidate.unlocked !== 'boolean') {
            return null;
        }

        return {
            id: candidate.id,
            title: candidate.title,
            description: candidate.description,
            unlocked: candidate.unlocked,
        };
    }

    private stateDocument(user: AuthenticatedUser) {
        return this.firebaseAdmin
            .db()
            .collection('users')
            .doc(user.email || user.uid)
            .collection('infinity')
            .doc('state');
    }
}