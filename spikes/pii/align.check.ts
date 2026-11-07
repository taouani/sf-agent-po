// Checks token-to-offset alignment with hand-made token lists (no model needed).
import assert from 'node:assert/strict';
import { alignTokens } from './ner.ts';

const t1 = 'Jean-Baptiste Lefèvre habite à Paris.';
const a1 = alignTokens(t1, ['[CLS]', 'Jean', '-', 'Bap', '##tiste', 'Le', '##f', '##èv', '##re', 'habite', 'à', 'Paris', '.', '[SEP]']);
assert.equal(a1[0], null);
assert.deepEqual(a1[3], { start: 5, end: 8, continuation: false });
assert.equal(a1[4]!.continuation, true);
assert.equal(t1.slice(a1[11]!.start, a1[11]!.end), 'Paris');

const t2 = '请联系客户王伟，电话13812345678。';
const a2 = alignTokens(t2, ['[CLS]', '请', '联', '系', '客', '户', '王', '伟', '，', '电', '话', '138', '##123', '##456', '##78', '。', '[SEP]']);
assert.equal(t2.slice(a2[6]!.start, a2[7]!.end), '王伟');
assert.equal(a2[7]!.continuation, false);

const t3 = 'Kenji Watanabe approved it';
const a3 = alignTokens(t3, ['<s>', '▁Ken', 'ji', '▁Wat', 'anabe', '▁approved', '▁it', '</s>']);
assert.equal(a3[2]!.continuation, true);
assert.equal(a3[3]!.continuation, false);
assert.equal(t3.slice(a3[3]!.start, a3[4]!.end), 'Watanabe');

const t4 = 'Call Ünal [UNK] now';
const a4 = alignTokens(t4, ['[CLS]', 'Call', '[UNK]', 'now', '[SEP]']);
assert.equal(a4[2], null);
assert.equal(t4.slice(a4[3]!.start, a4[3]!.end), 'now');
console.log('alignment checks passed');
