import type { ComposerDraftSnapshot } from "./composer-smart-stop";

/**
 * Renderer-memory composer drafts (D301).
 *
 * The cache is module-scoped rather than a Composer `useRef` so a remount —
 * empty-home ↔ docked, chat ↔ Settings/Plugins, or the window hiding and
 * showing — restores the same session slot instead of starting empty.
 * Nothing here is written to disk; a full renderer reload still starts blank,
 * matching the in-memory contract in the component spec.
 */
export const HOME_DRAFT_KEY = "__home__";

export type ComposerDraftFileInput = {
  sessionId?: string;
  path: string;
  name: string;
  kind?: "image" | "file";
  mimeType?: string;
  token?: string;
};

const cache = new Map<string, ComposerDraftSnapshot>();
// A -> B -> A is a new lifetime even when React batches the transitions.
let workspaceRevision = 0;

export const getComposerWorkspaceRevision = () => workspaceRevision;

/** Paste/scratch files keep absolute paths; `@` entries are workspace-relative. */
function isPersistedScratchReference(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/** Keep the draft's text and absolute attachments across a workspace change. */
export function reconcileComposerWorkspace<T extends { path: string; token?: string }>(
  text: string,
  fileReferences: readonly T[],
  sourceRevision: number,
  caret = text.length,
): { text: string; fileReferences: T[]; caret: number } {
  if (sourceRevision === workspaceRevision) return { text, fileReferences: [...fileReferences], caret };
  const droppedTokens = new Set(fileReferences
    .filter((reference) => !isPersistedScratchReference(reference.path))
    .flatMap((reference) => reference.token ? [reference.token] : []));
  let nextText = "";
  let nextCaret = caret;
  let index = 0;
  for (const char of text) {
    if (droppedTokens.has(char)) {
      if (index < caret) nextCaret -= char.length;
    } else nextText += char;
    index += char.length;
  }
  return {
    text: nextText,
    fileReferences: fileReferences.filter((reference) => isPersistedScratchReference(reference.path)),
    caret: Math.max(0, Math.min(nextCaret, nextText.length)),
  };
}

/** Called at the store publication boundary, including while Settings is open. */
export function invalidateComposerWorkspace(): void {
  const previousRevision = workspaceRevision++;
  for (const [key, draft] of cache) {
    const { text, fileReferences } = reconcileComposerWorkspace(draft.text, draft.fileReferences, previousRevision);
    cache.set(key, { text, fileReferences });
  }
}

export function draftKeyForSession(sessionId: string | null | undefined): string {
  return sessionId ?? HOME_DRAFT_KEY;
}

/** Session id stored on file-reference rows for this cache key. */
export function draftOwnerSessionId(key: string): string {
  return key === HOME_DRAFT_KEY ? "" : key;
}

export function snapshotComposerDraft(
  text: string,
  fileReferences: readonly ComposerDraftFileInput[],
  key: string,
): ComposerDraftSnapshot {
  const owner = draftOwnerSessionId(key);
  return {
    text,
    fileReferences: fileReferences
      .filter((fileReference) => (fileReference.sessionId ?? "") === owner)
      .map(({ path, name, kind, mimeType, token }) => ({
        path,
        name,
        kind,
        ...(mimeType ? { mimeType } : {}),
        ...(token ? { token } : {}),
      })),
  };
}

export function readComposerDraft(key: string): ComposerDraftSnapshot | undefined {
  return cache.get(key);
}

export function writeComposerDraft(
  key: string,
  snapshot: ComposerDraftSnapshot,
  sourceRevision = workspaceRevision,
): void {
  const { text, fileReferences } = reconcileComposerWorkspace(snapshot.text, snapshot.fileReferences, sourceRevision);
  cache.set(key, { text, fileReferences });
}

export function captureComposerDraft(
  key: string,
  text: string,
  fileReferences: readonly ComposerDraftFileInput[],
  sourceRevision = workspaceRevision,
): ComposerDraftSnapshot {
  const snapshot = snapshotComposerDraft(text, fileReferences, key);
  writeComposerDraft(key, snapshot, sourceRevision);
  return cache.get(key)!;
}

export function deleteComposerDraft(key: string): void {
  cache.delete(key);
}

/**
 * Session that should receive the home draft after New Task / materialize.
 *
 * The Composer persists the outgoing `__home__` slot on every key change, which
 * would otherwise put the typed text back after the store has already moved it.
 * `flushScheduledHomeDraftAdopt` runs after that persist so the live snapshot
 * lands on the new session and the home slot stays empty.
 */
let scheduledHomeAdoptSessionId: string | null = null;

/**
 * Move typed home-composer content onto a session that was just created.
 *
 * New Task reveals the empty home before `session.create` returns, so any
 * keystrokes in that interval land in the home slot. They belong to the new
 * session, not to a later startup draft. A non-empty home snapshot wins over
 * an earlier copy of the same slot.
 */
export function adoptHomeDraftForSession(sessionId: string): void {
  if (!sessionId) return;
  const home = cache.get(HOME_DRAFT_KEY);
  cache.delete(HOME_DRAFT_KEY);
  if (!home) return;
  if (!home.text && home.fileReferences.length === 0) return;
  cache.set(sessionId, {
    text: home.text,
    fileReferences: home.fileReferences.map((reference) => ({ ...reference })),
  });
}

export function scheduleHomeDraftAdopt(sessionId: string): void {
  if (!sessionId) return;
  scheduledHomeAdoptSessionId = sessionId;
  adoptHomeDraftForSession(sessionId);
}

export function flushScheduledHomeDraftAdopt(sessionId: string): void {
  if (!sessionId || scheduledHomeAdoptSessionId !== sessionId) return;
  scheduledHomeAdoptSessionId = null;
  adoptHomeDraftForSession(sessionId);
}

export function pruneComposerDrafts(keep: Iterable<string>): void {
  const retain = new Set(keep);
  for (const key of cache.keys()) {
    if (!retain.has(key)) cache.delete(key);
  }
}

/** Test-only: drop every slot so cases cannot leak into one another. */
export function resetComposerDraftCache(): void {
  cache.clear();
  scheduledHomeAdoptSessionId = null;
}
