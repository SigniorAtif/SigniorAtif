#!/usr/bin/env node
// Builds the profile cards in cards/ from GitHub data and profile.config.json.
// No dependencies: Node 20+ only.
//
//   GH_TOKEN=$(gh auth token) node scripts/build.mjs   # fetch live data
//   node scripts/build.mjs --offline                     # reuse scripts/.cache.json
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const here = new URL('./', import.meta.url);
const read = (p, base = root) => readFileSync(new URL(p, base));
const cfg = JSON.parse(read('profile.config.json'));
const metrics = JSON.parse(read('fonts/metrics.json', here));
const portrait = JSON.parse(read('portrait.json', here));
const offline = process.argv.includes('--offline');

// ---------------------------------------------------------------- tokens

const C = {
  card: '#F7F6F2',
  ink: '#141414',
  body: '#3A3935',
  muted: '#6E6C66',
  faint: '#A6A49D',
  line: '#E2E0D9',
  blue: '#2148F2',
  red: '#DE2621',
  yellow: '#F6BD16',
  levels: ['#E9E8E2', '#CAD3FB', '#93A7F7', '#5877F4', '#2148F2'],
};
const tileInk = { blue: '#FFFFFF', red: '#FFFFFF', yellow: C.ink };
const W = 840; // card width; GitHub scales it to the README column
const GAP = 14; // gap between cards in a row of three
const EASE = 'cubic-bezier(.2,.7,.2,1)';

const FONT_FILES = {
  serif: ['PSerif', 'normal', 'InstrumentSerif-Regular.woff2'],
  'serif-italic': ['PSerif', 'italic', 'InstrumentSerif-Italic.woff2'],
  sans: ['PSans', 'normal', 'Inter-400.woff2', 400],
  'sans-600': ['PSans', 'normal', 'Inter-600.woff2', 600],
  mono: ['PMono', 'normal', 'JBM-400.woff2'],
};
const fontData = Object.fromEntries(
  Object.entries(FONT_FILES).map(([k, [, , file]]) => [k, read(`fonts/${file}`, here).toString('base64')]),
);

// ---------------------------------------------------------------- helpers

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = (n) => n.toLocaleString('en-US');
const r1 = (n) => Math.round(n * 10) / 10;

function textWidth(str, font, size, tracking = 0) {
  const table = metrics[font];
  let w = 0;
  for (const ch of str) w += table[ch] ?? 0.55;
  return w * size + tracking * Math.max(0, [...str].length - 1);
}

function wrap(str, font, size, max) {
  const lines = [];
  let line = '';
  for (const word of str.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && textWidth(next, font, size) > max) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

function fontFaces(keys) {
  return keys
    .map((k) => {
      const [family, style, , weight = 400] = FONT_FILES[k];
      return `@font-face{font-family:${family};font-style:${style};font-weight:${weight};src:url(data:font/woff2;base64,${fontData[k]}) format('woff2')}`;
    })
    .join('');
}

const BASE_CSS = `
.serif{font-family:PSerif,Georgia,'Times New Roman',serif}
.it{font-family:PSerif,Georgia,serif;font-style:italic}
.sans{font-family:PSans,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif}
.mono{font-family:PMono,ui-monospace,SFMono-Regular,Menlo,monospace}
.rise{animation:rise .9s ${EASE} both}
@keyframes rise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}`;

function svg({ width = W, height, fonts, css = '', defs = '', body, title }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" role="img" aria-label="${esc(title)}">
<title>${esc(title)}</title>
<style>${fontFaces(fonts)}${BASE_CSS}${css}</style>
${defs ? `<defs>${defs}</defs>` : ''}
${body}
</svg>
`;
}

const delay = (s) => `style="animation-delay:${r1(s * 1000) / 1000}s"`;

function cardRect(x, y, w, h, fill = C.card) {
  return `<rect x="${x}" y="${y}" width="${r1(w)}" height="${h}" rx="14" fill="${fill}"/>`;
}

// Kicker: small uppercase mono label with tracking.
function kicker(x, y, text, fill, extra = '', cls = 'mono') {
  return `<text x="${x}" y="${y}" class="${cls}" font-size="10.5" letter-spacing="1.6" fill="${fill}" ${extra}>${esc(text.toUpperCase())}</text>`;
}

// ---------------------------------------------------------------- data

async function fetchData() {
  const cache = new URL('.cache.json', here);
  if (offline) {
    if (!existsSync(cache)) throw new Error('--offline needs scripts/.cache.json from an online run');
    return JSON.parse(readFileSync(cache));
  }
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error('set GH_TOKEN (or GITHUB_TOKEN) to fetch contribution data');

  const repoFields = 'name url homepageUrl description stargazerCount primaryLanguage { name }';
  const aliases = cfg.projects
    .map((p, i) => {
      const [owner, name] = p.repo.includes('/') ? p.repo.split('/') : [cfg.login, p.repo];
      return `p${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${repoFields} }`;
    })
    .join('\n');
  const query = `query($login: String!) {
    user(login: $login) {
      repositories(ownerAffiliations: OWNER, privacy: PUBLIC) { totalCount }
      contributionsCollection {
        contributionCalendar {
          totalContributions
          weeks { contributionDays { date contributionCount contributionLevel } }
        }
      }
    }
    ${aliases}
  }`;
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'profile-cards' },
    body: JSON.stringify({ query, variables: { login: cfg.login } }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(`GitHub API: ${JSON.stringify(json.errors ?? json)}`);
  writeFileSync(cache, JSON.stringify(json.data));
  return json.data;
}

function summarise(data) {
  const cal = data.user.contributionsCollection.contributionCalendar;
  const days = cal.weeks.flatMap((w) => w.contributionDays);
  const LEVEL = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };

  // Streaks. Today with no contributions yet doesn't break the current streak.
  let longest = 0;
  let run = 0;
  for (const d of days) {
    run = d.contributionCount > 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  let current = 0;
  let i = days.length - 1;
  if (days[i].contributionCount === 0) i--;
  for (; i >= 0 && days[i].contributionCount > 0; i--) current++;

  // Twelve calendar months ending with the current one.
  const last = days[days.length - 1].date;
  const [ly, lm] = last.split('-').map(Number);
  const months = [];
  for (let k = 11; k >= 0; k--) {
    const d = new Date(Date.UTC(ly, lm - 1 - k, 1));
    const key = d.toISOString().slice(0, 7);
    months.push({
      key,
      label: d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }),
      total: days.filter((x) => x.date.startsWith(key)).reduce((s, x) => s + x.contributionCount, 0),
      partial: k === 0,
    });
  }

  return {
    total: cal.totalContributions,
    weeks: cal.weeks.map((w) => w.contributionDays.map((d) => ({ ...d, level: LEVEL[d.contributionLevel] ?? 0 }))),
    current,
    longest,
    active: days.filter((d) => d.contributionCount > 0).length,
    span: days.length,
    busiest: Math.max(...days.map((d) => d.contributionCount)),
    months,
    repos: data.user.repositories.totalCount,
    yearsCoding: new Date(`${last}T00:00:00Z`).getUTCFullYear() - cfg.since,
    projects: cfg.projects.map((p, i) => ({ ...p, gh: data[`p${i}`] })),
  };
}

// ---------------------------------------------------------------- cards

function hero(s) {
  const h = cfg.hero;
  const H = 364;
  const nameSize = 104;
  const lastW = textWidth(h.last, 'serif-italic', nameSize);
  const lines = wrap(h.tagline, 'sans', 15.5, 400);

  // Halftone portrait in a square on the right, fading out towards its edges.
  const n = portrait.size;
  const box = 300;
  const px = W - box - 24;
  const py = (H - box) / 2;
  const pitch = box / n;
  const dots = { ink: [], accent: [] };
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const [dark, accent] = portrait.cells[y * n + x];
      const dx = (x + 0.5) / n - 0.5;
      const dy = (y + 0.5) / n - 0.5;
      const dist = Math.sqrt(dx * dx + dy * dy) / 0.5;
      const fade = 1 - Math.min(1, Math.max(0, (dist - 0.6) / 0.4));
      const v = Math.max(0, (dark / 100 - 0.2) / 0.75) * fade;
      const r = r1(Math.min(1, v) * pitch * 0.5 * 10) / 10;
      if (r < 0.35) continue;
      const cx = r1(px + (x + 0.5) * pitch);
      const cy = r1(py + (y + 0.5) * pitch);
      (accent ? dots.accent : dots.ink).push(`<circle cx="${cx}" cy="${cy}" r="${r}"/>`);
    }
  }

  // A blue band sweeps across the surname, then waits and sweeps again.
  const defs = `
<linearGradient id="sweep" gradientUnits="userSpaceOnUse" x1="40" y1="0" x2="${r1(40 + lastW)}" y2="0">
  <stop offset="0" stop-color="${C.ink}"/><stop offset=".38" stop-color="${C.ink}"/>
  <stop offset=".47" stop-color="${C.blue}"/><stop offset=".53" stop-color="${C.blue}"/>
  <stop offset=".62" stop-color="${C.ink}"/><stop offset="1" stop-color="${C.ink}"/>
  <animateTransform attributeName="gradientTransform" type="translate" dur="8s" begin=".5s" repeatCount="indefinite"
    values="${r1(-lastW)} 0;${r1(-lastW)} 0;${r1(lastW)} 0;${r1(lastW)} 0" keyTimes="0;.05;.4;1"/>
</linearGradient>
<clipPath id="reveal"><rect x="${px}" y="0" width="${box}" height="0">
  <animate attributeName="height" from="0" to="${H}" begin=".3s" dur="2.2s" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines=".25 .6 .2 1"/>
</rect></clipPath>`;

  const css = `
.pulse{animation:pulse 2.4s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}`;

  const body = `
${cardRect(0, 0, W, H)}
<g clip-path="url(#reveal)">
  <g fill="${C.ink}" fill-opacity=".82">${dots.ink.join('')}</g>
  <g fill="${C.blue}">${dots.accent.join('')}</g>
</g>
<g class="rise" ${delay(0)}>
  <circle class="pulse" cx="44" cy="52.5" r="3.5" fill="${C.blue}"/>
  ${kicker(56, 56, h.eyebrow, C.muted)}
</g>
<text x="36" y="156" class="serif rise" font-size="${nameSize}" letter-spacing="-1" fill="${C.ink}" ${delay(0.1)}>${esc(h.first)}</text>
<text x="40" y="246" class="it rise" font-size="${nameSize}" letter-spacing="-1" fill="url(#sweep)" ${delay(0.2)}>${esc(h.last)}</text>
<text class="sans rise" font-size="15.5" fill="${C.body}" ${delay(0.35)}>${lines
    .map((l, i) => `<tspan x="40" y="${288 + i * 23}">${esc(l)}</tspan>`)
    .join('')}</text>
<text x="40" y="${288 + lines.length * 23 + 12}" class="mono rise" font-size="11.5" fill="${C.ink}" ${delay(0.45)}>${esc(h.link.label)}<tspan fill="${C.blue}" dx="8">↗</tspan></text>`;

  return svg({
    height: H,
    fonts: ['serif', 'serif-italic', 'sans', 'mono'],
    css,
    defs,
    body,
    title: `${h.first} ${h.last}. ${h.tagline}`,
  });
}

function heatmap(s) {
  const t = cfg.heatmap;
  const H = 244;
  const weeks = s.weeks;
  const x0 = 40;
  const y0 = 94;
  const pitch = (W - 80 + 3) / weeks.length;
  const cell = r1(pitch - 3);

  const cols = weeks
    .map((week, wi) => {
      const rects = week
        .map((d) => {
          const row = new Date(`${d.date}T00:00:00Z`).getUTCDay();
          return `<rect x="${r1(x0 + wi * pitch)}" y="${r1(y0 + row * pitch)}" width="${cell}" height="${cell}" rx="2.5" fill="${C.levels[d.level]}"/>`;
        })
        .join('');
      return `<g class="col" ${delay(0.25 + wi * 0.018)}>${rects}</g>`;
    })
    .join('\n');

  const ly = y0 + 7 * pitch + 18;
  const legendX = W - 40 - textWidth('more', 'mono', 10) - 8 - 5 * 13;
  const legendStart = legendX - 8 - textWidth('less', 'mono', 10);

  // Month labels at the first week that starts in a new month, kept clear of the legend.
  const labels = [];
  let prev = '';
  let lastX = -99;
  weeks.forEach((week, wi) => {
    const m = week[0].date.slice(0, 7);
    if (m !== prev) {
      const x = x0 + wi * pitch;
      if (wi > 0 && x - lastX > 30 && x + textWidth('Mmm', 'mono', 10) < legendStart - 14) {
        const name = new Date(`${week[0].date}T00:00:00Z`).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
        labels.push(`<text x="${r1(x)}" y="${r1(ly)}" class="mono" font-size="10" fill="${C.faint}">${name}</text>`);
        lastX = x;
      }
      prev = m;
    }
  });

  const legend = `
<text x="${r1(legendX - 8)}" y="${r1(ly)}" class="mono" font-size="10" fill="${C.faint}" text-anchor="end">less</text>
${C.levels.map((c, i) => `<rect x="${r1(legendX + i * 13)}" y="${r1(ly - 9)}" width="10" height="10" rx="2" fill="${c}"/>`).join('')}
<text x="${W - 40}" y="${r1(ly)}" class="mono" font-size="10" fill="${C.faint}" text-anchor="end">more</text>`;

  const css = `
.col{animation:pop .7s ${EASE} both}
@keyframes pop{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}`;

  const body = `
${cardRect(0, 0, W, H)}
<text x="40" y="62" class="serif rise" font-size="34" fill="${C.ink}">${esc(t.title)} <tspan class="it" fill="${C.blue}">${esc(t.titleItalic)}</tspan></text>
${kicker(W - 40, 58, t.note, C.faint, `text-anchor="end" ${delay(0.1)}`, 'mono rise')}
${cols}
<g class="rise" ${delay(1.1)}>${labels.join('')}${legend}</g>`;

  return svg({
    height: H,
    fonts: ['serif', 'serif-italic', 'mono'],
    css,
    body,
    title: `${fmt(s.total)} contributions in the last year`,
  });
}

function stats(s) {
  const H = 312;
  const chartX = 40;
  const chartW = 500;
  const base = 250;
  const maxH = 104;
  const slot = chartW / s.months.length;
  const barW = r1(slot * 0.72);
  const peak = Math.max(...s.months.map((m) => m.total), 1);
  const peakIdx = s.months.findIndex((m) => m.total === peak);

  const bars = s.months
    .map((m, i) => {
      const h = Math.max(3, r1((m.total / peak) * maxH));
      const x = r1(chartX + i * slot + (slot - barW) / 2);
      const fill = m.partial ? '#D6D4CD' : i === peakIdx ? C.blue : C.ink;
      const label =
        i === peakIdx
          ? `<text x="${r1(x + barW / 2)}" y="${r1(base - h - 8)}" class="mono" font-size="10" fill="${C.blue}" text-anchor="middle">${fmt(m.total)}</text>`
          : '';
      return `<g class="bar" ${delay(0.3 + i * 0.05)}><rect x="${x}" y="${r1(base - h)}" width="${barW}" height="${h}" rx="2" fill="${fill}"/>${label}</g>
<text x="${r1(x + barW / 2)}" y="${base + 20}" class="mono" font-size="10" fill="${C.faint}" text-anchor="middle">${m.label}</text>`;
    })
    .join('\n');

  const streakNote = s.current >= s.longest ? 'current streak, and the longest' : `current streak · longest ${s.longest}`;
  const rx = 600;
  const rows = [
    { y: 106, big: `${s.current}<tspan class="it"> ${s.current === 1 ? 'day' : 'days'}</tspan>`, note: streakNote },
    { y: 186, big: `${s.active}<tspan fill="${C.faint}"> / </tspan>${s.span}`, note: 'days with a contribution' },
    { y: 266, big: `${s.busiest}`, note: 'on the busiest day' },
  ];
  const right = rows
    .map(
      (r, i) => `<g class="rise" ${delay(0.5 + i * 0.12)}>
<text x="${rx}" y="${r.y}" class="serif" font-size="36" fill="${C.ink}">${r.big}</text>
<text x="${rx}" y="${r.y + 21}" class="sans" font-size="11.5" fill="${C.muted}">${esc(r.note)}</text>
${i < rows.length - 1 ? `<line x1="${rx}" x2="${W - 40}" y1="${r.y + 44}" y2="${r.y + 44}" stroke="${C.line}"/>` : ''}</g>`,
    )
    .join('\n');

  const css = `
.bar{animation:grow .9s ${EASE} both;transform-box:fill-box;transform-origin:50% 100%}
@keyframes grow{from{transform:scaleY(0)}to{transform:none}}`;

  const body = `
${cardRect(0, 0, W, H)}
${kicker(40, 56, 'The last 12 months on GitHub', C.faint, '', 'mono rise')}
<text x="38" y="110" class="serif rise" font-size="54" letter-spacing="-.5" fill="${C.ink}" ${delay(0.1)}>${fmt(s.total)} <tspan class="it">contributions</tspan></text>
${bars}
${right}`;

  return svg({
    height: H,
    fonts: ['serif', 'serif-italic', 'sans', 'mono'],
    css,
    body,
    title: `${fmt(s.total)} contributions. Current streak ${s.current} days, ${s.active} of ${s.span} days active, busiest day ${s.busiest}.`,
  });
}

// One card of a row of three. Each is its own image so it can link somewhere;
// the transparent margin built into each makes the row add up to the full width.
function rowSlot(i) {
  const slotW = W / 3;
  const cardW = (W - 2 * GAP) / 3;
  const x = r1(i * (cardW + GAP) - i * slotW);
  return { slotW: r1(slotW), cardW, x };
}

function fill(str, s) {
  return String(str).replace(/\{(\w+)\}/g, (_, k) => (k in s ? fmt(s[k]) : `{${k}}`));
}

function tile(t, i, s) {
  const H = 196;
  const { slotW, cardW, x } = rowSlot(i);
  const ink = tileInk[t.color];
  const soft = t.color === 'yellow' ? 'rgba(20,20,20,.78)' : 'rgba(255,255,255,.86)';
  const lines = wrap(t.text, 'sans', 12.5, cardW - 44);
  const value = fill(t.value, s);
  const css = `
.ring{animation:spin 30s linear infinite;transform-origin:${r1(x + cardW + 8)}px ${H + 10}px}
@keyframes spin{to{transform:rotate(360deg)}}`;
  const body = `
<clipPath id="c"><rect x="${x}" y="0" width="${r1(cardW)}" height="${H}" rx="14"/></clipPath>
<g class="rise" ${delay(0.1 + i * 0.12)}>
${cardRect(x, 0, cardW, H, C[t.color])}
<g clip-path="url(#c)" stroke="${ink}" stroke-opacity=".14" fill="none">
  <g class="ring"><circle cx="${r1(x + cardW + 8)}" cy="${H + 10}" r="70"/><circle cx="${r1(x + cardW + 8)}" cy="${H + 10}" r="104" stroke-dasharray="2 6"/><circle cx="${r1(x + cardW + 8)}" cy="${H + 10}" r="140"/></g>
</g>
${kicker(r1(x + 22), 38, t.kicker, ink, 'fill-opacity=".9"')}
<text x="${r1(x + cardW - 22)}" y="39" class="mono" font-size="12" fill="${ink}" text-anchor="end">→</text>
<text x="${r1(x + 21)}" y="100" class="serif" font-size="44" letter-spacing="-.3" fill="${ink}">${esc(value)} <tspan class="it">${esc(t.unit)}</tspan></text>
<text class="sans" font-size="12.5" fill="${soft}">${lines
    .map((l, k) => `<tspan x="${r1(x + 22)}" y="${130 + k * 18.5}">${esc(l)}</tspan>`)
    .join('')}</text>
</g>`;
  return svg({
    width: slotW,
    height: H,
    fonts: ['serif', 'serif-italic', 'sans', 'mono'],
    css,
    body,
    title: `${value} ${t.unit}. ${t.text}`,
  });
}

function project(p, i) {
  const H = 172;
  const { slotW, cardW, x } = rowSlot(i);
  const gh = p.gh;
  if (!gh) throw new Error(`repository not found: ${p.repo}`);
  const lines = wrap(p.text || gh.description || '', 'sans', 12.5, cardW - 44).slice(0, 3);
  const meta = [gh.primaryLanguage?.name, gh.stargazerCount > 0 ? null : gh.homepageUrl ? 'live' : null]
    .filter(Boolean)
    .join(' · ');
  const star =
    gh.stargazerCount > 0
      ? `${meta ? ' · ' : ''}<tspan class="sans" font-size="10">★</tspan> ${gh.stargazerCount}`
      : '';
  const body = `
<g class="rise" ${delay(0.1 + i * 0.12)}>
${cardRect(x, 0, cardW, H)}
<rect x="${r1(x + 22)}" y="32" width="7" height="7" rx="1.5" fill="${C[p.color]}"/>
<text x="${r1(x + 37)}" y="40.5" class="sans" font-weight="600" font-size="15" letter-spacing="-.2" fill="${C.ink}">${esc(gh.name)}</text>
<text class="sans" font-size="12.5" fill="${C.body}">${lines
    .map((l, k) => `<tspan x="${r1(x + 22)}" y="${72 + k * 18.5}">${esc(l)}</tspan>`)
    .join('')}</text>
<text x="${r1(x + 22)}" y="${H - 24}" class="mono" font-size="10.5" fill="${C.faint}">${esc(meta)}${star}</text>
</g>`;
  return svg({
    width: slotW,
    height: H,
    fonts: ['sans', 'sans-600', 'mono'],
    body,
    title: `${gh.name}: ${p.text || gh.description || ''}`,
  });
}

function heading(theme) {
  const H = 64;
  const fill = theme === 'dark' ? '#E8E6E1' : '#1F2328';
  const body = `<text x="2" y="44" class="serif rise" font-size="38" fill="${fill}">${esc(cfg.codingTitle)} <tspan class="it">${esc(cfg.codingTitleItalic)}</tspan></text>`;
  return svg({ height: H, fonts: ['serif', 'serif-italic'], body, title: `${cfg.codingTitle} ${cfg.codingTitleItalic}` });
}

// ---------------------------------------------------------------- readme

function readme(s) {
  const img = (src, alt, width = '100%') => `<img src="${src}" width="${width}" alt="${esc(alt)}">`;
  const row = (items) =>
    items.map(({ url, src, alt }) => `<a href="${url}">${img(src, alt, '33.333%')}</a>`).join('');
  return `<!-- Generated by scripts/build.mjs from profile.config.json. Edit those, not this file. -->
<a href="${cfg.hero.link.url}">${img('cards/hero.svg', `${cfg.hero.first} ${cfg.hero.last}`)}</a>

${img('cards/heatmap.svg', 'Contribution heatmap')}

${img('cards/stats.svg', 'Contribution stats')}

<p>${row(cfg.tiles.map((t, i) => ({ url: t.url, src: `cards/tile-${i + 1}.svg`, alt: `${fill(t.value, s)} ${t.unit}` })))}</p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="cards/coding-dark.svg">
  ${img('cards/coding-light.svg', `${cfg.codingTitle} ${cfg.codingTitleItalic}`)}
</picture>

<p>${row(s.projects.map((p, i) => ({ url: p.gh.url, src: `cards/project-${i + 1}.svg`, alt: p.gh.name })))}</p>

<p align="center">${cfg.links.map((l) => `<a href="${l.url}">${esc(l.label)}</a>`).join(' &nbsp;/&nbsp; ')}</p>
`;
}

// ---------------------------------------------------------------- main

const s = summarise(await fetchData());
const out = new URL('cards/', root);
mkdirSync(out, { recursive: true });
const files = {
  'hero.svg': hero(s),
  'heatmap.svg': heatmap(s),
  'stats.svg': stats(s),
  'coding-dark.svg': heading('dark'),
  'coding-light.svg': heading('light'),
};
cfg.tiles.forEach((t, i) => (files[`tile-${i + 1}.svg`] = tile(t, i, s)));
s.projects.forEach((p, i) => (files[`project-${i + 1}.svg`] = project(p, i)));
for (const [name, content] of Object.entries(files)) writeFileSync(new URL(name, out), content);
writeFileSync(new URL('README.md', root), readme(s));
console.log(
  `built ${Object.keys(files).length} cards: ${fmt(s.total)} contributions, streak ${s.current}/${s.longest}, ` +
    `${s.active}/${s.span} active days, busiest ${s.busiest}`,
);
