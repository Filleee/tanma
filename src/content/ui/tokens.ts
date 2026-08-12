import type { Token } from "../../common/types";
import type { KnownWordsStore } from "../../lib/storage";
import { furiganaFor } from "../../lib/kana";
import { el } from "./dom";

export interface TokenCtx {
  known: KnownWordsStore;
  showFurigana: boolean;
  /** Whether this word's lemma already has an Anki card (shows a "mined" marker). */
  mined?(dict: string): boolean;
  onClick(token: Token, tokenEl: HTMLElement, ev: MouseEvent): void;
  /** Pointer moving over the word (carries live modifier-key state for hold-to-look-up). */
  onMove(token: Token, tokenEl: HTMLElement, ev: MouseEvent): void;
  onLeave(token: Token, tokenEl: HTMLElement): void;
}

/** Which sentence (token list + position) a rendered token element belongs to — used at
 *  look-up time to build multi-word expression candidates from the following tokens. */
const tokenContext = new WeakMap<HTMLElement, { tokens: Token[]; index: number }>();
export function tokenContextOf(el: HTMLElement): { tokens: Token[]; index: number } | undefined {
  return tokenContext.get(el);
}

/**
 * Render one cue's text into a `.tnm-sentence` element. Word tokens become
 * interactive `.tnm-token` spans (with furigana + known-status); separators
 * stay as plain text so spacing/wrapping behave naturally.
 */
export function renderSentence(tokens: Token[], ctx: TokenCtx): HTMLElement {
  const sentence = el("span", { class: "tnm-sentence" });

  for (const [index, token] of tokens.entries()) {
    // Grammar morphemes (particles を/に/は, auxiliaries, copula) — tagged by the tokenizer's
    // part-of-speech. CSS tints `.tnm-particle` a distinct colour when the grammar flag is on.
    const isGrammar = token.pos === "particle" || token.pos === "auxiliary";
    if (!token.isWord) {
      if (isGrammar) sentence.append(el("span", { class: "tnm-particle" }, token.surface));
      else sentence.append(document.createTextNode(token.surface));
      continue;
    }

    const content = el("span", { class: "-tnm-content" });
    const furi = ctx.showFurigana ? furiganaFor(token.surface, token.reading) : "";
    if (furi) {
      const ruby = el("ruby", { class: "tnm-reading" });
      ruby.append(el("span", { class: "tnm-surface" }, token.surface));
      ruby.append(el("rt", {}, furi));
      content.append(ruby);
    } else {
      content.append(el("span", { class: "tnm-surface" }, token.surface));
    }

    const tok = el(
      "span",
      {
        class: "tnm-token -tnm-word" + (isGrammar ? " -tnm-particle" : ""),
        "data-dict": token.dict,
        "data-tnm-known-status": ctx.known.get(token.dict),
        ...(ctx.mined?.(token.dict) ? { "data-tnm-mined": "1" } : {}),
      },
      content,
    );

    tokenContext.set(tok, { tokens, index });
    tok.addEventListener("mousemove", (ev) => ctx.onMove(token, tok, ev));
    tok.addEventListener("mouseleave", () => ctx.onLeave(token, tok));
    tok.addEventListener("click", (ev) => {
      ev.stopPropagation();
      // If the user just drag-selected text, this click ends the drag — don't also open
      // the whole-word lookup (the selection handler looks up the selected span instead).
      const root = tok.getRootNode() as unknown as { getSelection?: () => Selection | null };
      const sel = root.getSelection?.() ?? window.getSelection?.();
      if (sel && !sel.isCollapsed && sel.toString().trim()) return;
      ctx.onClick(token, tok, ev);
    });

    sentence.append(tok);
  }

  return sentence;
}

/** Update status colors (and optionally the mined marker) in-place when they change. */
export function refreshTokenStatuses(container: HTMLElement, known: KnownWordsStore, isMined?: (dict: string) => boolean): void {
  container.querySelectorAll<HTMLElement>(".tnm-token[data-dict]").forEach((tok) => {
    const dict = tok.getAttribute("data-dict")!;
    tok.setAttribute("data-tnm-known-status", known.get(dict));
    if (isMined) {
      if (isMined(dict)) tok.setAttribute("data-tnm-mined", "1");
      else tok.removeAttribute("data-tnm-mined");
    }
  });
}
