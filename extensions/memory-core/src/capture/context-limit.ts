// UTF-8 byte budgeting helpers ported verbatim from opencode-mem/src/utils/context-limit.ts.
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** UTF-8 byte length of a string. */
export function captureUtf8ByteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

/** Decode a UTF-8 byte slice without splitting multi-byte characters. */
export function sliceCaptureUtf8Bytes(text: string, start: number, end?: number): string {
  const bytes = encoder.encode(text);
  let from = Math.max(0, Math.min(start, bytes.length));
  let to = Math.min(bytes.length, end ?? bytes.length);
  if (to <= from) return "";

  // If `from` lands inside a multi-byte character, advance to the next lead byte.
  while (from < to && (bytes[from]! & 0xc0) === 0x80) {
    from++;
  }

  // If `to` lands inside a multi-byte character, back up to that character's start.
  while (to > from && (bytes[to]! & 0xc0) === 0x80) {
    to--;
  }

  return decoder.decode(bytes.subarray(from, to));
}

/**
 * Truncate text to at most `maxBytes` UTF-8 bytes.
 * Prefers keeping the start and end (head + tail) when space allows,
 * so summaries retain both opening context and closing conclusions.
 */
export function truncateCaptureToMaxBytes(
  text: string,
  maxBytes: number,
  marker = "\n[... truncated ...]\n",
): string {
  if (maxBytes <= 0) return "";
  if (captureUtf8ByteLength(text) <= maxBytes) return text;

  const markerBytes = captureUtf8ByteLength(marker);
  if (maxBytes <= markerBytes) {
    return sliceCaptureUtf8Bytes(text, 0, maxBytes);
  }

  const available = maxBytes - markerBytes;
  const headBytes = Math.floor(available / 2);
  const tailBytes = available - headBytes;
  const totalBytes = captureUtf8ByteLength(text);

  return (
    sliceCaptureUtf8Bytes(text, 0, headBytes) +
    marker +
    sliceCaptureUtf8Bytes(text, totalBytes - tailBytes)
  );
}
