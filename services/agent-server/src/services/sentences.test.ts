import { describe, expect, it } from 'vitest';
import { splitSentences } from './sentences.js';

describe('splitSentences', () => {
  it('splits on Chinese sentence terminators', () => {
    expect(splitSentences('你好。我很好！你呢？')).toEqual({
      sentences: ['你好。', '我很好！', '你呢？'],
      rest: '',
    });
  });

  it('keeps incomplete trailing text in rest', () => {
    expect(splitSentences('你好，世界')).toEqual({
      sentences: [],
      rest: '你好，世界',
    });
  });

  it('splits on newlines', () => {
    expect(splitSentences('第一行\n第二行。')).toEqual({
      sentences: ['第一行', '第二行。'],
      rest: '',
    });
  });

  it('merges dangling punctuation into the previous sentence', () => {
    expect(splitSentences('好的。。然后呢')).toEqual({
      sentences: ['好的。。'],
      rest: '然后呢',
    });
  });

  it('handles streaming accumulation across calls', () => {
    const first = splitSentences('你好，这是');
    expect(first).toEqual({ sentences: [], rest: '你好，这是' });
    const second = splitSentences(first.rest + '一句话。第二句');
    expect(second).toEqual({ sentences: ['你好，这是一句话。'], rest: '第二句' });
  });
});
