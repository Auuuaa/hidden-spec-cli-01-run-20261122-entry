// mend — one patch tool for every AI edit format.
//
// Built from SPEC.md version 1 in the make.fun hidden-spec-cli-01-run-20261122
// kit. It reads a patch in one of four formats — unified diff, SEARCH/REPLACE
// blocks, the V4A patch format, or JSON text-editor tool calls — and applies
// every edit to the tree of text files in the working directory, or none of
// them when any edit fails. Lines are matched at the first of three tiers
// (exact, trailing whitespace ignored, surrounding whitespace ignored).
//
// Node 22, standard library only. Run as:
//   node main.ts [--format=NAME] [--check] [--strict] [PATCH]
// With MAKEFUN_ENV_URL set, this file hands the trial over to runner.ts.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'] as const;
type Format = (typeof FORMATS)[number];

// A parse fault: exit 2 with the single line `error: parse <N>`.
class ParseFault extends Error {
  readonly n: number;
  constructor(n: number) {
    super(`error: parse ${n}`);
    this.n = n;
  }
}

// One edit that failed: exit 1 with `error: <code> <path>`.
class EditFault extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`error: ${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

// A patch's lines: its text split at \n, one trailing \r removed from each
// line, without the empty piece after a final \n.
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

// A path is safe when it is not empty, does not start with /, holds no \,
// and none of its /-separated segments is empty, . or ...
function isSafe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// Byte order of UTF-8 paths, for the output rows.
function byteCmp(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// ---- A file as lines ----

interface Doc {
  br: string; // the file's line break: \r\n or \n
  lines: string[]; // the file's lines, without breaks
  ends: boolean; // the file ends with a line break
}

function parseDoc(text: string): Doc {
  if (text === '') return { br: '\n', lines: [], ends: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text.endsWith(br)) return { br, lines: text.slice(0, text.length - br.length).split(br), ends: true };
  return { br, lines: text.split(br), ends: false };
}

function docText(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.ends ? d.br : '');
}

// ---- The tree as the edits leave it ----

class Tree {
  private orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p) as string | null;
  }

  get(p: string): string | null {
    return this.now.has(p) ? (this.now.get(p) as string | null) : this.original(p);
  }
}

// ---- Matching lines at three tiers (SPEC.md section 5) ----

function tierNorm(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

// Every 0-based position where oldLines occur in file, at this tier.
function occurrences(file: string[], oldLines: string[], tier: number): number[] {
  const out: number[] = [];
  const n = oldLines.length;
  if (n === 0 || n > file.length) return out;
  const want = oldLines.map((l) => tierNorm(l, tier));
  for (let i = 0; i + n <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (tierNorm(file[i + j]!, tier) !== want[j]) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

function tiersToTry(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

// One line of N: a context line (written as the file's own matched line,
// ctx is its index in O) or an added line (ctx null, written as the patch
// wrote it, re-indented at tier 2).
interface NewPiece {
  text: string;
  ctx: number | null;
}

function buildNew(file: string[], pos: number, oldLines: string[], pieces: NewPiece[], tier: number): string[] {
  return pieces.map((pc) => {
    if (pc.ctx !== null) return file[pos + pc.ctx]!;
    if (tier === 2) {
      const f = leadWs(file[pos]!);
      const p = leadWs(oldLines[0]!);
      if (pc.text === '' || /^[ \t]+$/.test(pc.text)) return pc.text;
      if (pc.text.startsWith(p)) return f + pc.text.slice(p.length);
    }
    return pc.text;
  });
}

type Edit = (tree: Tree) => void;

// ---- Detecting the format (SPEC.md section 4) ----

function detectFormat(lines: string[]): Format | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- Unified diffs (SPEC.md section 6) ----

interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'mark';
  text: string;
  rawEmpty: boolean; // the patch line itself was empty (a context line with no text)
}

interface Hunk {
  a: number; // the old start line, 1-based, from the @@ header
  body: BodyLine[];
  noNl: boolean; // a \ line follows the hunk's last context or + line
  oldCount: number; // context + - lines
  newCount: number; // context + + lines
}

interface SecBuilder {
  hasPair: boolean;
  pairOld: string | null;
  pairNew: string | null;
  renOld: string | undefined;
  renNew: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  create: boolean;
  remove: boolean;
  startedHunks: boolean;
  hunks: Hunk[];
}

function freshSection(): SecBuilder {
  return {
    hasPair: false, pairOld: null, pairNew: null,
    renOld: undefined, renNew: undefined, diffOld: undefined, diffNew: undefined,
    create: false, remove: false, startedHunks: false, hunks: [],
  };
}

// The path after `--- ` or `+++ `: text after the four characters, up to
// the first tab, surrounding spaces removed; /dev/null means no file, and
// a leading a/ or b/ is removed.
function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  return p;
}

// Apply one hunk to a document. O is the hunk's context and - lines, N its
// context and + lines. Returns the document after the hunk.
function applyHunk(doc: Doc, hunk: Hunk, d: number, strict: boolean, path: string): Doc {
  const O: string[] = [];
  const N: NewPiece[] = [];
  for (const b of hunk.body) {
    if (b.kind === 'ctx') { O.push(b.text); N.push({ text: b.text, ctx: O.length - 1 }); }
    else if (b.kind === 'old') O.push(b.text);
    else if (b.kind === 'new') N.push({ text: b.text, ctx: null });
  }
  const lines = doc.lines;
  if (O.length > 0) {
    let tier = -1;
    let occ: number[] = [];
    for (const t of tiersToTry(strict)) {
      occ = occurrences(lines, O, t);
      if (occ.length > 0) { tier = t; break; }
    }
    if (tier < 0) throw new EditFault('no-match', path);
    const target = hunk.a - 1 + d;
    let pos = occ[0]!;
    for (const p of occ) {
      if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
    }
    const built = buildNew(lines, pos, O, N, tier);
    const out = [...lines.slice(0, pos), ...built, ...lines.slice(pos + O.length)];
    const ends = pos + O.length === lines.length ? !hunk.noNl : doc.ends;
    return { br: doc.br, lines: out, ends };
  }
  const pos = Math.min(hunk.a + d, lines.length);
  const built = buildNew(lines, pos, O, N, 0);
  const out = [...lines.slice(0, pos), ...built, ...lines.slice(pos)];
  const ends = pos === lines.length ? !hunk.noNl : doc.ends;
  return { br: doc.br, lines: out, ends };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let sec: SecBuilder | null = null;
  let hunk: Hunk | null = null;
  let body: BodyLine[] = [];

  const finishBody = (): void => {
    if (hunk === null) return;
    while (body.length > 0 && body[body.length - 1]!.rawEmpty) body.pop();
    let last = -1;
    for (let k = 0; k < body.length; k++) {
      if (body[k]!.kind === 'ctx' || body[k]!.kind === 'new') last = k;
    }
    hunk.noNl = last >= 0 && body[last + 1] !== undefined && body[last + 1]!.kind === 'mark';
    hunk.body = body;
    hunk.oldCount = body.filter((b) => b.kind === 'ctx' || b.kind === 'old').length;
    hunk.newCount = body.filter((b) => b.kind === 'ctx' || b.kind === 'new').length;
    if (sec !== null) sec.hunks.push(hunk);
    hunk = null;
    body = [];
  };

  const finalizeSection = (): void => {
    finishBody();
    if (sec === null) return;
    const s = sec;
    sec = null;
    const oldPath: string | null = s.hasPair ? s.pairOld
      : (s.renOld !== undefined ? s.renOld : (s.diffOld !== undefined ? s.diffOld : null));
    const newPath: string | null = s.hasPair ? s.pairNew
      : (s.renNew !== undefined ? s.renNew : (s.diffNew !== undefined ? s.diffNew : null));
    const isCreate = oldPath === null || s.create;
    const isDelete = !isCreate && (newPath === null || s.remove);
    const isMove = !isCreate && !isDelete && oldPath !== newPath;
    const hunks = s.hunks;
    if (isCreate) {
      const p = newPath as string;
      edits.push((tree) => {
        if (!isSafe(p)) throw new EditFault('unsafe', p);
        if (tree.get(p) !== null) throw new EditFault('exists', p);
        const plus: string[] = [];
        let noNl = false;
        for (const h of hunks) {
          for (let k = 0; k < h.body.length; k++) {
            const b = h.body[k]!;
            if (b.kind === 'new') {
              plus.push(b.text);
              noNl = h.body[k + 1] !== undefined && h.body[k + 1]!.kind === 'mark';
            }
          }
        }
        tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noNl ? '' : '\n'));
      });
      return;
    }
    if (isDelete) {
      const p = oldPath as string;
      edits.push((tree) => {
        if (!isSafe(p)) throw new EditFault('unsafe', p);
        if (tree.get(p) === null) throw new EditFault('missing', p);
        tree.now.set(p, null);
      });
      return;
    }
    if (isMove) {
      const oldP = oldPath as string;
      const newP = newPath as string;
      edits.push((tree) => {
        if (!isSafe(oldP)) throw new EditFault('unsafe', oldP);
        if (!isSafe(newP)) throw new EditFault('unsafe', newP);
        const cur = tree.get(oldP);
        if (cur === null) throw new EditFault('missing', oldP);
        if (tree.get(newP) !== null) throw new EditFault('exists', newP);
        let doc = parseDoc(cur);
        let d = 0;
        for (const h of hunks) {
          doc = applyHunk(doc, h, d, strict, oldP);
          d += h.newCount - h.oldCount;
        }
        tree.now.set(newP, docText(doc));
        tree.now.set(oldP, null);
        tree.moves.push([oldP, newP]);
      });
      return;
    }
    const p = oldPath as string;
    edits.push((tree) => {
      if (!isSafe(p)) throw new EditFault('unsafe', p);
      const cur = tree.get(p);
      if (cur === null) throw new EditFault('missing', p);
      let doc = parseDoc(cur);
      let d = 0;
      for (const h of hunks) {
        doc = applyHunk(doc, h, d, strict, p);
        d += h.newCount - h.oldCount;
      }
      tree.now.set(p, docText(doc));
    });
  };

  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (hunk !== null) {
      if (line.startsWith('diff --git ')) { finishBody(); continue; }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) { finishBody(); continue; }
      if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\') || line === '') {
        const kind: BodyLine['kind'] = line === '' ? 'ctx' : line[0] === ' ' ? 'ctx' : line[0] === '-' ? 'old' : line[0] === '+' ? 'new' : 'mark';
        body.push({ kind, text: line === '' ? '' : line.slice(1), rawEmpty: line === '' });
        i++;
        continue;
      }
      finishBody();
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m === null) throw new ParseFault(i + 1);
      finalizeSection();
      sec = freshSection();
      sec.diffOld = m[1];
      sec.diffNew = m[2];
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (sec === null || m === null) throw new ParseFault(i + 1);
      sec.startedHunks = true;
      hunk = { a: Number(m[1]), body: [], noNl: false, oldCount: 0, newCount: 0 };
      body = [];
      i++;
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1] ?? '';
      if (next.startsWith('+++ ')) {
        if (sec !== null && !sec.startedHunks && !sec.hasPair) {
          sec.pairOld = headerPath(line);
          sec.pairNew = headerPath(next);
          sec.hasPair = true;
          i += 2;
          continue;
        }
        finalizeSection();
        sec = freshSection();
        sec.pairOld = headerPath(line);
        sec.pairNew = headerPath(next);
        sec.hasPair = true;
        i += 2;
        continue;
      }
      if (sec !== null && !sec.startedHunks) throw new ParseFault(i + 2);
      i++;
      continue;
    }
    if (sec !== null && !sec.startedHunks) {
      if (line.startsWith('rename from ')) sec.renOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) sec.renNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) sec.create = true;
      else if (line.startsWith('deleted file mode')) sec.remove = true;
      i++;
      continue;
    }
    i++;
  }
  finalizeSection();
  return edits;
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!isSafe(path)) throw new EditFault('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new EditFault('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new EditFault('missing', path);
    const doc = parseDoc(cur);
    let tier = -1;
    let occ: number[] = [];
    for (const t of tiersToTry(strict)) {
      occ = occurrences(doc.lines, oldLines, t);
      if (occ.length > 0) { tier = t; break; }
    }
    if (tier < 0) throw new EditFault('no-match', path);
    if (occ.length > 1) throw new EditFault('ambiguous', path);
    const pos = occ[0]!;
    const pieces: NewPiece[] = newLines.map((text) => ({ text, ctx: null }));
    const built = buildNew(doc.lines, pos, oldLines, pieces, tier);
    const lines = [...doc.lines.slice(0, pos), ...built, ...doc.lines.slice(pos + oldLines.length)];
    tree.now.set(path, docText({ br: doc.br, lines, ends: doc.ends }));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i++; continue; }
    const s = i;
    let j = s + 1;
    while (j < lines.length && lines[j]!.trimEnd() !== '=======') j++;
    if (j >= lines.length) throw new ParseFault(s + 1);
    let k = j + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') k++;
    if (k >= lines.length) throw new ParseFault(s + 1);
    let path: string | null = null;
    for (let m = s - 1; m > prevReplace; m--) {
      const l = lines[m]!;
      if (isBlank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseFault(s + 1);
      path = prevPath;
    }
    edits.push(srEdit(path, lines.slice(s + 1, j), lines.slice(j + 1, k), strict));
    prevReplace = k;
    prevPath = path;
    i = k + 1;
  }
  return edits;
}

// ---- V4A patches (SPEC.md section 8) ----

interface V4AChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

function v4aAddEdit(path: string, addLines: string[]): Edit {
  return (tree) => {
    if (!isSafe(path)) throw new EditFault('unsafe', path);
    if (tree.get(path) !== null) throw new EditFault('exists', path);
    tree.now.set(path, addLines.length === 0 ? '' : addLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!isSafe(path)) throw new EditFault('unsafe', path);
    if (tree.get(path) === null) throw new EditFault('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4AChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!isSafe(path)) throw new EditFault('unsafe', path);
    if (moveTo !== null && !isSafe(moveTo)) throw new EditFault('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new EditFault('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new EditFault('exists', moveTo);
    let doc = parseDoc(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let found = -1;
        for (const t of tiersToTry(strict)) {
          found = -1;
          for (let k = cursor; k < doc.lines.length; k++) {
            if (tierNorm(doc.lines[k]!, t) === tierNorm(ch.anchor, t)) { found = k; break; }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new EditFault('no-match', path);
        cursor = found + 1;
      }
      const O: string[] = [];
      const N: NewPiece[] = [];
      for (const b of ch.body) {
        if (b.kind === 'ctx') { O.push(b.text); N.push({ text: b.text, ctx: O.length - 1 }); }
        else if (b.kind === 'old') O.push(b.text);
        else if (b.kind === 'new') N.push({ text: b.text, ctx: null });
      }
      if (O.length > 0) {
        let tier = -1;
        let occ: number[] = [];
        for (const t of tiersToTry(strict)) {
          const all = occurrences(doc.lines, O, t).filter((p) => p >= cursor);
          const eligible = ch.eof ? all.filter((p) => p + O.length === doc.lines.length) : all;
          if (eligible.length > 0) { tier = t; occ = eligible; break; }
        }
        if (tier < 0) throw new EditFault('no-match', path);
        const pos = occ[0]!;
        const built = buildNew(doc.lines, pos, O, N, tier);
        doc = { br: doc.br, lines: [...doc.lines.slice(0, pos), ...built, ...doc.lines.slice(pos + O.length)], ends: doc.ends };
        cursor = pos + built.length;
      } else {
        const pos = ch.eof ? doc.lines.length : cursor;
        const built = buildNew(doc.lines, pos, O, N, 0);
        doc = { br: doc.br, lines: [...doc.lines.slice(0, pos), ...built, ...doc.lines.slice(pos)], ends: doc.ends };
        cursor = pos + built.length;
      }
    }
    const text = docText(doc);
    if (moveTo !== null) {
      tree.now.set(moveTo, text);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, text);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault(1);
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseFault(first + 1);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!isBlank(lines[k]!)) { last = k; break; }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new ParseFault(lines.length + 1);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (isBlank(line)) { i++; continue; }
    if (!isSectionStart(line)) throw new ParseFault(i + 1);
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const addLines: string[] = [];
      i++;
      while (i < last && !isSectionStart(lines[i]!)) {
        const l = lines[i]!;
        if (l.startsWith('+')) addLines.push(l.slice(1));
        else if (l === '') addLines.push('');
        else throw new ParseFault(i + 1);
        i++;
      }
      while (addLines.length > 0 && addLines[addLines.length - 1] === '') addLines.pop();
      edits.push(v4aAddEdit(path, addLines));
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      i++;
      while (i < last && !isSectionStart(lines[i]!)) {
        if (!isBlank(lines[i]!)) throw new ParseFault(i + 1);
        i++;
      }
      edits.push(v4aDeleteEdit(path));
      continue;
    }
    const path = line.slice('*** Update File: '.length).trim();
    const updateLine = i + 1;
    let moveTo: string | null = null;
    const chunks: V4AChunk[] = [];
    let chunk: V4AChunk | null = null;
    let sawEofClose = false;
    i++;
    const closeChunk = (): void => {
      if (chunk !== null) { chunks.push(chunk); chunk = null; }
    };
    while (i < last && !isSectionStart(lines[i]!)) {
      const l = lines[i]!;
      if (l === '') {
        if (chunk !== null) chunk.body.push({ kind: 'ctx', text: '', rawEmpty: true });
        i++;
        continue;
      }
      if (l.startsWith('*** Move to: ')) {
        if (moveTo !== null || chunk !== null || chunks.length > 0) throw new ParseFault(i + 1);
        moveTo = l.slice('*** Move to: '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('@@')) {
        closeChunk();
        sawEofClose = false;
        const anchor = l.slice(2).trim();
        chunk = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
        i++;
        continue;
      }
      if (l === '*** End of File') {
        if (chunk === null) throw new ParseFault(i + 1);
        chunk.eof = true;
        closeChunk();
        sawEofClose = true;
        i++;
        continue;
      }
      if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
        if (chunk === null) {
          if (chunks.length > 0 || sawEofClose) throw new ParseFault(i + 1);
          chunk = { anchor: null, body: [], eof: false };
        }
        const kind: BodyLine['kind'] = l[0] === ' ' ? 'ctx' : l[0] === '-' ? 'old' : 'new';
        chunk.body.push({ kind, text: l.slice(1), rawEmpty: false });
        i++;
        continue;
      }
      if (isBlank(l)) { i++; continue; }
      throw new ParseFault(i + 1);
    }
    closeChunk();
    if (chunks.length > 0) {
      const lastChunk = chunks[chunks.length - 1]!;
      while (lastChunk.body.length > 0) {
        const b = lastChunk.body[lastChunk.body.length - 1]!;
        if (b.kind === 'ctx' && b.text === '') lastChunk.body.pop();
        else break;
      }
    }
    if (chunks.length === 0 && moveTo === null) throw new ParseFault(updateLine);
    edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
  }
  return edits;
}

// ---- JSON edits (SPEC.md section 9) ----

function jsonEditObject(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (tree) => {
      if (!isSafe(p)) throw new EditFault('unsafe', p);
      if (tree.get(p) !== null) throw new EditFault('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!isSafe(p)) throw new EditFault('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditFault('missing', p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count++;
      if (count === 0) throw new EditFault('no-match', p);
      if (count > 1) throw new EditFault('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const lineNo = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      if (!isSafe(p)) throw new EditFault('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditFault('missing', p);
      const doc = parseDoc(before);
      if (lineNo < 0 || lineNo > doc.lines.length) throw new EditFault('no-match', p);
      const lines = [...doc.lines];
      lines.splice(lineNo, 0, ...add);
      tree.now.set(p, docText({ br: doc.br, lines, ends: doc.ends }));
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault(1);
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseFault(first + 1);
    }
    if (!Array.isArray(v)) throw new ParseFault(first + 1);
    for (const x of v) {
      const e = jsonEditObject(x);
      if (e === null) throw new ParseFault(first + 1);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, idx) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEditObject(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseFault(idx + 1);
    edits.push(e);
  });
  return edits;
}

// ---- Running the CLI (SPEC.md sections 1, 2 and 10) ----

function run(args: string[]): { code: number; out: string[] } {
  let format: Format | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') { ended = true; continue; }
    if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        const v = a.slice('--format='.length);
        if (format !== null || !(FORMATS as readonly string[]).includes(v)) return { code: 2, out: ['error: usage'] };
        format = v as Format;
      } else if (a === '--check') {
        if (check) return { code: 2, out: ['error: usage'] };
        check = true;
      } else if (a === '--strict') {
        if (strict) return { code: 2, out: ['error: usage'] };
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
      continue;
    }
    pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const patchFile = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(patchFile ?? 0, 'utf8');
  } catch {
    if (patchFile !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind: Format | null = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new ParseFault(1);
  } catch (e) {
    if (e instanceof ParseFault) return { code: 2, out: [`error: parse ${e.n}`] };
    throw e;
  }
  const tree = new Tree();
  const fails: EditFault[] = [];
  for (const edit of edits) {
    const snapNow = new Map(tree.now);
    const snapMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditFault)) throw e;
      tree.now.clear();
      for (const [k, v] of snapNow) tree.now.set(k, v);
      tree.moves.length = snapMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  // Output rows: one per path whose state changed, in byte order of paths.
  // A successful move replaces its D and A lines with one R line, sorted by
  // the new path.
  const rPairs: Array<{ oldP: string; newP: string }> = [];
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null &&
      tree.original(newP) === null && tree.get(newP) !== null) {
      rPairs.push({ oldP, newP });
    }
  }
  const rOld = new Set(rPairs.map((r) => r.oldP));
  const rNew = new Set(rPairs.map((r) => r.newP));
  const rows: Array<{ key: string; line: string }> = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const cur = tree.now.get(p) as string | null;
    if (was === cur) continue;
    if (rOld.has(p) || rNew.has(p)) continue;
    if (was === null) rows.push({ key: p, line: `A ${p}` });
    else if (cur === null) rows.push({ key: p, line: `D ${p}` });
    else rows.push({ key: p, line: `M ${p}` });
  }
  for (const r of rPairs) rows.push({ key: r.newP, line: `R ${r.oldP} -> ${r.newP}` });
  rows.sort((a, b) => byteCmp(a.key, b.key));
  if (!check) {
    const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== (tree.now.get(p) as string | null));
    for (const p of changed) {
      if ((tree.now.get(p) as string | null) === null) rmSync(p, { force: true });
    }
    for (const p of changed) {
      const cur = tree.now.get(p) as string | null;
      if (cur === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, cur);
    }
  }
  const outLines = rows.map((r) => r.line);
  outLines.push(`ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`);
  return { code: 0, out: outLines };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this
  // file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
