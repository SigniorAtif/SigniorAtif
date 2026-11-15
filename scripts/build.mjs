#!/usr/bin/env node
// Builds the profile cards in cards/ from GitHub data and profile.config.json.
// No dependencies: Node 20+ only.
//
//   GH_TOKEN=$(gh auth token) node scripts/build.mjs   # fetch live data
//   node scripts/build.mjs --offline                     # reuse scripts/.cache.json
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const here = new URL('./', import.meta.url);
const read = (p, base = root) => readFileSync(new URL(p, base));
const cfg = JSON.parse(read('profile.config.json'));
const metrics = JSON.parse(read('fonts/metrics.json', here));
const portrait = JSON.parse(read('portrait.json', here));
const offline = process.argv.includes('--offline');

// ---------------------------------------------------------------- tokens

// The portfolio's palette: one material, white dots on neutral dark.
// Blue means in progress, lime means done.
const C = {
  ground: '#19191B',
  panel: '#222225',
  line: '#333338',
  lineStrong: '#4A4A52',
  ink: '#E8EAED',
  body: '#C9CFD8',
  muted: '#9AA3AF',
  faint: '#6F7783',
  dot: '#FFFFFF',
  progress: '#7FA6FF',
  done: '#C8F169',
};
const W = 840; // card width; GitHub scales it to the README column
const GAP = 14; // gap between cards in a row of three
const EASE = 'cubic-bezier(.16,1,.3,1)';

const FONT_FILES = {
  display: ['PDisplay', 'normal', 'Bricolage-Display-600.woff2', 600],
  sans: ['PSans', 'normal', 'Bricolage-400.woff2', 400],
  'sans-600': ['PSans', 'normal', 'Bricolage-600.woff2', 600],
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
.display{font-family:PDisplay,PSans,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-weight:600}
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

// A card: flat fill with a hairline so it holds its edge on GitHub's dark page.
function cardRect(x, y, w, h, fill = C.ground) {
  return `<rect x="${r1(x + 0.5)}" y="${y + 0.5}" width="${r1(w - 1)}" height="${h - 1}" rx="14" fill="${fill}" stroke="${C.line}"/>`;
}

// Kicker: small uppercase mono label with tracking.
function kicker(x, y, text, fill, extra = '', cls = 'mono') {
  return `<text x="${x}" y="${y}" class="${cls}" font-size="10.5" letter-spacing="2" fill="${fill}" ${extra}>${esc(text.toUpperCase())}</text>`;
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
  const aliases = cfg.work.projects
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
    today: last,
    projects: cfg.work.projects.map((p, i) => ({ ...p, gh: data[`p${i}`] })),
  };
}

// ---------------------------------------------------------------- cards

// Title in two tones, the way the portfolio sets its section heads.
function twoTone(main, dim, dimFill = C.muted) {
  return `${esc(main)}${dim ? ` <tspan fill="${dimFill}">${esc(dim)}</tspan>` : ''}`;
}

// The hero's own accent, and the paper and ink of the portrait's pool of light.
const HERO = { paper: '#F7F6F2', ink: '#141414', accent: '#DE2621' };

function hero(s) {
  const h = cfg.hero;
  const H = 380;
  const headSize = 40;
  const lines = wrap(h.headline, 'display', headSize, 440);

  // Profile photo as a halftone: the dark lines of the picture are ink dots, its
  // blues are drawn in red.
  const n = portrait.size;
  const box = 300;
  const px = W - 204 - box / 2; // leaves room for the light around it
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

  // The picture sits in a pool of light a little bigger than itself, drawn the way
  // the portfolio draws the saucer's beam: solid at the middle, then dots that
  // shrink towards the rim, with grain so the falloff is never a clean line.
  const mx = px + box / 2;
  const my = H / 2;
  const core = 128; // solid out to here
  const rim = 182; // nothing left by here
  const step = 4.6;
  const grain = 0.55;
  const noise = (x, y) => {
    const v = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return v - Math.floor(v);
  };
  const light = [[], [], []];
  for (let gy = -Math.ceil(rim / step); gy <= rim / step; gy++) {
    for (let gx = -Math.ceil(rim / step); gx <= rim / step; gx++) {
      const d = Math.hypot(gx, gy) * step;
      if (d < core - step || d > rim) continue;
      const clear = Math.min(1, Math.max(0, (d - core) / (rim - core))); // 0 at the core, 1 at the rim
      const value = (1 - clear) ** 1.5 + (noise(gx, gy) - 0.5) * grain * clear ** 0.6;
      const r = Math.round(Math.min(1, value) * step * 0.74 * 100) / 100;
      if (r < 0.3) continue;
      light[Math.floor(noise(gy, gx) * 3)].push(`<circle cx="${r1(mx + gx * step)}" cy="${r1(my + gy * step)}" r="${r}"/>`);
    }
  }

  const defs = `
<clipPath id="reveal"><rect x="${px}" y="0" width="${box}" height="0">
  <animate attributeName="height" from="0" to="${H}" begin=".3s" dur="2.4s" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines=".16 1 .3 1"/>
</rect></clipPath>`;

  const css = `
.pulse{animation:pulse 2.4s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.glow{animation:glow 5s ease-in-out infinite}.g1{animation-delay:-1.7s;animation-duration:6.3s}.g2{animation-delay:-3.1s;animation-duration:4.1s}
@keyframes glow{0%,100%{fill-opacity:1}50%{fill-opacity:.8}}`;

  // Facts sit side by side under the headline, each as wide as its label.
  const factY = H - 62;
  let fx = 40;
  const facts = h.facts
    .map((f) => {
      const x = fx;
      fx += Math.max(textWidth(f.label.toUpperCase(), 'mono', 10.5, 2), textWidth(fill(f.value, s), 'sans-600', 22)) + 36;
      return `${kicker(x, factY, f.label, C.muted)}
<text x="${x}" y="${factY + 28}" class="sans" font-weight="600" font-size="22" letter-spacing="-.3" fill="${C.ink}">${esc(fill(f.value, s))}</text>`;
    })
    .join('\n');

  const headY = 132;
  const linkY = headY + (lines.length - 1) * 45 + 38;
  const body = `
${cardRect(0, 0, W, H)}
<g class="rise" fill="${HERO.paper}">
  <circle cx="${mx}" cy="${my}" r="${core + step * 1.6}"/>
  ${light.map((g, k) => `<g class="glow g${k}">${g.join('')}</g>`).join('\n  ')}
</g>
<g clip-path="url(#reveal)">
  <g fill="${HERO.ink}" fill-opacity=".85">${dots.ink.join('')}</g>
  <g fill="${HERO.accent}">${dots.accent.join('')}</g>
</g>
<g class="rise" ${delay(0)}>
  <text x="40" y="58" class="sans" font-weight="600" font-size="18" letter-spacing="-.2" fill="${C.ink}">${esc(h.mark)}</text>
  <circle class="pulse" cx="${r1(48 + textWidth(h.mark, 'sans-600', 18) + 10)}" cy="52" r="3" fill="${HERO.accent}"/>
  ${kicker(r1(48 + textWidth(h.mark, 'sans-600', 18) + 22), 56, h.place, C.muted)}
</g>
<text class="display rise" font-size="${headSize}" letter-spacing="-1" fill="${C.ink}" ${delay(0.12)}>${lines
    .map((l, i) => `<tspan x="38" y="${headY + i * 45}">${esc(l)}</tspan>`)
    .join('')}</text>
<text x="40" y="${linkY}" class="mono rise" font-size="11.5" fill="${C.body}" ${delay(0.3)}>${esc(h.link.label)}<tspan fill="${HERO.accent}" dx="8">↗</tspan></text>
<g class="rise" ${delay(0.4)}>${facts}</g>`;

  return svg({
    height: H,
    fonts: ['display', 'sans-600', 'mono'],
    css,
    defs,
    body,
    title: `${h.mark} ${h.headline}`,
  });
}

function heatmap(s) {
  const t = cfg.heatmap;
  const H = 248;
  const weeks = s.weeks;
  const x0 = 40;
  const y0 = 96;
  const pitch = (W - 80) / weeks.length;
  // Contributions as dots: the busier the day, the bigger and brighter the dot.
  const radius = [1.5, 2.6, 3.7, 4.8, 5.9].map((r) => r1((r * pitch) / 14.4));
  const alpha = [1, 0.5, 0.68, 0.85, 1];
  const dotFill = (level) => (level === 0 ? C.line : C.dot);

  const cols = weeks
    .map((week, wi) => {
      const dots = week
        .map((d) => {
          const row = new Date(`${d.date}T00:00:00Z`).getUTCDay();
          const today = d.date === s.today;
          const level = today ? Math.max(1, d.level) : d.level;
          return `<circle cx="${r1(x0 + (wi + 0.5) * pitch)}" cy="${r1(y0 + (row + 0.5) * pitch)}" r="${radius[level]}" fill="${today ? C.progress : dotFill(level)}"${level && !today ? ` fill-opacity="${alpha[level]}"` : ''}${today ? ' class="pulse"' : ''}/>`;
        })
        .join('');
      return `<g class="col" ${delay(0.25 + wi * 0.018)}>${dots}</g>`;
    })
    .join('\n');

  const ly = y0 + 7 * pitch + 20;
  const legendW = 5 * 15;
  const legendX = W - 40 - textWidth('more', 'mono', 10) - 8 - legendW;
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
${radius.map((r, i) => `<circle cx="${r1(legendX + i * 15 + 7.5)}" cy="${r1(ly - 3.5)}" r="${r1(r * 0.85)}" fill="${dotFill(i)}"${i ? ` fill-opacity="${alpha[i]}"` : ''}/>`).join('')}
<text x="${W - 40}" y="${r1(ly)}" class="mono" font-size="10" fill="${C.faint}" text-anchor="end">more</text>`;

  const css = `
.col{animation:pop .7s ${EASE} both}
@keyframes pop{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.pulse{animation:pulse 2.4s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}`;

  const body = `
${cardRect(0, 0, W, H)}
<text x="39" y="64" class="display rise" font-size="30" letter-spacing="-.6" fill="${C.ink}">${twoTone(t.title, t.titleDim)}</text>
${kicker(W - 40, 59, t.note, C.faint, `text-anchor="end" ${delay(0.1)}`, 'mono rise')}
${cols}
<g class="rise" ${delay(1.1)}>${labels.join('')}${legend}</g>`;

  return svg({
    height: H,
    fonts: ['display', 'mono'],
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
  const maxH = 100;
  const slot = chartW / s.months.length;
  const barW = r1(slot * 0.72);
  const peak = Math.max(...s.months.map((m) => m.total), 1);
  const peakIdx = s.months.findIndex((m) => m.total === peak);

  // Finished months are white. The month still running is blue: in progress.
  const bars = s.months
    .map((m, i) => {
      const h = Math.max(3, r1((m.total / peak) * maxH));
      const x = r1(chartX + i * slot + (slot - barW) / 2);
      const barFill = m.partial ? C.progress : i === peakIdx ? C.dot : C.lineStrong;
      const label =
        i === peakIdx || m.partial
          ? `<text x="${r1(x + barW / 2)}" y="${r1(base - h - 8)}" class="mono" font-size="10" fill="${m.partial ? C.progress : C.ink}" text-anchor="middle">${fmt(m.total)}</text>`
          : '';
      return `<g class="bar" ${delay(0.3 + i * 0.05)}><rect x="${x}" y="${r1(base - h)}" width="${barW}" height="${h}" rx="2" fill="${barFill}"/>${label}</g>
<text x="${r1(x + barW / 2)}" y="${base + 20}" class="mono" font-size="10" fill="${m.partial ? C.progress : C.faint}" text-anchor="middle">${m.label}</text>`;
    })
    .join('\n');

  // Between streaks, lead with the longest one rather than a zero.
  const streak = s.current || s.longest;
  const streakNote = !s.current
    ? 'longest streak this year'
    : s.current >= s.longest
      ? 'current streak, and the longest'
      : `current streak · longest ${s.longest}`;
  const rx = 600;
  const dim = (t) => `<tspan fill="${C.muted}">${t}</tspan>`;
  const rows = [
    { y: 104, big: `${streak}${dim(streak === 1 ? ' day' : ' days')}`, note: streakNote },
    { y: 184, big: `${s.active}${dim(` / ${s.span}`)}`, note: 'days with a contribution' },
    { y: 264, big: `${s.busiest}`, note: 'on the busiest day' },
  ];
  const right = rows
    .map(
      (r, i) => `<g class="rise" ${delay(0.5 + i * 0.12)}>
<text x="${rx}" y="${r.y}" class="display" font-size="30" letter-spacing="-.6" fill="${C.ink}">${r.big}</text>
<text x="${rx}" y="${r.y + 21}" class="sans" font-size="12" fill="${C.muted}">${esc(r.note)}</text>
${i < rows.length - 1 ? `<line x1="${rx}" x2="${W - 40}" y1="${r.y + 44}" y2="${r.y + 44}" stroke="${C.line}"/>` : ''}</g>`,
    )
    .join('\n');

  const css = `
.bar{animation:grow .9s ${EASE} both;transform-box:fill-box;transform-origin:50% 100%}
@keyframes grow{from{transform:scaleY(0)}to{transform:none}}`;

  const body = `
${cardRect(0, 0, W, H)}
${kicker(40, 56, 'The last 12 months on GitHub', C.muted, '', 'mono rise')}
<text x="38" y="108" class="display rise" font-size="46" letter-spacing="-1.2" fill="${C.ink}" ${delay(0.1)}>${twoTone(fmt(s.total), 'contributions')}</text>
${bars}
${right}`;

  return svg({
    height: H,
    fonts: ['display', 'sans', 'mono'],
    css,
    body,
    title: `${fmt(s.total)} contributions. ${s.current ? 'Current' : 'Longest'} streak ${streak} days, ${s.active} of ${s.span} days active, busiest day ${s.busiest}.`,
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

const two = (n) => String(n).padStart(2, '0');

// One of the things I do: a big number, a name, a line about it and what it covers.
function thing(t, i) {
  const { slotW, cardW, x } = rowSlot(i);
  const lines = wrap(t.text, 'sans', 12.5, cardW - 44);
  const most = Math.max(...cfg.things.items.map((o) => wrap(o.text, 'sans', 12.5, cardW - 44).length));
  const H = 154 + most * 18.5 + 40;
  const body = `
<g class="rise" ${delay(0.1 + i * 0.12)}>
${cardRect(x, 0, cardW, H, C.panel)}
<text x="${r1(x + 20)}" y="66" class="display" font-size="46" letter-spacing="-1.5" fill="${C.lineStrong}">${two(i + 1)}</text>
<text x="${r1(x + cardW - 22)}" y="40" class="mono" font-size="13" fill="${C.muted}" text-anchor="end">↗</text>
<text x="${r1(x + 22)}" y="112" class="sans" font-weight="600" font-size="20" letter-spacing="-.4" fill="${C.ink}">${esc(t.title)}</text>
<text class="sans" font-size="12.5" fill="${C.body}">${lines
    .map((l, k) => `<tspan x="${r1(x + 22)}" y="${140 + k * 18.5}">${esc(l)}</tspan>`)
    .join('')}</text>
<line x1="${r1(x + 22)}" x2="${r1(x + cardW - 22)}" y1="${H - 44}" y2="${H - 44}" stroke="${C.line}"/>
<text x="${r1(x + 22)}" y="${H - 22}" class="mono" font-size="10.5" fill="${C.muted}">${esc(t.names.join(' · '))}</text>
</g>`;
  return svg({
    width: slotW,
    height: H,
    fonts: ['display', 'sans', 'sans-600', 'mono'],
    body,
    title: `${t.title}. ${t.text}`,
  });
}

function project(p, i) {
  const H = 194;
  const { slotW, cardW, x } = rowSlot(i % 3);
  const gh = p.gh;
  if (!gh) throw new Error(`repository not found: ${p.repo}`);
  const name = p.name || gh.name;
  const lines = wrap(p.text || gh.description || '', 'sans', 12.5, cardW - 44).slice(0, 3);
  // Lime means done: the project is live somewhere you can open it.
  const live = p.live ?? Boolean(gh.homepageUrl);
  const meta = [gh.primaryLanguage?.name, gh.stargazerCount > 0 ? `${gh.stargazerCount} ${gh.stargazerCount === 1 ? 'star' : 'stars'}` : null]
    .filter(Boolean)
    .join(' · ');
  const liveW = textWidth('LIVE', 'mono', 10.5, 2);
  const css = `
.pulse{animation:pulse 2.4s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}`;
  const body = `
<g class="rise" ${delay(0.1 + (i % 3) * 0.12)}>
${cardRect(x, 0, cardW, H)}
${kicker(r1(x + 22), 40, `${two(i + 1)} / ${p.type || 'Project'}`, C.muted)}
${
  live
    ? `<circle class="pulse" cx="${r1(x + cardW - 22 - liveW - 10)}" cy="36.2" r="3" fill="${C.done}"/>${kicker(r1(x + cardW - 22), 40, 'Live', C.done, 'text-anchor="end"')}`
    : ''
}
<text x="${r1(x + 22)}" y="76" class="sans" font-weight="600" font-size="18" letter-spacing="-.3" fill="${C.ink}">${esc(name)}</text>
<text class="sans" font-size="12.5" fill="${C.body}">${lines
    .map((l, k) => `<tspan x="${r1(x + 22)}" y="${102 + k * 18.5}">${esc(l)}</tspan>`)
    .join('')}</text>
<text x="${r1(x + 22)}" y="${H - 22}" class="mono" font-size="10.5" fill="${C.faint}">${esc(meta)}</text>
</g>`;
  return svg({
    width: slotW,
    height: H,
    fonts: ['sans', 'sans-600', 'mono'],
    css,
    body,
    title: `${name}: ${p.text || gh.description || ''}`,
  });
}

// Section heads sit straight on the page, so they come in a light and a dark ink.
function heading(h, n, theme) {
  const H = 78;
  const ink = theme === 'dark' ? C.ink : '#1F2328';
  const dim = theme === 'dark' ? C.faint : '#8C959F';
  const body = `${kicker(2, 20, `${two(n)} / ${h.kicker}`, dim, '', 'mono rise')}
<text x="0" y="62" class="display rise" font-size="34" letter-spacing="-.8" fill="${ink}" ${delay(0.08)}>${twoTone(h.title, h.titleDim, dim)}</text>`;
  return svg({ height: H, fonts: ['display', 'mono'], body, title: [h.title, h.titleDim].filter(Boolean).join(' ') });
}

// ---------------------------------------------------------------- readme

function readme(s) {
  const img = (src, alt, width = '100%') => `<img src="${src}" width="${width}" alt="${esc(alt)}">`;
  const row = (items) =>
    items.map(({ url, src, alt }) => `<a href="${url}">${img(src, alt, '33.333%')}</a>`).join('');
  const head = (slug, h) => `<picture>
  <source media="(prefers-color-scheme: dark)" srcset="cards/${slug}-dark.svg">
  ${img(`cards/${slug}-light.svg`, [h.title, h.titleDim].filter(Boolean).join(' '))}
</picture>`;
  const projects = s.projects.map((p, i) => ({ url: p.gh.url, src: `cards/project-${i + 1}.svg`, alt: p.name || p.gh.name }));
  const rows = [];
  for (let i = 0; i < projects.length; i += 3) rows.push(`<p>${row(projects.slice(i, i + 3))}</p>`);
  return `<!-- Generated by scripts/build.mjs from profile.config.json. Edit those, not this file. -->
<a href="${cfg.hero.link.url}">${img('cards/hero.svg', `${cfg.hero.mark} ${cfg.hero.headline}`)}</a>

${img('cards/heatmap.svg', 'Contribution heatmap')}

${img('cards/stats.svg', 'Contribution stats')}

${head('things', cfg.things)}

<p>${row(cfg.things.items.map((t, i) => ({ url: t.url, src: `cards/thing-${i + 1}.svg`, alt: t.title })))}</p>

${head('work', cfg.work)}

${rows.join('\n\n')}

<p align="center">${cfg.links.map((l) => `<a href="${l.url}">${esc(l.label)}</a>`).join(' &nbsp;/&nbsp; ')}</p>

<p align="center"><sub>${esc(cfg.signOff)}</sub></p>
`;
}

// ---------------------------------------------------------------- main

const s = summarise(await fetchData());
const out = new URL('cards/', root);
// Start clean so cards dropped from the config do not linger.
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const files = {
  'hero.svg': hero(s),
  'heatmap.svg': heatmap(s),
  'stats.svg': stats(s),
};
for (const theme of ['dark', 'light']) {
  files[`things-${theme}.svg`] = heading(cfg.things, 1, theme);
  files[`work-${theme}.svg`] = heading(cfg.work, 2, theme);
}
cfg.things.items.forEach((t, i) => (files[`thing-${i + 1}.svg`] = thing(t, i)));
s.projects.forEach((p, i) => (files[`project-${i + 1}.svg`] = project(p, i)));
for (const [name, content] of Object.entries(files)) writeFileSync(new URL(name, out), content);
writeFileSync(new URL('README.md', root), readme(s));
console.log(
  `built ${Object.keys(files).length} cards: ${fmt(s.total)} contributions, streak ${s.current}/${s.longest}, ` +
    `${s.active}/${s.span} active days, busiest ${s.busiest}`,
);
