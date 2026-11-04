/**
 * Module: linkify
 * Purpose: Render free text with its http(s) URLs as clickable links. Builds DOM
 *          nodes (text + <a>) instead of HTML, so the text needs no escaping and
 *          no innerHTML is involved.
 */

const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi;
// Trailing punctuation usually ends the sentence, not the URL.
const TRAILING_RE = /[.,;:!?)\]]+$/;

/**
 * @param {string} text
 * @returns {DocumentFragment}
 */
export function linkify(text) {
  const fragment = document.createDocumentFragment();
  const source = String(text ?? '');
  let last = 0;
  for (const match of source.matchAll(URL_RE)) {
    let url = match[0];
    const trailing = url.match(TRAILING_RE)?.[0] ?? '';
    if (trailing) url = url.slice(0, -trailing.length);
    if (match.index > last) fragment.append(source.slice(last, match.index));
    const a = document.createElement('a');
    a.href = url;
    a.textContent = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    // Links often sit inside a row that toggles on click; the link should only navigate.
    a.addEventListener('click', (event) => event.stopPropagation());
    fragment.append(a);
    last = match.index + url.length;
  }
  if (last < source.length) fragment.append(source.slice(last));
  return fragment;
}
