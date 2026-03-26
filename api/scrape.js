import * as cheerio from 'cheerio';

// NOTE: Rate limiter uses in-memory Map — resets per cold start.
// On Vercel's multi-instance deployment each instance has its own Map, so the
// effective limit is RATE_LIMIT_MAX × N instances. This is a best-effort
// defence; for hard rate limiting use an external store (e.g. Upstash Redis).
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { windowStart: now, count: 1 });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX;
}

// SSRF protection: validate URL is a safe external target
function validateUrl(urlString) {
  if (typeof urlString !== 'string') return { valid: false, reason: 'URL must be a string' };

  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    return { valid: false, reason: 'Invalid URL format' };
  }

  // Only allow HTTP/HTTPS
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { valid: false, reason: 'Only http and https URLs are allowed' };
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block localhost and loopback (IPv4 and IPv6)
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '0.0.0.0' ||
    hostname === '::1' ||
    hostname === '0:0:0:0:0:0:0:1' ||
    hostname === '[::1]'
  ) {
    return { valid: false, reason: 'Localhost URLs are not allowed' };
  }

  // Block IPv6 link-local, ULA, and multicast ranges
  if (
    hostname.startsWith('fe80:') ||
    hostname.startsWith('fc00:') ||
    hostname.startsWith('fd') ||
    hostname.startsWith('ff') ||
    hostname.startsWith('[fe80:') ||
    hostname.startsWith('[fc00:') ||
    hostname.startsWith('[fd') ||
    hostname.startsWith('[ff')
  ) {
    return { valid: false, reason: 'IPv6 link-local/ULA addresses are not allowed' };
  }

  // Block IPv4-mapped IPv6 addresses (::ffff:192.168.x.x etc.)
  const ipv4MappedMatch = hostname.replace(/^\[|\]$/g, '').match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (ipv4MappedMatch) {
    const ipv4 = ipv4MappedMatch[1];
    const check = validateUrl(`http://${ipv4}`);
    if (!check.valid) return { valid: false, reason: 'IPv4-mapped IPv6 address not allowed' };
  }

  // Block private/reserved IPv4 ranges
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    if (a === 10) return { valid: false, reason: 'Private IP addresses are not allowed' };
    if (a === 172 && b >= 16 && b <= 31) return { valid: false, reason: 'Private IP addresses are not allowed' };
    if (a === 192 && b === 168) return { valid: false, reason: 'Private IP addresses are not allowed' };
    if (a === 169 && b === 254) return { valid: false, reason: 'Link-local addresses are not allowed' };
    if (a === 0) return { valid: false, reason: 'Reserved IP addresses are not allowed' };
    if (a === 127) return { valid: false, reason: 'Loopback addresses are not allowed' };
  }

  // Block common internal hostnames
  const blockedPatterns = ['internal', 'intranet', 'corp', 'metadata', '.local'];
  if (blockedPatterns.some(p => hostname.includes(p))) {
    return { valid: false, reason: 'Internal hostnames are not allowed' };
  }

  return { valid: true };
}

// Normalize theme-color to hex format
function normalizeColor(color) {
  if (!color || typeof color !== 'string') return null;
  const trimmed = color.trim();
  if (trimmed.length > 50) return null; // Guard against huge input

  if (/^#[0-9a-fA-F]{3,6}$/.test(trimmed)) return trimmed;

  const rgbMatch = trimmed.match(/^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i);
  if (rgbMatch) {
    const [, r, g, b] = rgbMatch;
    return `#${Number(r).toString(16).padStart(2, '0')}${Number(g).toString(16).padStart(2, '0')}${Number(b).toString(16).padStart(2, '0')}`;
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Method 1: __NUXT_DATA__ extraction (Sidearm/Nuxt platform — most D1 schools)
// ─────────────────────────────────────────────────────────────────────────────

const NUXT_MAX_ARRAY = 2000;
const NUXT_MAX_KEYS = 200;

// DFS resolver — mutates `seen` in-place (add before recurse, delete after).
// This avoids the O(n) Set copy on every call while still detecting cycles.
function resolveNuxt(arr, v, depth, seen) {
  if (depth > 8 || !Number.isInteger(v) || v < 0 || v >= arr.length) return v;
  if (seen.has(v)) return v; // cycle
  seen.add(v);
  const val = arr[v];
  let result;
  if (Array.isArray(val)) {
    const items = val.length > NUXT_MAX_ARRAY ? val.slice(0, NUXT_MAX_ARRAY) : val;
    result = items.map(x => resolveNuxt(arr, x, depth + 1, seen));
  } else if (val && typeof val === 'object') {
    const keys = Object.keys(val);
    const limited = keys.length > NUXT_MAX_KEYS ? keys.slice(0, NUXT_MAX_KEYS) : keys;
    result = Object.fromEntries(limited.map(k => [k, resolveNuxt(arr, val[k], depth + 1, seen)]));
  } else {
    result = val;
  }
  seen.delete(v); // allow revisit via different path
  return result;
}

function extractFromNuxtData(html) {
  const match = html.match(/<script[^>]+id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return [];

  let arr;
  try {
    arr = JSON.parse(match[1]);
  } catch {
    return [];
  }

  if (!Array.isArray(arr) || arr.length > 100000) return [];

  const keyDict = arr.find(x =>
    x && typeof x === 'object' && !Array.isArray(x) &&
    Object.keys(x).some(k => k.startsWith('roster-') && k.includes('players-list'))
  );
  if (!keyDict) return [];

  const playersKey = Object.keys(keyDict).find(k => k.includes('players-list'));
  const listObj = resolveNuxt(arr, keyDict[playersKey], 0, new Set());
  if (!Array.isArray(listObj?.players) || listObj.players.length === 0) return [];

  return listObj.players
    .map(ref => {
      const p = resolveNuxt(arr, ref, 0, new Set());
      const player = p.player || {};
      const pos = p.player_position || {};
      const cls = p.class_level || {};
      const first = player.first_name || '';
      const last = player.last_name || '';
      const name = `${first} ${last}`.trim();
      if (!name) return null;
      const number = p.jersey_number || 0;
      const hFt = p.height_feet || player.height_feet || '';
      const hIn = p.height_inches || player.height_inches || '';
      return {
        name,
        number,
        position: normalizePosition(pos.abbreviation || ''),
        year: normalizeYear(cls.name || ''),
        height: (hFt && hIn) ? `${hFt}-${hIn}` : '',
        weight: (p.weight || player.weight) ? `${p.weight || player.weight} lbs` : '',
        hometown: player.hometown || '',
        highSchool: player.high_school || '',
        previousSchool: player.previous_school || '',
        url: player.slug ? `/sports/football/roster/player/${player.slug}` : ''
      };
    })
    .filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared static extraction: Methods 2 (table) + 3 (card layout)
// ─────────────────────────────────────────────────────────────────────────────

function extractFromHtml(html, baseUrl) {
  const $ = cheerio.load(html);
  const players = [];

  const tables = $('table');
  tables.each((tableIdx, table) => {
    if (players.length > 0) return;

    const $table = $(table);
    const rows = $table.find('tbody tr');
    if (rows.length < 5) return;

    const headerRow = $table.find('thead tr, tr').first();
    const headers = headerRow.find('th, td').map((i, el) => $(el).text().trim().toLowerCase()).get();

    let colMap = { number: -1, name: -1, position: -1, year: -1, height: -1, weight: -1, hometown: -1, highSchool: -1, previousSchool: -1 };

    headers.forEach((h, idx) => {
      if (h.includes('#') || h === 'no' || h === 'no.' || h === 'number') colMap.number = idx;
      else if (h === 'name' || h === 'player') colMap.name = idx;
      else if (h === 'pos' || h === 'pos.' || h === 'position') colMap.position = idx;
      else if (h === 'yr' || h === 'yr.' || h === 'year' || h === 'class' || h === 'cl.' || h === 'elig') colMap.year = idx;
      else if (h === 'ht' || h === 'ht.' || h === 'height') colMap.height = idx;
      else if (h === 'wt' || h === 'wt.' || h === 'weight') colMap.weight = idx;
      else if (h.includes('hometown') || h.includes('home')) colMap.hometown = idx;
      else if (h.includes('high school') || h.includes('hs') || h === 'previous school') colMap.highSchool = idx;
      else if (h.includes('previous') || h.includes('last school')) colMap.previousSchool = idx;
    });

    if (colMap.name === -1 && headers.length >= 3) {
      colMap = { number: 0, name: 1, position: 2, year: 3, height: 4, weight: 5, hometown: 6, highSchool: 7, previousSchool: 8 };
    }

    rows.each((i, row) => {
      const cells = $(row).find('td');
      if (cells.length < 3) return;

      const getCellLink = (idx) => {
        if (idx < 0 || idx >= cells.length) return '';
        const link = cells.eq(idx).find('a').attr('href');
        return link ? (link.startsWith('http') ? link : baseUrl + link) : '';
      };

      let nameIdx = -1, name = '', playerUrl = '';

      for (let c = 0; c < cells.length; c++) {
        const cell = cells.eq(c);
        const link = cell.find('a');
        if (link.length > 0) {
          const href = link.attr('href') || '';
          const linkText = link.text().trim().split('\n')[0].trim();
          if (href.includes('/roster/') || href.includes('/player/') || href.includes('/sports/')) {
            if (linkText && linkText.includes(' ') && !/^[A-Z]{2,4}$/.test(linkText)) {
              name = linkText.replace(/\s*(Twitter|Instagram|Facebook|Opens in|X Opens|Inflcr).*$/i, '').trim();
              playerUrl = href.startsWith('http') ? href : baseUrl + href;
              nameIdx = c;
              break;
            }
          }
        }
      }

      if (!name) {
        for (let c = 0; c < cells.length; c++) {
          const fullCellText = cells.eq(c).text().trim();
          if (/Twitter|Instagram|X Opens|Inflcr/i.test(fullCellText)) {
            let extractedName = fullCellText
              .replace(/\s*(Twitter|Instagram|Facebook|X Opens|Inflcr|Opens in a new window).*$/gi, '')
              .trim();
            if (extractedName &&
                /^[A-Z][a-z]+\s+[A-Z]/.test(extractedName) &&
                !/,/.test(extractedName) &&
                !/\(/.test(extractedName)) {
              name = extractedName;
              nameIdx = c;
              playerUrl = getCellLink(c);
              break;
            }
          }
        }
      }

      if (!name) {
        for (let c = 0; c < cells.length; c++) {
          const rawText = cells.eq(c).text().trim().split('\n')[0].trim();
          if (rawText.length > 100) continue; // Skip obviously-bad cells early (also guards against ReDoS)
          const cellText = rawText.replace(/\s*(Twitter|Instagram|Facebook|Opens in|X Opens|Inflcr).*$/i, '').trim();
          if (cellText && cellText.includes(' ') &&
              !/^\d+$/.test(cellText) &&
              !/^(QB|RB|WR|TE|OL|DL|LB|CB|S|K|P|LS|DE|DT|OT|OG|C|FB|ATH|DB|NT|Fr|So|Jr|Sr|Gr|Freshman|Sophomore|Junior|Senior|Graduate|Redshirt)\.?$/i.test(cellText) &&
              !/^Redshirt\s+(Freshman|Sophomore|Junior|Senior)$/i.test(cellText) &&
              !/^\d+-\d+$/.test(cellText) &&
              !/^\d+\s*lbs?$/i.test(cellText) &&
              !/^[A-Z][a-z]+,\s+[A-Z]/.test(cellText)) {
            name = cellText;
            nameIdx = c;
            playerUrl = getCellLink(c);
            break;
          }
        }
      }

      let numberText = '';
      for (let c = 0; c < Math.min(3, cells.length); c++) {
        const cellText = cells.eq(c).text().trim();
        if (/^\d{1,2}$/.test(cellText)) { numberText = cellText; break; }
      }

      let position = '';
      for (let c = 0; c < cells.length; c++) {
        if (c === nameIdx) continue;
        const cellText = cells.eq(c).text().trim();
        if (cellText.length <= 6 && /^(QB|RB|WR|TE|OL|DL|LB|CB|S|K|P|LS|DE|DT|OT|OG|C|FB|ATH|DB|NT|ILB|OLB|FS|SS|WDE|SDE|MLB)$/i.test(cellText)) {
          position = cellText; break;
        }
      }

      let year = '';
      for (let c = 0; c < cells.length; c++) {
        if (c === nameIdx) continue;
        const cellText = cells.eq(c).text().trim();
        if (cellText.length <= 20 && (
            /^(Fr|So|Jr|Sr|Gr|Freshman|Sophomore|Junior|Senior|Graduate|Redshirt|R-Fr|R-So|R-Jr|R-Sr|RS|RED|SOP|JUN|SEN|FRE)\.?$/i.test(cellText) ||
            /^(Redshirt\s+)?(Freshman|Sophomore|Junior|Senior)$/i.test(cellText))) {
          year = cellText; break;
        }
      }

      let height = '';
      for (let c = 0; c < cells.length; c++) {
        const cellText = cells.eq(c).text().trim();
        if (/^\d+-\d{1,2}$/.test(cellText) || /^\d+'\s*\d+"?$/.test(cellText)) { height = cellText; break; }
      }

      let weight = '';
      for (let c = 0; c < cells.length; c++) {
        const cellText = cells.eq(c).text().trim();
        if (/^\d{2,3}\s*lbs?\.?$/i.test(cellText) || /^\d{3}$/.test(cellText)) { weight = cellText; break; }
      }

      const number = parseInt(numberText) || 0;
      if (!name || name.toLowerCase() === 'name' || name.toLowerCase() === 'player' || name.length < 2) return;
      if (/^[A-Z]{1,3}$/.test(name) && /^(QB|RB|WR|TE|OL|DL|LB|CB|S|K|P|LS|DE|DT|OT|OG|C|FB|ATH|DB|NT)$/i.test(name)) return;

      let hometown = '', highSchool = '', previousSchool = '';
      const usedIndices = new Set();
      cells.each((c, cell) => {
        const cellText = $(cell).text().trim();
        if (cellText === numberText || cellText === name || cellText === position ||
            cellText === year || cellText === height || cellText === weight) {
          usedIndices.add(c);
        }
      });

      let extraFields = [];
      cells.each((c, cell) => {
        if (!usedIndices.has(c)) {
          const cellText = $(cell).text().trim().split('\n')[0].trim()
            .replace(/\s*(Twitter|Instagram|Facebook|Opens in|X Opens|Inflcr).*$/i, '').trim();
          if (cellText && cellText.length > 1 &&
              !/^(QB|RB|WR|TE|OL|DL|LB|CB|S|K|P|Name|Pos|Position|Yr|Year|Ht|Wt|\#|No)\.?$/i.test(cellText)) {
            extraFields.push(cellText);
          }
        }
      });

      if (extraFields.length > 0) hometown = extraFields[0] || '';
      if (extraFields.length > 1) highSchool = extraFields[1] || '';
      if (extraFields.length > 2) previousSchool = extraFields[2] || '';

      players.push({ name, number, position: normalizePosition(position), year: normalizeYear(year), height: height || '', weight: weight || '', hometown, highSchool, previousSchool, url: playerUrl });
    });
  });

  if (players.length === 0) {
    const playerCards = $('.s-person-card, .roster-player, .player-card, [class*="roster"] [class*="player"]');
    playerCards.each((i, card) => {
      const $card = $(card);
      const name = $card.find('.s-person-details__personal-single-line, .player-name, .name, h3, h4').first().text().trim();
      const numberText = $card.find('.s-person-card__header__jersey-number, .jersey-number, .number').text().trim();
      const position = $card.find('.s-person-details__bio-stats-item:contains("Position"), .position').text().replace(/Position:?\s*/i, '').trim() ||
                       $card.find('[class*="position"]').text().trim();
      const year = $card.find('.s-person-details__bio-stats-item:contains("Year"), .year, .class').text().replace(/Year:?\s*/i, '').trim();
      const link = $card.find('a').attr('href');
      const number = parseInt(numberText) || 0;
      if (name) {
        players.push({
          name, number,
          position: normalizePosition(position),
          year: normalizeYear(year),
          height: '', weight: '', hometown: '', highSchool: '', previousSchool: '',
          url: link ? (link.startsWith('http') ? link : baseUrl + link) : ''
        });
      }
    });
  }

  return players;
}

// ─────────────────────────────────────────────────────────────────────────────
// Method 4: Puppeteer fallback (headless Chrome, slow — last resort)
// ─────────────────────────────────────────────────────────────────────────────

const CHROMIUM_URL = 'https://github.com/Sparticuz/chromium/releases/download/v121.0.0/chromium-v121.0.0-pack.tar';

async function extractWithPuppeteer(url) {
  const chromium = (await import('@sparticuz/chromium-min')).default;
  const puppeteer = (await import('puppeteer-core')).default;

  const executablePath = await chromium.executablePath(CHROMIUM_URL);
  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath,
    headless: chromium.headless,
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');
    // Use domcontentloaded + 20s timeout.
    // networkidle0 hangs indefinitely on pages with analytics pings.
    // 20s leaves a 40s buffer before Vercel's 60s maxDuration.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    return await page.content();
  } finally {
    await browser.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────────────────────

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_URL_LENGTH = 2048;

export default async function handler(req, res) {
  const allowedOrigins = [
    'https://depth-chart-builder.vercel.app',
    'http://localhost:3000',
    'http://127.0.0.1:3000'
  ];
  const origin = req.headers.origin || '';
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Rate limiting — Vercel sets x-forwarded-for reliably from its edge layer
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
  if (isRateLimited(clientIp)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a minute before trying again.' });
  }

  // Validate request body
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({ error: 'Request body must be JSON' });
  }

  const { url } = req.body;

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'URL is required' });
  }

  if (url.length > MAX_URL_LENGTH) {
    return res.status(400).json({ error: `URL must be under ${MAX_URL_LENGTH} characters` });
  }

  // Validate URL to prevent SSRF
  const urlCheck = validateUrl(url);
  if (!urlCheck.valid) {
    return res.status(400).json({ error: urlCheck.reason });
  }

  try {
    console.log(`Fetching roster from: ${url}`);

    // Fetch the page HTML — manual redirect so we can validate the final destination
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });

    // Validate the final URL after redirects to block redirect-chain SSRF
    if (response.url && response.url !== url) {
      const finalCheck = validateUrl(response.url);
      if (!finalCheck.valid) {
        return res.status(400).json({ error: 'URL redirected to a disallowed destination' });
      }
    }

    if (!response.ok) {
      return res.status(400).json({ error: `Could not fetch that page (HTTP ${response.status}). Check the URL and try again.` });
    }

    // Guard against huge responses (e.g. 100MB HTML pages)
    const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
    if (contentLength > MAX_RESPONSE_BYTES) {
      return res.status(400).json({ error: 'The page is too large to process.' });
    }

    const html = await response.text();
    if (html.length > MAX_RESPONSE_BYTES) {
      return res.status(400).json({ error: 'The page is too large to process.' });
    }

    // Extract team info from static HTML
    const $ = cheerio.load(html);
    const baseUrl = new URL(url).origin;
    let teamName = 'Unknown Team';

    const teamSelectors = [
      'meta[property="og:site_name"]',
      '.school-name',
      '.site-header__logo-text',
      'title'
    ];

    for (const selector of teamSelectors) {
      const el = $(selector);
      if (el.length) {
        const content = selector.includes('meta') ? el.attr('content') : el.text();
        if (content && content.trim()) {
          teamName = content.trim().replace(/\s*(Football\s*)?Roster.*/i, '').trim();
          if (teamName) break;
        }
      }
    }

    let primaryColor = '#1a1a2e';
    let secondaryColor = '#ffffff';

    const themeColor = $('meta[name="theme-color"]').attr('content');
    const normalizedColor = normalizeColor(themeColor);
    if (normalizedColor) {
      primaryColor = normalizedColor;
    }

    // ── Method 1: __NUXT_DATA__ (Sidearm/Nuxt — most D1 schools) ──
    let players = extractFromNuxtData(html);
    if (players.length > 0) {
      console.log(`Method 1 (__NUXT_DATA__): extracted ${players.length} players`);
    }

    // ── Methods 2 & 3: HTML table + card layout ──
    if (players.length === 0) {
      players = extractFromHtml(html, baseUrl);
      if (players.length > 0) {
        console.log(`Method 2/3 (static HTML): extracted ${players.length} players`);
      }
    }

    // ── Method 4: Puppeteer (JS-rendered pages) ──
    if (players.length === 0) {
      console.log('Static extraction failed — launching Puppeteer');
      try {
        const renderedHtml = await extractWithPuppeteer(url);
        players = extractFromNuxtData(renderedHtml);
        if (players.length > 0) {
          console.log(`Method 4 (Puppeteer + __NUXT_DATA__): extracted ${players.length} players`);
        } else {
          players = extractFromHtml(renderedHtml, baseUrl);
          if (players.length > 0) {
            console.log(`Method 4 (Puppeteer + static HTML): extracted ${players.length} players`);
          }
        }
      } catch (puppeteerError) {
        console.error('Puppeteer failed:', puppeteerError.message);
      }
    }

    if (players.length === 0) {
      return res.status(400).json({
        error: 'Could not find roster data on this page. The site may have a non-standard structure.',
        suggestion: 'Try using the manual import option instead.'
      });
    }

    console.log(`Successfully extracted ${players.length} players`);

    return res.status(200).json({
      team: { name: teamName, primaryColor, secondaryColor, rosterUrl: url },
      roster: players
    });

  } catch (error) {
    // Log internally but don't expose error.message to the client —
    // it can contain internal paths, IP addresses, or binary paths.
    console.error('Scraping error:', error);
    return res.status(500).json({
      error: 'Failed to scrape roster. The site may block automated requests or require JavaScript rendering.',
      suggestion: 'Try using the manual import option instead.'
    });
  }
}

function normalizePosition(pos) {
  if (!pos) return 'Unknown';
  const posMap = {
    'QUARTERBACK': 'QB', 'RUNNING BACK': 'RB', 'WIDE RECEIVER': 'WR',
    'TIGHT END': 'TE', 'OFFENSIVE LINE': 'OL', 'OFFENSIVE LINEMAN': 'OL',
    'OFFENSIVE TACKLE': 'OT', 'OFFENSIVE GUARD': 'OG', 'CENTER': 'C',
    'DEFENSIVE LINE': 'DL', 'DEFENSIVE LINEMAN': 'DL', 'DEFENSIVE END': 'DE',
    'DEFENSIVE TACKLE': 'DT', 'LINEBACKER': 'LB', 'CORNERBACK': 'CB',
    'SAFETY': 'S', 'KICKER': 'K', 'PUNTER': 'P', 'LONG SNAPPER': 'LS',
    'KICK RETURNER': 'KR', 'PUNT RETURNER': 'PR', 'ATHLETE': 'ATH',
    'DEFENSIVE BACK': 'DB', 'NOSE TACKLE': 'NT', 'GUARD': 'OG',
    'TACKLE': 'OT', 'FULLBACK': 'FB', 'HALFBACK': 'RB'
  };
  const upper = pos.toUpperCase().trim();
  return posMap[upper] || pos.toUpperCase().replace(/[^A-Z]/g, '').substring(0, 3) || 'Unknown';
}

function normalizeYear(year) {
  if (!year) return 'Unknown';
  const yearMap = {
    'FRESHMAN': 'Fr.', 'SOPHOMORE': 'So.', 'JUNIOR': 'Jr.', 'SENIOR': 'Sr.',
    'REDSHIRT FRESHMAN': 'R-Fr.', 'REDSHIRT SOPHOMORE': 'R-So.',
    'REDSHIRT JUNIOR': 'R-Jr.', 'REDSHIRT SENIOR': 'R-Sr.',
    'RS FRESHMAN': 'R-Fr.', 'RS SOPHOMORE': 'R-So.',
    'RS JUNIOR': 'R-Jr.', 'RS SENIOR': 'R-Sr.',
    'R-FRESHMAN': 'R-Fr.', 'R-SOPHOMORE': 'R-So.',
    'R-JUNIOR': 'R-Jr.', 'R-SENIOR': 'R-Sr.',
    'GRADUATE': 'Gr.', 'GRAD': 'Gr.', 'GRADUATE STUDENT': 'Gr.',
    'FR': 'Fr.', 'SO': 'So.', 'JR': 'Jr.', 'SR': 'Sr.',
    'FR.': 'Fr.', 'SO.': 'So.', 'JR.': 'Jr.', 'SR.': 'Sr.',
    'GR': 'Gr.', 'GR.': 'Gr.',
    'SOP': 'So.', 'JUN': 'Jr.', 'SEN': 'Sr.', 'FRE': 'Fr.',
    'RED': 'R-Fr.', 'RSO': 'R-So.', 'RJR': 'R-Jr.', 'RSR': 'R-Sr.'
  };
  const upper = year.toUpperCase().trim();
  return yearMap[upper] || year || 'Unknown';
}
