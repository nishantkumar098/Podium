/**
 * @mention parsing for chat -> task promotion (blueprint §23, the prototype's
 * worked "@Rohit please confirm sound vendor" example).
 *
 * Kept as a pure function with no database or Nest dependencies so the
 * matching rules can be unit-tested directly against the real AMM roster
 * without standing up an app.
 */

export interface MentionCandidate {
  /** The handle exactly as typed, without the leading "@". */
  handle: string;
  /** Character offset of the "@" in the message body. */
  index: number;
}

export interface RosterUser {
  id: string;
  name: string;
  username: string | null;
  email: string | null;
}

export interface ResolvedMention {
  handle: string;
  user: RosterUser | null;
  /** Set when a handle matched more than one person — never guessed. */
  ambiguousWith?: string[];
}

/**
 * Pulls `@handle` tokens out of a message body. A handle runs to the first
 * whitespace or sentence punctuation, so "@Rohit please confirm" yields
 * "Rohit" and "@Rohit, thanks" yields "Rohit" rather than "Rohit,".
 *
 * E-mail addresses are deliberately NOT treated as mentions: "mail
 * anant@ammbrands.in" has no word boundary before the "@", so it is skipped.
 */
export function findMentionCandidates(body: string): MentionCandidate[] {
  const out: MentionCandidate[] = [];
  const re = /(^|[\s(\[])@([A-Za-z][A-Za-z0-9._'-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const handle = m[2].replace(/[.'-]+$/, ""); // trailing punctuation isn't part of a name
    if (handle) out.push({ handle, index: m.index + m[1].length });
  }
  return out;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Resolves a handle against the real employee roster, most specific first:
 * e-mail local part ("rohit.meena"), then full name ("RohitMeena"), then
 * first name ("Rohit").
 *
 * A handle matching several people resolves to nothing and reports the
 * collision rather than picking one — assigning a task to the wrong colleague
 * because two share a first name is worse than asking the sender to be
 * explicit. Today all 15 AMM first names are distinct, but that is a fact
 * about the current roster, not a guarantee to build on.
 */
export function resolveMention(handle: string, roster: RosterUser[]): ResolvedMention {
  const want = slug(handle);
  if (!want) return { handle, user: null };

  const tiers: ((u: RosterUser) => boolean)[] = [
    (u) => slug(u.username ?? u.email?.split("@")[0] ?? "") === want,
    (u) => slug(u.name) === want,
    (u) => slug(u.name.split(/\s+/)[0]) === want,
  ];

  for (const match of tiers) {
    const hits = roster.filter(match);
    if (hits.length === 1) return { handle, user: hits[0] };
    if (hits.length > 1) return { handle, user: null, ambiguousWith: hits.map((h) => h.name) };
  }
  return { handle, user: null };
}

export function resolveMentions(body: string, roster: RosterUser[]): ResolvedMention[] {
  const seen = new Set<string>();
  const out: ResolvedMention[] = [];
  for (const c of findMentionCandidates(body)) {
    const key = slug(c.handle);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(resolveMention(c.handle, roster));
  }
  return out;
}

/**
 * Turns the message into a task title: drops the mention tokens, collapses
 * whitespace, trims filler politeness, and caps the length. The sender can
 * always override it — this only has to be a sensible default.
 */
export function suggestTaskName(body: string, max = 120): string {
  let text = body.replace(/(^|[\s(\[])@[A-Za-z][A-Za-z0-9._'-]*/g, "$1").replace(/\s+/g, " ").trim();
  text = text.replace(/^(please|pls|kindly|can you|could you|hey|hi)\b[\s,:-]*/i, "").trim();
  if (!text) return "Follow-up from chat";
  const firstLine = text.split(/[\n.!?]/)[0].trim() || text;
  const name = firstLine.length > max ? `${firstLine.slice(0, max - 1).trimEnd()}…` : firstLine;
  return name.charAt(0).toUpperCase() + name.slice(1);
}
