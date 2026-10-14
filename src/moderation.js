// Automatic content checks. These catch obvious adult content; everything else
// still goes to the site owner's review queue before it goes live.
//
// Uses Workers AI when it's available (free daily allowance; on the free plan it
// stops working at the cap rather than charging). If a check can't run, the item
// is marked "not auto-checked" for manual review instead of being blocked.

export const ADULT_MESSAGE = "This looks like adult content, which isn't allowed on SpawnpointAI. Edit it and try again.";

// Unambiguous terms: a match blocks the submission.
const HARD = [
  'porn', 'porno', 'pornographic', 'pornography', 'hentai', 'xxx', 'nsfw', 'rule ?34', 'onlyfans',
  'nude', 'nudes', 'nudity', 'erotic', 'erotica', 'sexting', 'blowjob', 'handjob', 'cumshot', 'creampie',
  'dildo', 'orgasm', 'masturbat[a-z]*', 'genitals', 'penis', 'vagina', 'pussy', 'tits', 'boobs', 'milf',
  'bdsm', 'fetish', 'stripper', 'strip ?club', 'camgirl', 'escort service', 'adults? only', '18\\+ only',
  'sex games?', 'sex sim', 'sex scenes?',
];
// Suggestive terms: noted for the reviewer, not blocked.
const SOFT = ['sex', 'sexy', 'sexual', 'naked', 'lingerie', 'seduc[a-z]*', 'kinky', 'horny', 'lewd', 'waifu', 'dating sim', 'gore'];

const wordRe = (list) => new RegExp(`(?:^|[^a-z0-9])(${list.join('|')})(?=[^a-z0-9]|$)`, 'i');
const HARD_RE = wordRe(HARD);
const SOFT_RE = wordRe(SOFT);

function variants(text) {
  const base = String(text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  // Undo common letter swaps (p0rn, s3x, nud3) as a second pass.
  const leet = base.replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/4|@/g, 'a').replace(/5|\$/g, 's').replace(/[*._-]/g, '');
  return [base, leet];
}

export function keywordCheck(text) {
  let hard = null, soft = null;
  for (const v of variants(text)) {
    hard = hard || v.match(HARD_RE)?.[1] || null;
    soft = soft || v.match(SOFT_RE)?.[1] || null;
  }
  return { hard, soft };
}

const CATEGORIES = {
  S1: 'violent crimes', S2: 'non-violent crimes', S3: 'sex-related crimes', S4: 'child exploitation', S5: 'defamation',
  S6: 'specialized advice', S7: 'privacy', S8: 'intellectual property', S9: 'weapons', S10: 'hate', S11: 'self-harm',
  S12: 'sexual content', S13: 'elections', S14: 'code abuse',
};
const SEXUAL = new Set(['S3', 'S4', 'S12']);

function withTimeout(promise, ms = 10000) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}

// Text check with Llama Guard. Returns { status: 'safe' | 'sexual' | 'flagged' | 'unavailable', labels }.
export async function aiTextCheck(env, text) {
  if (!env.AI || !text.trim()) return { status: env.AI ? 'safe' : 'unavailable', labels: [] };
  try {
    const res = await withTimeout(env.AI.run('@cf/meta/llama-guard-3-8b', {
      messages: [{ role: 'user', content: `Game store listing:\n${text.slice(0, 4000)}` }],
    }));
    const out = typeof res?.response === 'string' ? res.response : JSON.stringify(res?.response ?? res);
    if (!/unsafe|"safe":\s*false/i.test(out)) return { status: 'safe', labels: [] };
    const codes = [...new Set(out.match(/S\d{1,2}/g) || [])];
    const labels = codes.map((c) => CATEGORIES[c] || c);
    return { status: codes.some((c) => SEXUAL.has(c)) ? 'sexual' : 'flagged', labels };
  } catch (err) {
    console.warn('aiTextCheck unavailable:', err.message);
    return { status: 'unavailable', labels: [] };
  }
}

// Image check with a vision model. Returns 'safe' | 'explicit' | 'unavailable'.
export const MAX_SCAN_BYTES = 600 * 1024;
export async function aiImageCheck(env, bytes) {
  if (!env.AI || !bytes || bytes.byteLength > MAX_SCAN_BYTES) return 'unavailable';
  try {
    const res = await withTimeout(env.AI.run('@cf/llava-hf/llava-1.5-7b-hf', {
      image: Array.from(new Uint8Array(bytes)),
      prompt: 'Does this image show nudity, exposed genitals or breasts, or sexual activity? Answer only yes or no.',
      max_tokens: 4,
    }), 15000);
    const answer = String(res?.description ?? res?.response ?? '').trim().toLowerCase();
    if (!answer) return 'unavailable';
    return answer.startsWith('yes') ? 'explicit' : 'safe';
  } catch (err) {
    console.warn('aiImageCheck unavailable:', err.message);
    return 'unavailable';
  }
}

// Checks a game's listing text. Throws via `fail` on obvious adult content;
// otherwise returns notes for the reviewer.
export async function checkListing(env, fields, fail) {
  const text = Object.entries(fields).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n');
  const { hard, soft } = keywordCheck(text);
  if (hard) fail(422, ADULT_MESSAGE);
  const notes = [];
  if (soft) notes.push(`Listing mentions "${soft}"`);
  const ai = await aiTextCheck(env, text);
  if (ai.status === 'sexual') fail(422, ADULT_MESSAGE);
  if (ai.status === 'flagged') notes.push(`AI check flagged the listing: ${ai.labels.join(', ')}`);
  if (ai.status === 'unavailable') notes.push('Listing text was not AI-checked');
  return notes;
}

// Visible text of an HTML page, for the keyword check on game files.
export function visibleText(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').slice(0, 200000);
}
