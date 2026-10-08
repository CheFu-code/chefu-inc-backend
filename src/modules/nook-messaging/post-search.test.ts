import assert from 'node:assert/strict';
import test from 'node:test';
import { postSearchTokens } from './post-search';

void test('post search tokens are normalized, unique, and limited', () => {
  assert.deepEqual(
    postSearchTokens('Café café #Travel 2026'),
    ['cafe', 'travel', '2026'],
  );
});

void test('post search tokens ignore punctuation and one-character fragments', () => {
  assert.deepEqual(postSearchTokens('I ♥ Nook! x @nook'), ['nook']);
});

void test('post search tokens are bounded per post', () => {
  const tokens = Array.from({ length: 40 }, (_, index) => `word${index}`).join(' ');
  assert.equal(postSearchTokens(tokens).length, 30);
});
