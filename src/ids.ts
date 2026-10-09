const FILE_RE = /^(?:files\/)?([a-z0-9][a-z0-9-]{0,39})$/;
const INTERACTION_RE = /^[A-Za-z0-9_-]{8,512}$/;

export function normalizeFileId(raw: string): string | null {
  const m = raw.trim().match(FILE_RE);
  return m ? `files/${m[1]}` : null;
}

export function isInteractionId(raw: string): boolean {
  return INTERACTION_RE.test(raw);
}
