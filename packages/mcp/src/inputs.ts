// Adding inputs (AR1, FE4, open question 8): every input is masked before it is stored, a
// redacted image is stored only once the user confirmed it, and while masked-input review is
// on the user checks each masked input on the approval page before the agents can read it.
// Values the user says are still in clear are hidden from then on, and they check again.

import type { ContextRepository, DictionaryEntry, Masker, NewDocument, SourceDocument, TextRecognizer } from "@sf-agent-po/core";
import { openInBrowser } from "./approval/browser.js";
import { requestDigest, type ApprovalRequest, type ApprovalServer, type Decision, type ImageRequest, type InputRequest } from "./approval/server.js";
import { reviewsInputs } from "./approval/settings.js";

/** Puts a request in front of the user and waits for their decision. */
export interface Reviewer {
  review(req: ApprovalRequest): Promise<Decision>;
}

/**
 * A reviewer on the approval page: the page opens in the user's browser. The link works
 * once and never reaches the model, so a browser that cannot be opened is an error.
 */
export function pageReviewer(server: ApprovalServer, open: (url: string) => Promise<boolean> | boolean = (url) => openInBrowser(url)): Reviewer {
  return {
    async review(req) {
      const pending = await server.request(req);
      let opened = false;
      try {
        opened = await open(pending.url);
      } catch {
        opened = false;
      }
      if (!opened) {
        pending.cancel();
        throw new Error("The approval page could not be opened in a browser on this computer, so nothing was added.");
      }
      return pending.decision;
    },
  };
}

/** How many times the user can name missed values for one input before it is set aside. */
export const MAX_ROUNDS = 5;

export interface IntakeOptions {
  contexts: ContextRepository;
  masker: Masker;
  reviewer: Reviewer;
  /** The OCR, created on first use: it loads a few megabytes of language data. */
  recognizer: () => Promise<TextRecognizer>;
  /** The running version: masked-input review is on by default in pre-releases. */
  version: string;
}

/** An input that was not added, and why, for the agent to tell the user. */
export interface SetAside {
  /** The input's masked title. */
  title: string;
  reason: "rejected" | "expired" | "too-many-rounds";
}

export interface IntakeResult {
  added: SourceDocument[];
  setAside: SetAside[];
  /** How many values the user named were not taken (one character, or no letter or digit). Never the values: the user wants them hidden. */
  ignored: number;
  /** Documents whose image the user confirmed, by id. */
  images: string[];
}

export interface ImageInput {
  title: string;
  /** Where it came from, such as a file path: stored as a pseudonym. */
  source: string;
  /** The PNG or JPEG bytes. */
  raw: Uint8Array;
  kind?: NewDocument["kind"];
}

/** What the user is shown for a masked document: everything the agents will read. */
export function reviewText(doc: NewDocument): string {
  const { masking: _, ...metadata } = doc.metadata ?? {};
  const meta = Object.keys(metadata).length ? `\n\nMetadata: ${JSON.stringify(metadata, null, 2)}` : "";
  return `Source: ${doc.source}${meta}\n\n${doc.content}`;
}

const reasonOf = (d: Decision): SetAside["reason"] => (d.status === "expired" ? "expired" : "rejected");

const emptyResult = (): IntakeResult => ({ added: [], setAside: [], ignored: 0, images: [] });

/** A review that failed partway (the browser could not be opened, say), with what was added before. */
export class IntakeError extends Error {
  constructor(
    message: string,
    readonly partial: IntakeResult,
  ) {
    super(message);
  }
}

export class Intake {
  constructor(private readonly opts: IntakeOptions) {}

  /** Whether inputs of `context` are reviewed before they are stored. */
  reviews(context: string): boolean {
    return reviewsInputs(this.opts.contexts.get(context)?.settings, this.opts.version);
  }

  /**
   * Masks documents and adds them to `context`. While review is on, the user checks each one
   * first: approved ones are added, rejected or expired ones set aside, and values the user
   * names are hidden before they check again.
   */
  async addDocuments(context: string, docs: readonly NewDocument[], dictionary: readonly DictionaryEntry[] = []): Promise<IntakeResult> {
    const { contexts, masker } = this.opts;
    const result = emptyResult();
    if (!this.reviews(context)) {
      result.added = await masker.addDocuments(contexts, context, docs, dictionary);
      return result;
    }
    for (const doc of docs) await this.partial(result, () => this.reviewDocument(context, doc, dictionary, result));
    return result;
  }

  private async reviewDocument(context: string, doc: NewDocument, dictionary: readonly DictionaryEntry[], result: IntakeResult): Promise<void> {
    const missed: DictionaryEntry[] = [];
    let title = "";
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const masked = await this.opts.masker.maskDocument(context, doc, [...dictionary, ...missed]);
      title = masked.title;
      const counts = (masked.metadata?.masking as { counts: Record<string, number> } | undefined)?.counts;
      const decision = await this.ask({ kind: "input", title, content: reviewText(masked), counts } satisfies InputRequest);
      if (decision.status === "approved") {
        result.added.push(...this.opts.contexts.addDocuments(context, [masked]));
        return;
      }
      this.learn(context, decision, missed, result);
      if (decision.status !== "revise") {
        result.setAside.push({ title, reason: reasonOf(decision) });
        return;
      }
    }
    result.setAside.push({ title, reason: "too-many-rounds" });
  }

  /** Runs one input's review; a failure carries what was added before it. */
  private async partial(result: IntakeResult, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (err) {
      throw new IntakeError((err as Error).message, result);
    }
  }

  /**
   * Redacts an image and asks the user to confirm it (FE4), whatever the review setting: the
   * OCR may not have read all of it. The user can use the image, only its masked text, or
   * neither; they can have the words the OCR was unsure of blacked out, or name values still
   * visible, and check again.
   */
  async addImage(context: string, input: ImageInput, dictionary: readonly DictionaryEntry[] = []): Promise<IntakeResult> {
    const result = emptyResult();
    await this.partial(result, () => this.reviewImage(context, input, dictionary, result));
    return result;
  }

  private async reviewImage(context: string, input: ImageInput, dictionary: readonly DictionaryEntry[], result: IntakeResult): Promise<void> {
    const { contexts, masker } = this.opts;
    const recognizer = await this.opts.recognizer();
    const missed: DictionaryEntry[] = [];
    let redactUncertain = false;
    let title = "";
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const words = [...dictionary, ...missed];
      const masked = await masker.maskImage(context, input.raw, recognizer, { dictionary: words, redactUncertain });
      const named = await masker.mask(context, input.title, words);
      title = named.text;
      const counts = { ...masked.report.counts };
      for (const [type, n] of Object.entries(named.report.counts)) counts[type] = (counts[type] ?? 0) + n;
      const decision = await this.ask({
        kind: "image",
        title,
        image: masked.image,
        width: masked.width,
        height: masked.height,
        text: masked.text,
        trusted: masked.ocr.trusted,
        uncertain: masked.ocr.uncertain,
        counts,
      } satisfies ImageRequest);
      switch (decision.status) {
        case "approved":
        case "text-only": {
          const textOnly = decision.status === "text-only";
          const { confidence, trusted, rotated, words: read } = masked.ocr;
          const doc: NewDocument = {
            kind: input.kind ?? "other",
            title,
            source: masker.maskSource(context, input.source),
            content: masked.text,
            metadata: { image: { width: masked.width, height: masked.height, confidence, trusted, rotated, words: read, textOnly }, masking: masked.report },
            masked: true,
          };
          const image = textOnly ? undefined : { png: Buffer.from(masked.image), width: masked.width, height: masked.height, digest: decision.digest };
          const saved = contexts.addImageDocument(context, doc, image);
          result.added.push(saved);
          if (image) result.images.push(saved.id);
          return;
        }
        case "redact-uncertain":
          redactUncertain = true;
          break;
        case "revise":
          this.learn(context, decision, missed, result);
          if (decision.choice === "redact-uncertain") redactUncertain = true;
          break;
        default:
          this.learn(context, decision, missed, result);
          result.setAside.push({ title, reason: reasonOf(decision) });
          return;
      }
    }
    result.setAside.push({ title, reason: "too-many-rounds" });
  }

  /** Asks the user, and refuses a decision about anything but what was shown. */
  private async ask(req: ApprovalRequest): Promise<Decision> {
    const decision = await this.opts.reviewer.review(req);
    if (decision.digest !== requestDigest(req)) throw new Error("The decision does not match what was shown for review, so nothing was added.");
    return decision;
  }

  /** Hides the values the user named, in this input and every later one, whatever they decided. */
  private learn(context: string, decision: Decision, missed: DictionaryEntry[], result: IntakeResult): void {
    if (!decision.missed.length) return;
    const { entries, ignored } = this.opts.masker.declare(context, decision.missed);
    result.ignored += ignored;
    missed.push(...entries);
  }
}
