export interface SplitResult {
  sentences: string[];
  rest: string;
}

const SENTENCE_END = new Set(['。', '！', '？', '…', '!', '?', '\n']);
const PUNCT_ONLY = /^[。！？…!?]+$/;

/**
 * Splits streaming text into sentence-sized chunks for incremental TTS.
 * Sentence terminators are kept inside the preceding sentence. Anything
 * without a terminator stays in `rest` until more input arrives.
 */
export function splitSentences(text: string): SplitResult {
  const sentences: string[] = [];
  let current = '';
  for (const char of text) {
    current += char;
    if (SENTENCE_END.has(char)) {
      const sentence = current.trim();
      if (sentence) {
        if (PUNCT_ONLY.test(sentence) && sentences.length > 0) {
          // merge a dangling run of punctuation into the previous sentence
          sentences[sentences.length - 1] += sentence;
        } else {
          sentences.push(sentence);
        }
      }
      current = '';
    }
  }
  return { sentences, rest: current };
}
