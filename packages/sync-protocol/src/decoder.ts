import { canonicalStringify } from './canonical';
import { assertCommitEnvelope } from './validation';

export const transportLimits = {
  controlBytes: 65536,
  commitBytes: 1048576,
  pageBytes: 4194304,
  depth: 32,
  operations: 100,
  parents: 32,
  pageCommits: 100,
  activeDevices: 10,
} as const;

/** Strict UTF-8, including overlong encodings, surrogate scalars and BOM rejection. Portable to Hermes. */
export function decodeUtf8(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length;) {
    const first = bytes[i++];
    let cp = first,
      remaining = 0,
      minimum = 0;
    if (first >= 0xc2 && first <= 0xdf) {
      cp = first & 31;
      remaining = 1;
      minimum = 0x80;
    } else if (first >= 0xe0 && first <= 0xef) {
      cp = first & 15;
      remaining = 2;
      minimum = 0x800;
    } else if (first >= 0xf0 && first <= 0xf4) {
      cp = first & 7;
      remaining = 3;
      minimum = 0x10000;
    } else if (first > 0x7f) throw new Error('Invalid UTF-8.');
    while (remaining--) {
      const next = bytes[i++];
      if (next === undefined || (next & 0xc0) !== 0x80)
        throw new Error('Invalid UTF-8.');
      cp = (cp << 6) | (next & 63);
    }
    if (
      cp < minimum ||
      cp > 0x10ffff ||
      (cp >= 0xd800 && cp <= 0xdfff) ||
      (chunks.length === 0 && cp === 0xfeff)
    )
      throw new Error('Invalid UTF-8 scalar or BOM.');
    chunks.push(String.fromCodePoint(cp));
  }
  return chunks.join('');
}

/** UTF-8 encoder without TextEncoder/WASM; Hermes and Node produce the same scalar bytes. */
export function encodeUtf8(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const scalar of text) {
    const cp = scalar.codePointAt(0) as number;
    if (cp >= 0xd800 && cp <= 0xdfff)
      throw new Error('Invalid Unicode scalar.');
    if (cp < 0x80) bytes.push(cp);
    else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000)
      bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 63),
        0x80 | ((cp >> 6) & 63),
        0x80 | (cp & 63),
      );
  }
  return new Uint8Array(bytes);
}

/** Lex before JSON.parse: quotas and duplicate names (including escaped aliases) cannot be lost. */
export function decodeCanonical(
  bytes: Uint8Array,
  maxBytes: number = transportLimits.controlBytes,
  maxNodes = 20000,
): unknown {
  if (bytes.length > maxBytes) throw new Error('payload_too_large');
  const text = decodeUtf8(bytes);
  let pos = 0,
    nodes = 0;
  const fail = (): never => {
    throw new Error('invalid_envelope');
  };
  const string = (): string => {
    const start = pos;
    if (text[pos++] !== '"') return fail();
    while (pos < text.length) {
      const c = text[pos++];
      if (c === '"') {
        try {
          return JSON.parse(text.slice(start, pos)) as string;
        } catch {
          return fail();
        }
      }
      if (c.charCodeAt(0) < 32) return fail();
      if (c === '\\') {
        const escape = text[pos++];
        if (escape === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(pos, pos + 4))) return fail();
          pos += 4;
        } else if (!escape || !'"\\/bfnrt'.includes(escape)) return fail();
      }
    }
    return fail();
  };
  const visit = (depth: number): void => {
    if (depth > transportLimits.depth || ++nodes > maxNodes) return fail();
    const c = text[pos];
    if (c === '"') {
      string();
      return;
    }
    if (c === '{' || c === '[') {
      pos++;
      const end = c === '{' ? '}' : ']',
        names = new Set<string>();
      if (text[pos] === end) {
        pos++;
        return;
      }
      while (pos < text.length) {
        if (c === '{') {
          const name = string();
          if (names.has(name)) return fail();
          names.add(name);
          if (text[pos++] !== ':') return fail();
        }
        visit(depth + 1);
        if (text[pos] === end) {
          pos++;
          return;
        }
        if (text[pos++] !== ',') return fail();
      }
      return fail();
    }
    const token = /^(?:null|true|false|-?(?:0|[1-9][0-9]*))/.exec(
      text.slice(pos),
    );
    if (!token) return fail();
    pos += token[0].length;
  };
  visit(1);
  if (pos !== text.length) return fail();
  const value: unknown = JSON.parse(text);
  if (canonicalStringify(value) !== text) return fail();
  return value;
}

export function decodeCommit(bytes: Uint8Array) {
  const value = decodeCanonical(bytes, transportLimits.commitBytes);
  assertCommitEnvelope(value);
  if (
    value.operations.length > transportLimits.operations ||
    value.operations.some((op) => op.parents.length > transportLimits.parents)
  )
    throw new Error('payload_too_large');
  return value;
}
