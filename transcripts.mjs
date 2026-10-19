#!/usr/bin/env node
// Claude Code transcript viewer.
// Every Claude Code session is saved as a .jsonl file on your laptop
// (one JSON object per line). This little server lets you browse them.
//
// Run:   node transcripts.mjs          (opens http://127.0.0.1:4321)
//        node transcripts.mjs 5000     (pick another port)
//
// Read-only. Uses only built-in Node modules. Listens on 127.0.0.1 only,
// so nobody else on the network can see it. Sends nothing anywhere.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const ROOT = path.resolve(CONFIG_DIR, 'projects');
const START_PORT = Number(process.argv[2]) || 4321;
const PAGE_SIZE = 400;          // entries per session page
const PREVIEW_CHARS = 1500;     // tool result / tool input shown before "show all"
const FULL_CAP = 60000;         // max characters shown even after "show all"
const RAW_CAP = 300000;         // max characters of raw JSON shown

// ---------- helpers ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function insideRoot(p) {
  const r = path.resolve(p);
  return r === ROOT || r.startsWith(ROOT + path.sep);
}

function safeFile(rel) {
  if (!rel) return null;
  const full = path.resolve(ROOT, rel);
  if (!insideRoot(full) || !full.endsWith('.jsonl')) return null;
  try { if (!fs.statSync(full).isFile()) return null; } catch { return null; }
  return full;
}

const relOf = (full) => path.relative(ROOT, full).split(path.sep).join('/');

function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  if (isNaN(d)) return '';
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function countLines(file) {
  let n = 0, last = 10;
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.allocUnsafe(1 << 20);
  try {
    let r;
    while ((r = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      let i = -1;
      while ((i = buf.indexOf(10, i + 1)) !== -1 && i < r) n++;
      last = buf[r - 1];
    }
  } finally { fs.closeSync(fd); }
  if (last !== 10) n++; // final line without a newline
  return n;
}

function readHead(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(bytes);
    const r = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, r).toString('utf8');
  } finally { fs.closeSync(fd); }
}

// Text the person actually typed (not tool results, not automatic messages).
function userTypedText(o) {
  if (o.type !== 'user' || o.isMeta || !o.message) return null;
  const c = o.message.content;
  let t = null;
  if (typeof c === 'string') t = c;
  else if (Array.isArray(c)) {
    if (c.some((b) => b.type === 'tool_result')) return null;
    t = c.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  }
  if (!t) return null;
  const cmd = t.match(/<command-name>([^<]*)<\/command-name>/);
  if (cmd) {
    const args = (t.match(/<command-args>([\s\S]*?)<\/command-args>/) || [])[1] || '';
    return (cmd[1] + ' ' + args).trim();
  }
  if (/^\s*<(local-command|task-notification|bash-stdout|system-reminder|scheduled-task)/.test(t)) return null;
  return t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim() || null;
}

// ---------- scanning the projects folder ----------

const infoCache = new Map(); // file -> { key, info }

function sessionInfo(file) {
  const st = fs.statSync(file);
  const key = st.size + ':' + st.mtimeMs;
  const hit = infoCache.get(file);
  if (hit && hit.key === key) return hit.info;
  const info = { file, size: st.size, mtime: st.mtimeMs, lines: 0, firstPrompt: '', cwd: '', title: '' };
  if (st.size > 0) {
    info.lines = countLines(file);
    for (const bytes of [512 * 1024, 4 * 1024 * 1024]) {
      const text = readHead(file, Math.min(bytes, st.size));
      const lines = text.split('\n');
      if (bytes < st.size) lines.pop();
      for (const l of lines) {
        if (!l.trim()) continue;
        let o; try { o = JSON.parse(l); } catch { continue; }
        if (!info.cwd && o.cwd) info.cwd = o.cwd;
        if (!info.title && o.type === 'summary' && o.summary) info.title = o.summary;
        if (!info.firstPrompt) { const t = userTypedText(o); if (t) info.firstPrompt = t; }
        if (info.cwd && info.firstPrompt) break;
      }
      if (info.firstPrompt || bytes >= st.size) break;
    }
  }
  const dir = file.slice(0, -'.jsonl'.length);
  info.subagents = 0;
  try { info.subagents = fs.readdirSync(path.join(dir, 'subagents')).filter((f) => f.endsWith('.jsonl')).length; } catch {}
  infoCache.set(file, { key, info });
  return info;
}

// Folder names are the project path with every / \ : . (and so on) replaced by "-".
// That can't be undone exactly, so we prefer the "cwd" saved inside the files.
function guessPath(folder) {
  if (/^[A-Za-z]--/.test(folder)) return folder[0] + ':\\' + folder.slice(3).replace(/-/g, '\\');
  return folder.replace(/-/g, '/');
}

function listProjects() {
  let dirs = [];
  try { dirs = fs.readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return null; }
  const projects = [];
  for (const d of dirs) {
    const pdir = path.join(ROOT, d.name);
    let files = [];
    try { files = fs.readdirSync(pdir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    const sessions = [];
    for (const f of files) {
      try { sessions.push(sessionInfo(path.join(pdir, f))); } catch {}
    }
    if (!sessions.length) continue;
    sessions.sort((a, b) => b.mtime - a.mtime);
    const cwd = sessions.find((s) => s.cwd)?.cwd;
    projects.push({ folder: d.name, dir: pdir, path: cwd || guessPath(d.name), sessions, newest: sessions[0].mtime });
  }
  projects.sort((a, b) => b.newest - a.newest);
  return projects;
}

// ---------- reading one session ----------

function readEntries(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const entries = [];
  lines.forEach((raw, i) => {
    if (!raw.trim()) return;
    let o = null, bad = false;
    try { o = JSON.parse(raw); } catch { bad = true; }
    entries.push({ line: i + 1, o: o || {}, bad, rawLen: raw.length });
  });
  return entries;
}

function subagentFiles(sessionFile) {
  const dir = path.join(sessionFile.slice(0, -'.jsonl'.length), 'subagents');
  const out = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(dir, f);
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(full.replace(/\.jsonl$/, '.meta.json'), 'utf8')); } catch {}
      out.push({ full, meta });
    }
  } catch {}
  return out;
}

function sessionExtras(sessionFile) {
  const dir = sessionFile.slice(0, -'.jsonl'.length);
  const out = [];
  try {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      let n = 0;
      if (d.isDirectory()) { try { n = fs.readdirSync(path.join(dir, d.name)).length; } catch {} }
      out.push({ name: d.name + (d.isDirectory() ? '/' : ''), n });
    }
  } catch {}
  return { dir, items: out };
}

// Plain-English notes for the housekeeping lines.
const HOUSEKEEPING = {
  'file-history-snapshot': 'Backup of the files Claude changed, so you can rewind.',
  'file-history-delta': 'Backup of one file change, so you can rewind.',
  'summary': 'A short summary of the conversation.',
  'ai-title': 'The title shown in the session list.',
  'custom-title': 'A title you gave this session.',
  'agent-name': 'The name of this agent.',
  'last-prompt': 'Bookmark of your last message. Used when you resume.',
  'permission-mode': 'Which permission mode was on.',
  'mode': 'Which mode Claude Code was in.',
  'attachment': 'Extra context Claude Code added for Claude (hook output, reminders, file info).',
  'queue-operation': 'A message you typed while Claude was still busy.',
  'cost-state': 'Running totals: time, cost and lines changed.',
  'atis-latch': 'Internal Claude Code setting.',
  'pr-link': 'A pull request linked to this session.',
  'worktree-state': 'Which git worktree this session uses.',
  'relocated': 'The session moved to another folder.',
  'continued-in': 'This conversation continues in another file.',
  'system': 'A note from Claude Code itself, not from you or Claude.',
  'api-request': 'One call to the model: the settings sent and which pieces made up the context this turn.',
  'api-request-blob': 'One piece of the context sent to the model, saved once and reused by later calls.',
  'api-request-shape': 'The system prompt and tool list sent to the model, saved once.',
};

// Three or more grey lines in a row fold into one row you can open.
const FOLD_MIN = 3;

function truncBlock(text, cls) {
  text = String(text ?? '');
  if (text.length <= PREVIEW_CHARS) return `<pre class="${cls}">${esc(text)}</pre>`;
  const shown = text.slice(0, FULL_CAP);
  const more = text.length > FULL_CAP ? `<p class="note">Cut at ${FULL_CAP.toLocaleString()} characters. Use "Show raw JSON" to see everything.</p>` : '';
  return `<pre class="${cls}">${esc(text.slice(0, PREVIEW_CHARS))}<span class="fade">…</span></pre>
<details class="more"><summary>Show all (${text.length.toLocaleString()} characters)</summary><pre class="${cls}">${esc(shown)}</pre>${more}</details>`;
}

function renderToolResultContent(c) {
  if (typeof c === 'string') return truncBlock(c, 'out');
  if (!Array.isArray(c)) return truncBlock(JSON.stringify(c, null, 2), 'out');
  return c.map((b) => {
    if (b.type === 'text') return truncBlock(b.text, 'out');
    if (b.type === 'image') return `<p class="note">[An image, ${fmtSize((b.source?.data || '').length * 0.75)}]</p>`;
    if (b.type === 'tool_reference') return `<p class="note">[Tool loaded: ${esc(b.tool_name || b.name || '')}]</p>`;
    return truncBlock(JSON.stringify(b, null, 2), 'out');
  }).join('');
}

function renderBlock(b, ctx) {
  switch (b.type) {
    case 'text':
      return { kind: ctx.role === 'assistant' ? 'claude' : 'you', html: `<div class="text">${esc(b.text)}</div>` };
    case 'thinking': {
      const t = b.thinking || '';
      if (!t.trim()) {
        return { kind: 'thinking', html: `<p class="note">Claude thought here, but the thinking text is not saved in the file. Only an encrypted signature is kept${b.signature ? ` (${b.signature.length.toLocaleString()} characters)` : ''}.</p>` };
      }
      return { kind: 'thinking', html: `<details class="think"><summary>Show thinking (${t.length.toLocaleString()} characters)</summary><div class="text">${esc(t)}</div></details>` };
    }
    case 'redacted_thinking':
      return { kind: 'thinking', html: `<p class="note">Claude thought here, but the thinking was redacted (stored encrypted).</p>` };
    case 'tool_use': {
      const sub = ctx.subByTool.get(b.id);
      const link = sub ? `<p class="sublink">This started a sub-agent. <a href="/session?f=${encodeURIComponent(relOf(sub))}">Open its transcript</a></p>` : '';
      return { kind: 'call', tool: b.name, html: `<div class="toolname">${esc(b.name)}</div>${truncBlock(JSON.stringify(b.input, null, 2), 'json')}${link}` };
    }
    case 'tool_result': {
      const name = ctx.toolNames.get(b.tool_use_id);
      return { kind: b.is_error ? 'error' : 'result', tool: name, html: renderToolResultContent(b.content) };
    }
    case 'image':
      return { kind: ctx.role === 'assistant' ? 'claude' : 'you', html: `<p class="note">[An image was pasted here]</p>` };
    default:
      return { kind: 'other', html: truncBlock(JSON.stringify(b, null, 2), 'json') };
  }
}

const LABELS = {
  you: 'You', claude: 'Claude', thinking: 'Thinking', call: 'Tool call', result: 'Tool result',
  error: 'Tool result (error)', other: 'System / other', auto: 'Added automatically',
};

function renderSession(file, page) {
  const entries = readEntries(file);
  const isSub = relOf(file).includes('/subagents/');

  // Indexes over the whole file.
  const byUuid = new Map();
  const toolNames = new Map();
  const children = new Map();
  let cwd = '', sessionId = '';
  for (const e of entries) {
    const o = e.o;
    if (o.uuid) byUuid.set(o.uuid, e);
    if (!cwd && o.cwd) cwd = o.cwd;
    if (!sessionId && o.sessionId) sessionId = o.sessionId;
    const c = o.message?.content;
    if (Array.isArray(c)) for (const b of c) if (b.type === 'tool_use') toolNames.set(b.id, b.name);
  }
  // A real fork: one entry with two or more conversation lines hanging off it.
  // (Tool results and automatic lines also point back, so they don't count.)
  const isConversational = (o) => (o.type === 'user' && userTypedText(o) !== null) || (o.type === 'assistant');
  for (const e of entries) {
    const p = e.o.parentUuid;
    if (!p || !e.o.uuid) continue;
    if (!children.has(p)) children.set(p, []);
    children.get(p).push(e);
  }
  const forkParents = new Set();
  for (const [p, kids] of children) {
    if (kids.filter((k) => isConversational(k.o)).length >= 2) forkParents.add(p);
  }

  const subs = isSub ? [] : subagentFiles(file);
  const subByTool = new Map(subs.filter((s) => s.meta.toolUseId).map((s) => [s.meta.toolUseId, s.full]));
  const ctx = { toolNames, subByTool, role: '' };

  const pages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  page = Math.min(Math.max(1, page || 1), pages);
  const start = (page - 1) * PAGE_SIZE;
  const slice = entries.slice(start, start + PAGE_SIZE);
  const rel = relOf(file);
  const idxOfLine = new Map(entries.map((x, i) => [x.line, i]));
  const lineHref = (line) => {
    const idx = idxOfLine.get(line);
    const pg = Math.floor(idx / PAGE_SIZE) + 1;
    return (pg === page ? '' : `/session?f=${encodeURIComponent(rel)}&page=${pg}`) + `#L${line}`;
  };

  let prevUuid = start > 0 ? [...entries.slice(0, start)].reverse().find((x) => x.o.uuid)?.o.uuid : undefined;
  const cards = [];
  for (const e of slice) {
    const o = e.o;
    ctx.role = o.type;
    let blocks = [];
    let kind = 'other';
    let note = '';

    if (e.bad) {
      note = 'This line is not valid JSON (maybe still being written).';
    } else if ((o.type === 'user' || o.type === 'assistant') && o.message) {
      const c = o.message.content;
      if (typeof c === 'string') {
        if (o.isMeta) { kind = 'auto'; blocks = [{ kind: 'auto', html: truncBlock(c, 'out') }]; note = 'Added by Claude Code, not typed by you.'; }
        else if (/^\s*<(task-notification|local-command|bash-stdout|scheduled-task|system-reminder)/.test(c)) { kind = 'auto'; blocks = [{ kind: 'auto', html: truncBlock(c, 'out') }]; note = 'Added by Claude Code, not typed by you.'; }
        else { kind = o.type === 'assistant' ? 'claude' : 'you'; blocks = [{ kind, html: `<div class="text">${esc(c)}</div>` }]; }
      } else if (Array.isArray(c)) {
        blocks = c.map((b) => renderBlock(b, ctx));
        if (o.isMeta) { blocks.forEach((b) => { if (b.kind === 'you') b.kind = 'auto'; }); note = 'Added by Claude Code, not typed by you.'; }
        kind = blocks[0]?.kind || 'other';
      }
      if (o.isApiErrorMessage || o.error) note = 'This message is an error from the Claude service.';
    } else {
      kind = 'other';
      const t = o.type || 'unknown';
      note = HOUSEKEEPING[t] || 'A housekeeping line Claude Code uses for itself.';
      let detail = '';
      if (o.subtype) detail = o.subtype.replace(/_/g, ' ');
      if (o.attachment?.type) detail = o.attachment.type.replace(/_/g, ' ');
      if (o.summary) detail = o.summary;
      if (o.aiTitle) detail = o.aiTitle;
      if (o.customTitle) detail = o.customTitle;
      if (o.subtype === 'compact_boundary') note = 'The conversation was compacted here. Older messages were replaced by a summary to save space.';
      if (typeof o.content === 'string' && o.type === 'system') detail += (detail ? ': ' : '') + o.content.slice(0, 300);
      if (detail) blocks = [{ kind: 'other', html: `<div class="detail">${esc(detail)}</div>` }];
    }

    // Parent links and forks.
    let chain = '';
    let flags = '';
    if (o.uuid) {
      const parent = o.parentUuid ? byUuid.get(o.parentUuid) : null;
      const short = (u) => esc(String(u).slice(0, 8));
      chain = `<span class="ids">uuid ${short(o.uuid)} → parent ${o.parentUuid ? (parent ? `<a href="${lineHref(parent.line)}">${short(o.parentUuid)} (line ${parent.line})</a>` : `${short(o.parentUuid)} (not in this file)`) : 'none (start of the conversation)'}</span>`;
      if (o.logicalParentUuid) chain += ` <span class="ids">logical parent ${short(o.logicalParentUuid)}</span>`;
      const isToolResult = Array.isArray(o.message?.content) && o.message.content.some((b) => b.type === 'tool_result');
      if (forkParents.has(o.uuid)) {
        const n = children.get(o.uuid).filter((k) => isConversational(k.o)).length;
        flags += `<span class="flag fork">Branch point: ${n} paths continue from here</span>`;
      }
      if (o.parentUuid && prevUuid && o.parentUuid !== prevUuid) {
        if (forkParents.has(o.parentUuid) && isConversational(o)) flags += `<span class="flag fork">Fork: continues from line ${parent?.line ?? '?'}, not the entry above</span>`;
        else if (isToolResult) flags += `<span class="flag soft">Answers the tool call on line ${parent?.line ?? '?'}</span>`;
        else if (parent) flags += `<span class="flag soft">Parent is line ${parent.line}, not the entry above</span>`;
      }
      prevUuid = o.uuid;
    }
    if (o.isSidechain) flags += `<span class="flag side">Sub-agent</span>`;

    const labelHtml = blocks.length
      ? blocks.map((b) => `<div class="block k-${b.kind}"><span class="label">${LABELS[b.kind] || 'Other'}${b.tool ? `: ${esc(b.tool)}` : ''}</span>${b.html}</div>`).join('')
      : `<div class="block k-${kind}"><span class="label">${LABELS[kind]}</span></div>`;

    const when = o.timestamp ? `<span class="when">${esc(fmtDate(Date.parse(o.timestamp)))}</span>` : '';
    cards.push({ line: e.line, type: o.type || '?', grey: kind === 'other', html: `<article id="L${e.line}" class="card c-${kind}${o.isSidechain ? ' sidechain' : ''}${kind === 'other' || kind === 'auto' ? ' housekeeping' : ''}">
<header><a class="lineno" href="#L${e.line}">Line ${e.line}</a><span class="type">type: ${esc(o.type || '?')}</span>${when}${flags}</header>
${note ? `<p class="note">${esc(note)}</p>` : ''}
${labelHtml}
<footer>${chain}<details class="raw" data-line="${e.line}"><summary>Show raw JSON</summary><pre class="rawpre">Loading…</pre></details></footer>
</article>` });
  }

  // Fold runs of grey lines: "12 housekeeping lines (lines 40–51): 6 api-request, 6 api-request-blob".
  const folded = [];
  for (let i = 0; i < cards.length;) {
    let j = i;
    while (j < cards.length && cards[j].grey) j++;
    if (j - i >= FOLD_MIN) {
      const run = cards.slice(i, j);
      const counts = new Map();
      for (const c of run) counts.set(c.type, (counts.get(c.type) || 0) + 1);
      const what = [...counts].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${esc(k)}`).join(', ');
      folded.push(`<details class="hkrun"><summary>${run.length} housekeeping lines in a row (lines ${run[0].line}–${run[run.length - 1].line}): ${what}</summary>${run.map((c) => c.html).join('\n')}</details>`);
      i = j;
    } else if (j > i) { folded.push(...cards.slice(i, j).map((c) => c.html)); i = j; }
    else { folded.push(cards[i].html); i++; }
  }

  const pager = pages > 1 ? `<nav class="pager">Page ${page} of ${pages} (${PAGE_SIZE} lines per page): ${Array.from({ length: pages }, (_, i) => i + 1 === page ? `<b>${i + 1}</b>` : `<a href="/session?f=${encodeURIComponent(rel)}&page=${i + 1}">${i + 1}</a>`).join(' ')}</nav>` : '';

  const extras = isSub ? null : sessionExtras(file);
  const subList = subs.length ? `<section class="subs"><h2>Sub-agents in this session</h2><p>Each sub-agent gets its own file, next to this one.</p><ul>${subs.map((s) => `<li><a href="/session?f=${encodeURIComponent(relOf(s.full))}">${esc(s.meta.description || path.basename(s.full))}</a> <span class="muted">${esc(s.meta.agentType || '')}</span><br><code>${esc(s.full)}</code></li>`).join('')}</ul></section>` : '';
  const extraList = extras && extras.items.length ? `<p class="muted">This session also has a folder: <code>${esc(extras.dir)}</code> (${extras.items.map((i) => esc(i.name) + (i.n ? ` ${i.n} files` : '')).join(', ')}).</p>` : '';

  let parentLink = '';
  if (isSub) {
    const parentFile = path.resolve(file, '..', '..') + '.jsonl';
    if (fs.existsSync(parentFile)) parentLink = `<p>This is a sub-agent. Claude started it from the main session. <a href="/session?f=${encodeURIComponent(relOf(parentFile))}">Back to the main session</a></p>`;
  }

  const q = (s) => (/[\s"'&;]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
  const resume = sessionId
    ? (isSub
      ? `<p>Sub-agents are not resumed on their own. Resume the main session instead: <code>cd ${esc(q(cwd || '.'))} &amp;&amp; claude --resume ${esc(sessionId)}</code></p>`
      : `<p>To continue this conversation: <code>cd ${esc(q(cwd || '.'))} &amp;&amp; claude --resume ${esc(sessionId)}</code></p>
<p class="muted"><code>claude --resume</code> reads this same file back in and carries on from the last line. (Older Windows PowerShell: use <code>;</code> instead of <code>&amp;&amp;</code>.)</p>`)
    : '';

  const body = `
<p><a href="/">← All projects</a></p>
<h1>${isSub ? 'Sub-agent transcript' : 'Session transcript'}</h1>
<p class="filepath">${esc(file)}</p>
<p class="muted">${entries.length.toLocaleString()} lines · ${fmtSize(fs.statSync(file).size)}${cwd ? ` · started in <code>${esc(cwd)}</code>` : ''}</p>
${parentLink}
${LEGEND}
${subList}
${extraList}
<p class="controls"><label><input type="checkbox" id="hidehk"> Hide housekeeping lines (grey ones)</label></p>
${pager}
<main class="cards">${folded.join('\n')}</main>
${pager}
<footer class="resume">${resume}</footer>
<script>
const FILE = ${JSON.stringify(rel).replace(/</g, '\\u003c')};
document.querySelectorAll('details.raw').forEach((d) => d.addEventListener('toggle', async () => {
  if (!d.open || d.dataset.loaded) return;
  d.dataset.loaded = '1';
  const pre = d.querySelector('pre');
  try {
    const r = await fetch('/raw?f=' + encodeURIComponent(FILE) + '&line=' + d.dataset.line);
    const t = await r.text();
    pre.textContent = t;
    const btn = document.createElement('button');
    btn.textContent = 'Spread out (easier to read)';
    btn.onclick = () => { try { pre.textContent = JSON.stringify(JSON.parse(t), null, 2); btn.remove(); } catch { btn.textContent = 'Could not spread out'; } };
    d.appendChild(btn);
  } catch (e) { pre.textContent = 'Could not load: ' + e; }
}));
const hk = document.getElementById('hidehk');
hk.checked = localStorage.getItem('hidehk') === '1';
const apply = () => { document.body.classList.toggle('hidehk', hk.checked); localStorage.setItem('hidehk', hk.checked ? '1' : '0'); };
hk.addEventListener('change', apply); apply();
// A link to a line inside a folded run opens the run.
const openTarget = () => { const el = location.hash && document.getElementById(location.hash.slice(1)); const run = el && el.closest('details.hkrun'); if (run) { run.open = true; el.scrollIntoView(); } };
window.addEventListener('hashchange', openTarget); openTarget();
</script>`;
  return layout(isSub ? 'Sub-agent transcript' : 'Session transcript', body);
}

const LEGEND = `<section class="legend">
<h2>How to read this</h2>
<p>This file has one line per event. Each card below is one line. They are in the same order as the file.</p>
<ul>
<li><span class="chip k-you">You</span> Something you typed.</li>
<li><span class="chip k-claude">Claude</span> Claude's written reply to you.</li>
<li><span class="chip k-thinking">Thinking</span> Claude thinking before it answers. Click to open it. Sometimes only a locked copy is saved, so there is no text to show.</li>
<li><span class="chip k-call">Tool call</span> Claude asks Claude Code to do something: run a command, read or edit a file, search.</li>
<li><span class="chip k-result">Tool result</span> What came back from that tool. Claude reads this next. <span class="chip k-error">Error</span> means the tool failed.</li>
<li><span class="chip k-auto">Added automatically</span> Text Claude Code slipped in for Claude, not typed by you.</li>
<li><span class="chip k-other">System / other</span> Housekeeping lines: backups, titles, settings.</li>
<li><span class="chip side">Sub-agent</span> Work done by a helper Claude that the main Claude started.</li>
</ul>
<p>Every line has an id (uuid) and points to the line before it (parentUuid). That is how the conversation is chained together. If you rewind or edit a message, the new line points back to an older one. That makes a <span class="chip fork">Branch point</span>: two paths from the same place.</p>
</section>`;

function renderHome() {
  const projects = listProjects();
  if (!projects) {
    return layout('Claude Code transcripts', `<h1>Claude Code transcripts</h1><p>No transcripts folder found at <code>${esc(ROOT)}</code>.</p><p>Run Claude Code once, then reload this page. If you moved your Claude folder, set <code>CLAUDE_CONFIG_DIR</code>.</p>`);
  }
  const total = projects.reduce((n, p) => n + p.sessions.length, 0);
  const sections = projects.map((p, i) => {
    const rows = p.sessions.map((s) => {
      const rel = relOf(s.file);
      const prompt = s.firstPrompt ? (s.firstPrompt.length > 160 ? s.firstPrompt.slice(0, 160) + '…' : s.firstPrompt) : (s.size ? '(no typed message found)' : '(empty file)');
      return `<li class="session">
<a class="prompt" href="/session?f=${encodeURIComponent(rel)}">${esc(prompt)}</a>
<div class="meta">${esc(fmtDate(s.mtime))} · ${s.lines.toLocaleString()} lines · ${fmtSize(s.size)}${s.subagents ? ` · ${s.subagents} sub-agent${s.subagents > 1 ? 's' : ''}` : ''}</div>
<code class="path">${esc(s.file)}</code></li>`;
    }).join('');
    return `<details class="project"${i < 3 ? ' open' : ''}><summary><span class="ppath">${esc(p.path)}</span> <span class="muted">${p.sessions.length} session${p.sessions.length > 1 ? 's' : ''} · last used ${esc(fmtDate(p.newest))}</span></summary>
<p class="muted">Folder: <code>${esc(p.dir)}</code></p><ul class="sessions">${rows}</ul></details>`;
  }).join('\n');
  const body = `<h1>Claude Code transcripts</h1>
<p class="lead">Every Claude Code session is saved as a file on your laptop. Here they are.</p>
<p class="muted">Reading from <code>${esc(ROOT)}</code> · ${projects.length} projects · ${total} sessions. Each project folder is named after the folder you ran Claude in. Newest first.</p>
<p class="controls"><input id="filter" type="search" placeholder="Filter projects and prompts"></p>
${sections}
<script>
const f = document.getElementById('filter');
f.addEventListener('input', () => {
  const q = f.value.toLowerCase();
  document.querySelectorAll('details.project').forEach((d) => {
    let any = false;
    d.querySelectorAll('li.session').forEach((li) => { const m = !q || li.textContent.toLowerCase().includes(q) || d.querySelector('summary').textContent.toLowerCase().includes(q); li.style.display = m ? '' : 'none'; any = any || m; });
    d.style.display = any ? '' : 'none';
    if (q && any) d.open = true;
  });
});
</script>`;
  return layout('Claude Code transcripts', body);
}

function layout(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light"><title>${esc(title)}</title><link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 18 18'%3E%3Crect width='8' height='8' rx='2.5' fill='%23d97706'/%3E%3Crect x='10' width='8' height='8' rx='2.5' fill='%231c1917'/%3E%3Crect y='10' width='8' height='8' rx='2.5' fill='%23e0dbd0'/%3E%3Crect x='10' y='10' width='8' height='8' rx='2.5' fill='%23b45309'/%3E%3C/svg%3E" /><style>${CSS}</style></head><body>${body}</body></html>`;
}

const CSS = `
:root { color-scheme: light; --you:#1d4ed8; --you-bg:#eff6ff; --claude:#15803d; --claude-bg:#f0fdf4; --think:#7c3aed; --think-bg:#f5f3ff;
  --call:#c2410c; --call-bg:#fff7ed; --result:#0f766e; --result-bg:#f0fdfa; --error:#b91c1c; --error-bg:#fef2f2; --other:#6b7280; --other-bg:#f9fafb; --auto:#a16207; --auto-bg:#fefce8; }
* { box-sizing: border-box; }
body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; font-size: 20px; line-height: 1.5; color: #111827; background: #fff; margin: 0 auto; padding: 24px 32px 80px; max-width: 1200px; }
h1 { font-size: 34px; margin: 8px 0; } h2 { font-size: 24px; margin: 0 0 8px; }
a { color: #1d4ed8; } code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 16px; }
code { background: #f3f4f6; padding: 1px 6px; border-radius: 4px; word-break: break-all; }
.muted, .ids, .when, .type { color: #6b7280; } .lead { font-size: 24px; }
.filepath { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 18px; background: #fefce8; border: 1px solid #fde68a; padding: 10px 14px; border-radius: 8px; word-break: break-all; }
.controls input[type=search] { font-size: 20px; padding: 8px 12px; width: 100%; max-width: 600px; border: 1px solid #d1d5db; border-radius: 8px; }
.project { border: 1px solid #e5e7eb; border-radius: 10px; padding: 10px 16px; margin: 10px 0; }
.project > summary { cursor: pointer; font-size: 22px; } .ppath { font-weight: 600; word-break: break-all; }
.sessions { list-style: none; padding: 0; margin: 0; } .session { border-top: 1px solid #f3f4f6; padding: 10px 0; }
.session .prompt { font-weight: 500; text-decoration: none; display: block; } .session .prompt:hover { text-decoration: underline; }
.session .meta { color: #4b5563; font-size: 17px; } .session .path { font-size: 14px; color: #6b7280; background: none; padding: 0; }
.legend { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 10px; padding: 14px 20px; margin: 16px 0; }
.legend ul { list-style: none; padding: 0; margin: 8px 0; } .legend li { margin: 6px 0; }
.chip { display: inline-block; font-size: 15px; font-weight: 700; padding: 2px 10px; border-radius: 999px; margin-right: 6px; border: 1px solid currentColor; }
.chip.side { color: #4338ca; background: #eef2ff; } .chip.fork, .flag.fork { color: #be185d; background: #fdf2f8; }
.card { border: 1px solid #e5e7eb; border-left: 6px solid var(--other); border-radius: 10px; padding: 12px 18px; margin: 14px 0; background: #fff; }
.card > header { display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: center; font-size: 15px; }
.lineno { font-weight: 700; color: #374151; text-decoration: none; }
.card.c-you { border-left-color: var(--you); } .card.c-claude { border-left-color: var(--claude); } .card.c-thinking { border-left-color: var(--think); }
.card.c-call { border-left-color: var(--call); } .card.c-result { border-left-color: var(--result); } .card.c-error { border-left-color: var(--error); }
.card.c-auto { border-left-color: var(--auto); }
.card.housekeeping { padding: 6px 14px; margin: 6px 0; font-size: 16px; background: #fcfcfd; } .card.housekeeping .note { margin: 2px 0; }
.card.sidechain { margin-left: 48px; border-style: dashed; border-left-style: solid; background: #fafaff; }
body.hidehk .card.housekeeping, body.hidehk .hkrun { display: none; }
.hkrun { margin: 6px 0; border: 1px dashed #d1d5db; border-left: 6px solid var(--other); border-radius: 10px; background: #fcfcfd; }
.hkrun > summary { cursor: pointer; padding: 6px 14px; font-size: 16px; color: var(--other); }
.hkrun[open] > summary { border-bottom: 1px dashed #d1d5db; } .hkrun > .card { margin: 6px 10px; }
.block { margin: 8px 0; } .label { display: inline-block; font-weight: 700; font-size: 16px; padding: 2px 12px; border-radius: 999px; margin-bottom: 6px; }
.k-you .label, .chip.k-you { color: var(--you); background: var(--you-bg); } .k-claude .label, .chip.k-claude { color: var(--claude); background: var(--claude-bg); }
.k-thinking .label, .chip.k-thinking { color: var(--think); background: var(--think-bg); } .k-call .label, .chip.k-call { color: var(--call); background: var(--call-bg); }
.k-result .label, .chip.k-result { color: var(--result); background: var(--result-bg); } .k-error .label, .chip.k-error { color: var(--error); background: var(--error-bg); }
.k-other .label, .chip.k-other { color: var(--other); background: var(--other-bg); } .k-auto .label, .chip.k-auto { color: var(--auto); background: var(--auto-bg); }
.text { white-space: pre-wrap; word-wrap: break-word; }
.k-you .text { font-size: 22px; } .k-claude .text { font-size: 21px; }
pre { white-space: pre-wrap; word-break: break-word; background: #f9fafb; border: 1px solid #f3f4f6; border-radius: 6px; padding: 10px 12px; margin: 4px 0; max-height: none; }
pre.json { background: var(--call-bg); } pre.out { background: var(--result-bg); } .k-error pre.out { background: var(--error-bg); } .k-auto pre.out { background: var(--auto-bg); }
.fade { color: #9ca3af; } .toolname { font-family: ui-monospace, Menlo, Consolas, monospace; font-weight: 700; font-size: 20px; color: var(--call); }
details > summary { cursor: pointer; color: #374151; } .think > summary { color: var(--think); font-weight: 600; }
.note { color: #6b7280; font-style: italic; margin: 4px 0; } .detail { color: #4b5563; }
.card > footer { margin-top: 8px; font-size: 14px; display: flex; flex-wrap: wrap; gap: 4px 16px; align-items: baseline; }
.card > footer .raw { flex-basis: 100%; } .rawpre { font-size: 13px; background: #f3f4f6; max-height: 600px; overflow: auto; }
.flag { font-size: 14px; font-weight: 600; padding: 1px 10px; border-radius: 999px; border: 1px solid currentColor; }
.flag.soft { color: #6b7280; font-weight: 500; } .flag.side { color: #4338ca; background: #eef2ff; }
.sublink { color: #4338ca; } .subs { border: 1px solid #c7d2fe; background: #eef2ff; border-radius: 10px; padding: 12px 18px; }
.resume { margin-top: 32px; padding: 16px 20px; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 10px; } .resume code { font-size: 18px; }
.pager { margin: 12px 0; font-size: 17px; } button { font-size: 14px; margin-top: 4px; }
:target { outline: 3px solid #f59e0b; outline-offset: 2px; }
`;

// ---------- server ----------

function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method !== 'GET') return send(res, 405, 'text/plain', 'Read-only');
    if (url.pathname === '/') return send(res, 200, 'text/html; charset=utf-8', renderHome());
    if (url.pathname === '/session') {
      const file = safeFile(url.searchParams.get('f'));
      if (!file) return send(res, 404, 'text/html; charset=utf-8', layout('Not found', '<p>That transcript was not found. <a href="/">Back</a></p>'));
      return send(res, 200, 'text/html; charset=utf-8', renderSession(file, Number(url.searchParams.get('page')) || 1));
    }
    if (url.pathname === '/raw') {
      const file = safeFile(url.searchParams.get('f'));
      const line = Number(url.searchParams.get('line'));
      if (!file || !line) return send(res, 404, 'text/plain', 'Not found');
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      let raw = lines[line - 1] ?? '';
      if (raw.length > RAW_CAP) raw = raw.slice(0, RAW_CAP) + `\n\n[Cut here. This line is ${raw.length.toLocaleString()} characters long. Open the file itself to see all of it.]`;
      return send(res, 200, 'text/plain; charset=utf-8', raw);
    }
    send(res, 404, 'text/plain', 'Not found');
  } catch (err) {
    send(res, 500, 'text/plain; charset=utf-8', 'Something went wrong: ' + err.message);
  }
});

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  try {
    const p = spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true, windowsHide: true });
    p.on('error', () => {});
    p.unref();
  } catch {}
}

function listen(port, triesLeft) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && triesLeft > 0) return listen(port + 1, triesLeft - 1);
    console.error('Could not start the server: ' + err.message);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log(`Transcript viewer is running: ${url}`);
    console.log(`Reading (never writing) ${ROOT}`);
    console.log('Press Ctrl+C to stop.');
    if (!process.env.NO_OPEN) openBrowser(url);
  });
}

listen(START_PORT, 10);
