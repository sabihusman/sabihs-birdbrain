/**
 * Pick the article sections a question needs, within a token budget, so the
 * prompt carries ~1,500 tokens of context instead of the whole article.
 *
 * Scoring is keyword overlap: the question's words (lower-case, stop words
 * removed, a plural/-ing/-ed suffix stripped so "eat" meets "eats" and
 * "breed" meets "breeding") against each section's heading and text; a word
 * in the heading counts three times. Sections are added in score order until the
 * budget is spent (tokens estimated as characters / 4); the chosen ones go
 * back into article order. The lead is always a candidate (score at least 1:
 * it is the overview the model falls back on and the section it can cite when
 * saying "not covered"), so with no match at all the lead (or Description, or
 * the first section) is sent alone.
 */
import type { ArticleSection } from './wiki-article.js';

export const CONTEXT_TOKEN_BUDGET = 1500;
/** A section cut to fit must keep at least this many tokens to be worth sending. */
const MIN_PARTIAL_TOKENS = 60;
const HEADING_WEIGHT = 3;

export const STOP_WORDS: ReadonlySet<string> = new Set(
  (
    'a an the and or but if of to in on at by for with from as is are was were be been being it its this that these those ' +
    'do does did done can could should would will shall may might must have has had having not no nor so than too very ' +
    'what which who whom whose when where why how about into over under again further then once here there all any both each ' +
    'few more most other some such only own same s t just also i me my we our you your he she they them their his her bird birds ' +
    'species tell please know like get much many while during'
  ).split(/\s+/),
);

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** A light English suffix strip: breeds/breeding → breed, berries → berry, nested → nest. Not a real stemmer. */
export function stem(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.endsWith('ing') && word.length > 5 && /[aeiouy]/.test(word.slice(0, -3))) return word.slice(0, -3);
  if (word.endsWith('ed') && word.length > 4 && !word.endsWith('eed')) return word.slice(0, -2);
  if (word.endsWith('es') && word.length > 4 && /[sxz]|ch|sh/.test(word.slice(-4, -2))) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** Distinct keyword stems of a text, lower-case, stop words and one-letter tokens removed. */
export function keywords(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (w.length < 2 || STOP_WORDS.has(w)) continue;
    out.add(stem(w));
  }
  return out;
}

export function scoreSection(section: Pick<ArticleSection, 'heading' | 'text'>, questionWords: ReadonlySet<string>): number {
  let score = /^lead$/i.test(section.heading.trim()) ? 1 : 0;
  if (questionWords.size === 0) return score;
  const head = keywords(section.heading);
  const body = keywords(section.text);
  for (const w of questionWords) {
    if (head.has(w)) score += HEADING_WEIGHT;
    if (body.has(w)) score += 1;
  }
  return score;
}

function fallbackIndex(sections: ReadonlyArray<ArticleSection>): number {
  const i = sections.findIndex((s) => /^(lead|summary|description)$/i.test(s.heading.trim()));
  return i >= 0 ? i : 0;
}

function cut(text: string, tokens: number): string {
  const chars = tokens * 4;
  if (text.length <= chars) return text;
  return `${text.slice(0, chars).replace(/\s+\S*$/, '')} […]`;
}

/** Sections relevant to the question, in article order, within `maxTokens`. */
export function selectRelevantSections(sections: ReadonlyArray<ArticleSection>, question: string, maxTokens = CONTEXT_TOKEN_BUDGET): ArticleSection[] {
  if (sections.length === 0) return [];
  const words = keywords(question);
  const ranked = sections
    .map((s, index) => ({ s, index, score: scoreSection(s, words) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  if (ranked.length === 0) {
    const i = fallbackIndex(sections);
    ranked.push({ s: sections[i], index: i, score: 0 });
  }
  const chosen: Array<{ index: number; section: ArticleSection }> = [];
  let budget = maxTokens;
  for (const r of ranked) {
    const need = estimateTokens(r.s.heading) + estimateTokens(r.s.text) + 4;
    if (need <= budget) {
      chosen.push({ index: r.index, section: r.s });
      budget -= need;
    } else {
      const room = budget - estimateTokens(r.s.heading) - 4;
      if (room >= MIN_PARTIAL_TOKENS) chosen.push({ index: r.index, section: { ...r.s, text: cut(r.s.text, room) } });
      budget = 0;
    }
    if (budget < MIN_PARTIAL_TOKENS) break;
  }
  return chosen.sort((a, b) => a.index - b.index).map((c) => c.section);
}
