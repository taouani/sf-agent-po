// Pieces the server starts with, loaded when first needed.

import path from "node:path";
import { createRecognizer, loadDetectionModel, type DetectionModel, type EntityDetector, type TextRecognizer } from "@sf-agent-po/core";

/** The database of a workspace folder. */
export const databaseFile = (workspace: string) => path.join(workspace, "sf-agent.db");

/**
 * The detection model, loaded on first use (it may download about 300 MB once). If it cannot
 * load, masking fails and nothing is added: without it, names are missed.
 */
export function lazyDetector(load: () => Promise<DetectionModel> = () => loadDetectionModel()): EntityDetector & { release(): Promise<void> } {
  let model: Promise<DetectionModel> | undefined;
  const detect = (async (text: string) => {
    model ??= load().catch((err: unknown) => {
      model = undefined; // try again on the next input
      throw new Error(`The name detection model could not be loaded, so nothing was masked or added: ${(err as Error).message}`);
    });
    return (await model).detect(text);
  }) as EntityDetector & { release(): Promise<void> };
  detect.release = async () => {
    if (model) await (await model.catch(() => undefined))?.release();
  };
  return detect;
}

/** The OCR, started on first use and kept for the session. */
export function lazyRecognizer(start: () => Promise<TextRecognizer> = () => createRecognizer()): (() => Promise<TextRecognizer>) & { close(): Promise<void> } {
  let recognizer: Promise<TextRecognizer> | undefined;
  const get = (() => {
    recognizer ??= start().catch((err: unknown) => {
      recognizer = undefined;
      throw err;
    });
    return recognizer;
  }) as (() => Promise<TextRecognizer>) & { close(): Promise<void> };
  get.close = async () => {
    if (recognizer) await (await recognizer.catch(() => undefined))?.close();
  };
  return get;
}
