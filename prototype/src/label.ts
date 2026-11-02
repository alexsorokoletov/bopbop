// Tab group names and colors: "Agent:<code>". The code is 1-5 letters, digits or emoji (an emoji counts as one), short enough
// for a tab group chip and different per session. Default: the project's initials + the session's slot number.
import { basename } from 'node:path';

const graphemes = (s: string) => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)].map((g) => g.segment);
const isLetterOrDigit = (g: string) => /^[\p{L}\p{N}]\p{M}*$/u.test(g);
const isEmoji = (g: string) =>
  /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(g) && !/[\p{L}\p{N}]/u.test(g.replace(/\p{Emoji_Component}/gu, '').normalize());

/** The label, trimmed; throws unless it is 1-5 letters, digits or emoji. */
export function checkLabel(label: string): string {
  const s = label.trim();
  const gs = graphemes(s);
  if (gs.length < 1 || gs.length > 5 || !gs.every((g) => isLetterOrDigit(g) || isEmoji(g))) {
    throw new Error('label must be 1-5 letters, digits or emoji, e.g. CT2, ALD, 🧪 or 🦊🔥 (an emoji counts as one)');
  }
  return s;
}

/** Project initials (1-3 letters, or the first 2-3 letters of a one-word name) + slot number (1-based). */
export function defaultLabel(projectDir: string, slot: number): string {
  const words = basename(projectDir)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => /^\p{L}/u.test(w));
  return abbreviate(words).toUpperCase() + String(slot + 1);
}

function abbreviate(words: string[]): string {
  if (words.length > 1)
    return words
      .slice(0, 3)
      .map((w) => graphemes(w)[0])
      .join('');
  if (words.length === 1)
    return graphemes(words[0])
      .slice(0, words[0].length > 3 ? 3 : 2)
      .join('');
  return 'BB'; // no usable name
}

/** Chrome's tab group colors (chrome.tabGroups.Color). Agent groups are purple unless the agent picks one. */
export const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'] as const;
export type GroupColor = (typeof GROUP_COLORS)[number];

/** The color, trimmed and lower-cased; throws unless it is one of GROUP_COLORS. */
export function checkColor(color: string): GroupColor {
  const c = color.trim().toLowerCase();
  if (!(GROUP_COLORS as readonly string[]).includes(c)) throw new Error(`color must be one of ${GROUP_COLORS.join(', ')}`);
  return c as GroupColor;
}
