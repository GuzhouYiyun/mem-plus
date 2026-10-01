// Session snapshots: `memory/<YYYY-MM-DD>-<slug>.md`.
//
// WHAT THIS IS
//   openclaw has a `session-memory` hook that renders a session into a standalone
//   markdown file when the session is left (new / reset / daily reset / idle expiry),
//   so the raw conversation stays retrievable even after daily capture entries have
//   been distilled or superseded. OpenCode has no session-leave hook, so the
//   equivalent is re-rendering on every `session.execution.succeeded` -- the file is
//   an upsert of the whole session, which makes the write idempotent and means a
//   plugin crash can never leave a half-written history behind (the next turn
//   rewrites it).
//
// WHAT IT IS NOT
//   This is not the extraction path. Captured summaries go to
//   `memory/YYYY-MM-DD.md` via the capture pipeline; this file keeps the words
//   themselves. Both are indexed, so `memory_search` can surface either.
import fs from "node:fs/promises";
import path from "node:path";
import { formatMemoryDreamingDay } from "../../extensions/memory-core/src/capture/day.js";
import { appendRegularFile } from "@openclaw/fs-safe/advanced";
import { archiveProjectDir, memoryDir, projectSlug, titleSlug } from "./paths.js";
import {
  asSessionMessage,
  type PluginContext,
  type SessionContentPart,
  type SessionInfoView,
  type SessionMessageView,
} from "./opencode.js";

/** Marker identifying a file as a mem-plus session snapshot. */
export const SESSION_SNAPSHOT_MARKER_KIND = "mem-plus-session";

/** Tool output is capped so one noisy command cannot swallow the snapshot budget. */
const MAX_TOOL_OUTPUT_CHARS = 2_000;

export function sessionSnapshotMarker(sessionID: string): string {
  return `<!-- ${SESSION_SNAPSHOT_MARKER_KIND}:${sessionID} -->`;
}

function iso(ms: number | undefined): string {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : "unknown";
}

function block(text: string): string {
  return text.replace(/\n+$/, "");
}

function renderToolPart(part: SessionContentPart, indent: string): string[] {
  const name = part.name ?? "tool";
  const lines: string[] = [`${indent}### tool \`${name}\``, ""];
  const input = part.state?.input;
  if (input !== undefined && input !== null) {
    lines.push(`${indent}\`\`\`json`);
    lines.push(indent + safeJson(input));
    lines.push(`${indent}\`\`\``, "");
  }
  const output = (part.state?.content ?? [])
    .map((piece) => piece.text ?? "")
    .join("")
    .trim();
  if (output.length > 0) {
    const trimmed =
      output.length > MAX_TOOL_OUTPUT_CHARS
        ? `${output.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n[... truncated ...]`
        : output;
    lines.push(`${indent}\`\`\``, indent + block(trimmed), `${indent}\`\`\``, "");
  }
  return lines;
}

/**
 * Inline `data:` URLs -- base64 payloads, above all -- are elided before an
 * attachment is written.
 *
 * A single screenshot is tens of thousands of base64 characters, and none of it is
 * text: it cannot be read, searched or embedded. Left in place, one attached image
 * turns a one-line turn into an ~80k-character unit that overflows the embedding
 * model's context, and any search result quoting it returns an unreadable wall of
 * base64. The image itself is untouched in OpenCode's own storage; only the inline
 * copy inside this snapshot is replaced.
 *
 * The pattern matches on the media type and a payload long enough to be real data,
 * so it covers PNG, JPEG, WebP, PDF and plain text alike rather than one encoding.
 */
const INLINE_DATA_URL = /"data:([^";,\s]+)((?:;[^"]*?)*);base64,([A-Za-z0-9+/=\s]{32,}?)"/g;

/** Replaces an elided payload, naming what was dropped so the loss is visible. */
function elideInlineData(text: string): string {
  return text.replace(INLINE_DATA_URL, (_match, mediaType: string, params: string, payload: string) => {
    const bytes = Math.round((payload.replace(/\s+/g, "").length * 3) / 4);
    const kind = mediaType.split("/")[0] || "binary";
    return `"data:${mediaType}${params};base64,[elided ${kind}, ~${bytes} bytes]"`;
  });
}

function safeJson(value: unknown): string {
  const text = (() => {
    try {
      return JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      return String(value);
    }
  })();
  // Applied to the serialised form rather than the object: the payload is an
  // ordinary string once encoded, so this catches it whichever field held it.
  return elideInlineData(text);
}

/** Render one session into the markdown that lands in `memory/<day>-<slug>.md`. */
export function renderSessionSnapshot(params: {
  session: SessionInfoView;
  messages: readonly unknown[];
  workspaceDir: string;
}): string {
  const { session, messages, workspaceDir } = params;
  const sessionID = session.id ?? "unknown";
  const lines: string[] = [
    sessionSnapshotMarker(sessionID),
    "",
    `# ${session.title?.trim() || "Untitled session"}`,
    "",
    `- session: \`${sessionID}\``,
    `- project: \`${workspaceDir}\``,
    `- created: ${iso(session.time?.created)}`,
    `- updated: ${iso(session.time?.updated)}`,
    "",
    "---",
    "",
  ];

  let turns = 0;
  for (const raw of messages) {
    const message: SessionMessageView = asSessionMessage(raw);
    const created = iso(message.time?.created);
    if (message.type === "user") {
      const text = (message.text ?? "").trim();
      if (text.length === 0) continue;
      turns += 1;
      lines.push(`## ${created} · user`, "", block(text), "");
      const files = message.files ?? [];
      if (files.length > 0) {
        lines.push(`<details><summary>${files.length} attachment(s)</summary>`, "");
        for (const file of files) lines.push("- `" + safeJson(file) + "`");
        lines.push("", "</details>", "");
      }
      continue;
    }
    if (message.type !== "assistant") continue;

    const parts = message.content ?? [];
    const prose = parts
      .filter((part) => part?.type === "text")
      .map((part) => part.text ?? "")
      .filter((text) => text.trim().length > 0);
    const tools = parts.filter((part) => part?.type === "tool");
    if (prose.length === 0 && tools.length === 0) continue;

    lines.push(`## ${created} · assistant`, "");
    if (prose.length > 0) lines.push(block(prose.join("\n\n")), "");
    for (const tool of tools) lines.push(...renderToolPart(tool, ""));
  }

  lines.push("---", "");
  return `${lines.join("\n")}\n`;
}

async function writeFileAtomicish(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  // Upsert, not append: a snapshot describes the session as of now, so the previous
  // contents are stale by construction. A crash mid-write is repaired by the next
  // `session.execution.succeeded`.
  await fs.writeFile(filePath, content, "utf-8");
}

export type SnapshotResult = {
  projectPath: string;
  archivePath: string;
  bytes: number;
};

/**
 * Render `sessionID` and upsert the snapshot into both the project memory dir and
 * the global archive. Returns null when the session has nothing worth keeping.
 */
export async function writeSessionSnapshot(
  ctx: PluginContext,
  sessionID: string,
): Promise<SnapshotResult | null> {
  let session: SessionInfoView;
  let messages: readonly unknown[];
  try {
    session = (await ctx.session.get({ sessionID })) as unknown as SessionInfoView;
    messages = await ctx.session.context({ sessionID });
  } catch {
    return null;
  }

  const hasUser = messages.some((raw) => asSessionMessage(raw).type === "user");
  if (!hasUser) return null;

  const workspaceDir = session.location?.directory ?? ctx.location.directory;
  const content = renderSessionSnapshot({ session, messages, workspaceDir });

  const createdAt = session.time?.created ?? Date.now();
  const day = formatMemoryDreamingDay(createdAt);
  const fileName = `${day}-${titleSlug(session.title, sessionID)}.md`;

  const projectPath = path.join(memoryDir(workspaceDir), fileName);
  await writeFileAtomicish(projectPath, content);

  const archivePath = path.join(archiveProjectDir(workspaceDir), fileName);
  await writeFileAtomicish(archivePath, content);

  // The archive is only useful if it stays findable; keep a per-project index of
  // every snapshot ever written there.
  await appendArchiveIndex(workspaceDir, fileName, session, content.length);

  return { projectPath, archivePath, bytes: Buffer.byteLength(content, "utf-8") };
}

async function appendArchiveIndex(
  workspaceDir: string,
  fileName: string,
  session: SessionInfoView,
  bytes: number,
): Promise<void> {
  const indexPath = path.join(archiveProjectDir(workspaceDir), "..", "INDEX.md");
  const line =
    `- [${session.title?.trim() || fileName}](${fileName}) · \`${session.id ?? "?"}\` · ` +
    `${iso(session.time?.created)} · ${bytes} B\n`;
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  // appendRegularFile keeps the archive index append-only and refuses to write
  // through a symlinked parent, matching how openclaw appends its own memory files.
  await appendRegularFile({ filePath: indexPath, content: line, rejectSymlinkParents: true });
}

/** Exposed for diagnostics: which project a workspace archives under. */
export { projectSlug };
