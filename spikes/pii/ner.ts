// Local named-entity recognition with an ONNX model through @huggingface/transformers.
// The library's token-classification pipeline returns no character offsets, so this
// module runs the model directly and maps tokens back to the text itself (decode.ts).

import { AutoModelForTokenClassification, AutoTokenizer, env } from '@huggingface/transformers';
import type { Span } from '../lib/spans.ts';
import { decodeSpans, type NerModel } from './decode.ts';

export { alignTokens, decodeSpans, mapLabel, type NerModel, type TokenOffset } from './decode.ts';

export async function loadNer(id: string, dtype: string, cacheDir?: string, threads?: number): Promise<NerModel> {
  if (cacheDir) env.cacheDir = cacheDir;
  const tokenizer = await AutoTokenizer.from_pretrained(id);
  const model = await AutoModelForTokenClassification.from_pretrained(id, {
    dtype: dtype as never,
    ...(threads ? { session_options: { intraOpNumThreads: threads, interOpNumThreads: 1 } } : {}),
  });
  const id2label: Record<string, string> = (model as any).config.id2label ?? {};
  const stats = { tokens: 0, unaligned: 0 };
  return {
    id,
    dtype,
    labels: Object.values(id2label),
    stats,
    async detect(text: string): Promise<Span[]> {
      const enc = (tokenizer as any)._tokenizer.encode(text) as { ids: number[]; tokens: string[] };
      if (enc.ids.length > 512) throw new Error(`text too long for one window: ${enc.ids.length} tokens`);
      const inputs = tokenizer(text);
      const { logits } = await (model as any)(inputs);
      const [, seqLen, numLabels] = logits.dims as number[];
      return decodeSpans(text, enc.tokens, logits.data as Float32Array, seqLen!, numLabels!, id2label, stats);
    },
  };
}
