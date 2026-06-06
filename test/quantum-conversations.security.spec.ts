import { BadRequestException } from '@nestjs/common';

import { QuantumService } from '../src/modules/quantum/quantum.service';

const testUser = {
  email: 'user@chefuinc.com',
  roles: ['user'],
  uid: 'user-1',
};

describe('Quantum conversation document id hardening', () => {
  const service = new QuantumService({
    db: () => ({
      collection: jest.fn(),
    }),
  } as never);

  it('rejects path-like conversation ids instead of silently rewriting them', async () => {
    await expect(
      service.deleteConversation(testUser, 'abc123/comments'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects oversized conversation ids before reaching Firestore', async () => {
    await expect(
      service.deleteConversation(testUser, 'a'.repeat(141)),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
