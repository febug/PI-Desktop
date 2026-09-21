import {
  readComposerSource,
  readComposerModule,
} from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  HOME_DRAFT_KEY,
  getComposerWorkspaceRevision,
  invalidateComposerWorkspace,
  reconcileComposerWorkspace,
  adoptHomeDraftForSession,
  captureComposerDraft,
  deleteComposerDraft,
  draftKeyForSession,
  flushScheduledHomeDraftAdopt,
  scheduleHomeDraftAdopt,
  draftOwnerSessionId,
  pruneComposerDrafts,
  readComposerDraft,
  resetComposerDraftCache,
  snapshotComposerDraft,
  writeComposerDraft,
} from "../src/lib/composer-draft-cache.ts";

const composer = await readComposerSource();
const draftHook = await readComposerModule("hooks/useComposerDraft.ts");

test.afterEach(() => {
  resetComposerDraftCache();
});

test("draft keys isolate the home slot from a session id", () => {
  assert.equal(draftKeyForSession(null), HOME_DRAFT_KEY);
  assert.equal(draftKeyForSession(undefined), HOME_DRAFT_KEY);
  assert.equal(draftKeyForSession("sess-1"), "sess-1");
  assert.equal(draftOwnerSessionId(HOME_DRAFT_KEY), "");
  assert.equal(draftOwnerSessionId("sess-1"), "sess-1");
});

test("home snapshots keep file references owned by the empty session id", () => {
  const snapshot = snapshotComposerDraft(
    "see this",
    [
      { sessionId: "", path: "/tmp/a.txt", name: "a.txt", kind: "file", token: "\uE000" },
      { sessionId: "other", path: "/tmp/b.txt", name: "b.txt", kind: "file" },
    ],
    HOME_DRAFT_KEY,
  );
  assert.equal(snapshot.text, "see this");
  assert.deepEqual(snapshot.fileReferences, [
    { path: "/tmp/a.txt", name: "a.txt", kind: "file", token: "\uE000" },
  ]);
});

test("the module cache survives a Composer remount", () => {
  captureComposerDraft("sess-a", "draft A", []);
  captureComposerDraft(HOME_DRAFT_KEY, "home draft", [
    { sessionId: "", path: "/tmp/note.txt", name: "note.txt", kind: "file" },
  ]);
  // A remount is just another reader of the same map.
  assert.equal(readComposerDraft("sess-a")?.text, "draft A");
  assert.equal(readComposerDraft(HOME_DRAFT_KEY)?.text, "home draft");
  assert.equal(readComposerDraft(HOME_DRAFT_KEY)?.fileReferences[0]?.name, "note.txt");
});

test("pruning drops deleted sessions and keeps home plus the live key", () => {
  writeComposerDraft("gone", { text: "stale", fileReferences: [] });
  writeComposerDraft("kept", { text: "live", fileReferences: [] });
  writeComposerDraft(HOME_DRAFT_KEY, { text: "home", fileReferences: [] });
  pruneComposerDrafts([HOME_DRAFT_KEY, "kept"]);
  assert.equal(readComposerDraft("gone"), undefined);
  assert.equal(readComposerDraft("kept")?.text, "live");
  assert.equal(readComposerDraft(HOME_DRAFT_KEY)?.text, "home");
});

test("deleting a slot does not clear a different session", () => {
  captureComposerDraft("a", "alpha", []);
  captureComposerDraft("b", "beta", []);
  deleteComposerDraft("a");
  assert.equal(readComposerDraft("a"), undefined);
  assert.equal(readComposerDraft("b")?.text, "beta");
});

test("adopting the home draft moves the live snapshot onto the created session", () => {
  captureComposerDraft(HOME_DRAFT_KEY, "typed during create", []);
  adoptHomeDraftForSession("sess-new");
  assert.equal(readComposerDraft(HOME_DRAFT_KEY), undefined);
  assert.equal(readComposerDraft("sess-new")?.text, "typed during create");
  captureComposerDraft(HOME_DRAFT_KEY, "later home", []);
  writeComposerDraft("sess-new", { text: "already owned", fileReferences: [] });
  adoptHomeDraftForSession("sess-new");
  assert.equal(readComposerDraft("sess-new")?.text, "later home");
  assert.equal(readComposerDraft(HOME_DRAFT_KEY), undefined);
});

test("flushing a scheduled adopt uses the Composer persist that rewrote home", () => {
  scheduleHomeDraftAdopt("sess-new");
  writeComposerDraft(HOME_DRAFT_KEY, {
    text: "typed after persist",
    fileReferences: [],
  });
  flushScheduledHomeDraftAdopt("other");
  assert.equal(readComposerDraft(HOME_DRAFT_KEY)?.text, "typed after persist");
  flushScheduledHomeDraftAdopt("sess-new");
  assert.equal(readComposerDraft(HOME_DRAFT_KEY), undefined);
  assert.equal(readComposerDraft("sess-new")?.text, "typed after persist");
  writeComposerDraft(HOME_DRAFT_KEY, { text: "stale home", fileReferences: [] });
  flushScheduledHomeDraftAdopt("sess-new");
  assert.equal(readComposerDraft("sess-new")?.text, "typed after persist");
  assert.equal(readComposerDraft(HOME_DRAFT_KEY)?.text, "stale home");
});

test("composer hydrates from the shared cache and persists across unmount and hidden windows", () => {
  assert.match(draftHook, /composer-draft-cache/);
  assert.match(composer, /readComposerDraft\(draftKey\)/);
  assert.match(composer, /useState\(\(\) => initialDraft\?\.text \?\? ""\)/);
  assert.match(composer, /persistDraft\(draftKeyRef\.current\)/);
  assert.match(composer, /document\.visibilityState === "hidden"/);
  assert.match(composer, /window\.addEventListener\("blur", onWindowBlur\)/);
  assert.match(composer, /window\.addEventListener\("focus", onVisibility\)/);
  assert.match(composer, /paintCurrentDraft\(element, expected\)/);
  assert.match(composer, /const previousKey = draftKeyRef\.current/);
  assert.match(composer, /persistDraft\(previousKey\)/);
  assert.match(composer, /flushScheduledHomeDraftAdopt\(draftKey\)/);
  assert.match(composer, /const nextDraft = readComposerDraft\(draftKey\)/);
  assert.match(composer, /setValue\(valueRef\.current\)/);
  assert.match(composer, /setFileReferences\(fileReferencesRef\.current\)/);
  assert.doesNotMatch(composer, /new Map<string, ComposerDraftSnapshot>\(\)/);
  assert.doesNotMatch(composer, /draftCacheRef/);
});

test("composer handles home drafts, deleted sessions, and async sends by key", () => {
  assert.match(composer, /pruneComposerDrafts\(\[/);
  assert.match(composer, /HOME_DRAFT_KEY,/);
  assert.match(composer, /const clearDraftForKey = \(key: string\)/);
  assert.match(composer, /deleteComposerDraft\(key\)/);
  assert.match(composer, /draftKeyForSession\(useAppStore\.getState\(\)\.activeSessionId\)/);
  assert.match(composer, /const submittedDraftKey = draftKey/);
  assert.match(composer, /clearDraftForKey\(submittedDraftKey\)/);
  assert.doesNotMatch(composer, /if \(accepted\) clearDraft\(\);/);
});


test("workspace invalidation clears relative chips in every cached slot but keeps absolute attachments and text", () => {
  const fileReferences = [
    { path: "src/main.ts", name: "main.ts", token: "\uE001" },
    { path: "/scratch/notes.txt", name: "notes.txt", token: "\uE002" },
    { path: "C:\\scratch\\notes.txt", name: "notes.txt", token: "\uE003" },
    { path: "\\\\server\\scratch\\notes.txt", name: "notes.txt", token: "\uE004" },
    { path: "/scratch/image.png", name: "image.png", kind: "image" },
  ];
  for (const key of [HOME_DRAFT_KEY, "sess-a", "sess-b"]) {
    writeComposerDraft(key, { text: "😀 \uE001 \uE002 \uE003 \uE004 unbound \uE005", fileReferences });
  }
  invalidateComposerWorkspace();
  for (const key of [HOME_DRAFT_KEY, "sess-a", "sess-b"]) {
    assert.deepEqual(readComposerDraft(key), {
      text: "😀  \uE002 \uE003 \uE004 unbound \uE005",
      fileReferences: fileReferences.slice(1),
    });
  }
});

test("late persistence and home adoption cannot resurrect references from an earlier workspace", () => {
  const revision = getComposerWorkspaceRevision();
  const references = [{ path: "src/main.ts", name: "main.ts", token: "\uE001" }];
  invalidateComposerWorkspace();
  invalidateComposerWorkspace(); // Away and back is still a different lifetime.
  captureComposerDraft(HOME_DRAFT_KEY, "check \uE001", references, revision);
  adoptHomeDraftForSession("sess-new");
  assert.deepEqual(readComposerDraft("sess-new"), { text: "check ", fileReferences: [] });
  writeComposerDraft("sess-late", { text: "check \uE001", fileReferences: references }, revision);
  assert.deepEqual(readComposerDraft("sess-late"), { text: "check ", fileReferences: [] });
  writeComposerDraft("sess-current", { text: "check \uE001", fileReferences: references });
  assert.equal(readComposerDraft("sess-current").fileReferences.length, 1);
});

test("workspace cleanup adjusts a UTF-16 caret only for removed chip tokens", () => {
  const revision = getComposerWorkspaceRevision();
  invalidateComposerWorkspace();
  const result = reconcileComposerWorkspace("😀 \uE001 x \uE001", [
    { path: "src/main.ts", token: "\uE001" },
  ], revision, 5);
  assert.deepEqual(result, { text: "😀  x ", fileReferences: [], caret: 4 });
});
