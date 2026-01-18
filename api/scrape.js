import * as cheerio from 'cheerio';

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    console.log(`Fetching roster from: ${url}`);

    // Fetch the page HTML
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch page: ${response.status}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Extract team info
    const baseUrl = new URL(url).origin;
    let teamName = 'Unknown Team';

    // Try different selectors for team name
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

    // Try to extract team colors from CSS or meta tags
    let primaryColor = '#1a1a2e';
    let secondaryColor = '#ffffff';

    const themeColor = $('meta[name="theme-color"]').attr('content');
    if (themeColor) {
      primaryColor = themeColor;
    }

    // Extract roster data
    const players = [];

    // Find roster table - look for tables with player data
    const tables = $('table');

    tables.each((tableIdx, table) => {
      if (players.length > 0) return; // Already found players

      const $table = $(table);
      const rows = $table.find('tbody tr');

      if (rows.length < 5) return; // Too few rows, probably not the roster

      // Try to detect column mapping from header
      const headerRow = $table.find('thead tr, tr').first();
      const headers = headerRow.find('th, td').map((i, el) => $(el).text().trim().toLowerCase()).get();

      // Build column index mapping
      let colMap = {
        number: -1,
        name: -1,
        position: -1,
        year: -1,
        height: -1,
        weight: -1,
        hometown: -1,
        highSchool: -1,
        previousSchool: -1
      };

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

      // If we couldn't detect from headers, try common patterns
      if (colMap.name === -1) {
        // Common pattern: #, Name, Pos, Year/Class, Height, Weight, Hometown, High School
        if (headers.length >= 3) {
          colMap = { number: 0, name: 1, position: 2, year: 3, height: 4, weight: 5, hometown: 6, highSchool: 7, previousSchool: 8 };
        }
      }

      rows.each((i, row) => {
        const cells = $(row).find('td');
        if (cells.length < 3) return;

        const getCellText = (idx) => idx >= 0 && idx < cells.length ? cells.eq(idx).text().trim() : '';
        const getCellLink = (idx) => {
          if (idx < 0 || idx >= cells.length) return '';
          const link = cells.eq(idx).find('a').attr('href');
          return link ? (link.startsWith('http') ? link : baseUrl + link) : '';
        };

        // Extract data based on column mapping
        let numberText = getCellText(colMap.number);
        let name = getCellText(colMap.name);
        let playerUrl = getCellLink(colMap.name);
        let position = getCellText(colMap.position);
        let year = getCellText(colMap.year);
        let height = getCellText(colMap.height);
        let weight = getCellText(colMap.weight);
        let hometown = getCellText(colMap.hometown);
        let highSchool = getCellText(colMap.highSchool);
        let previousSchool = getCellText(colMap.previousSchool);

        // Clean up name - remove extra whitespace and social links
        name = name.split('\n')[0].trim();
        name = name.replace(/\s*(Twitter|Instagram|Facebook|Opens in|X Opens).*$/i, '').trim();

        // If name looks like a position, columns might be shifted
        if (/^(QB|RB|WR|TE|OL|DL|LB|CB|S|K|P|LS|DE|DT|OT|OG|C|FB|ATH|DB|NT)$/i.test(name)) {
          // Shift: name is in position col, position is in year col, etc.
          position = name;
          name = getCellText(colMap.position);
          if (!name || /^(QB|RB|WR|TE|OL|DL|LB|CB|S|K|P)$/i.test(name)) {
            // Try finding name in a different cell - look for cell with a link
            for (let c = 0; c < cells.length; c++) {
              const cellText = cells.eq(c).text().trim().split('\n')[0].trim();
              const hasLink = cells.eq(c).find('a').length > 0;
              if (hasLink && cellText && !/^\d+$/.test(cellText) && !/^(QB|RB|WR|TE|OL|DL|LB|CB|S|K|P|LS|DE|DT|OT|OG|FR|SO|JR|SR|GR)$/i.test(cellText)) {
                name = cellText.replace(/\s*(Twitter|Instagram|Facebook|Opens in|X Opens).*$/i, '').trim();
                playerUrl = getCellLink(c);
                break;
              }
            }
          }
        }

        // If number is empty but first cell has a number, use it
        if (!numberText || !/^\d+$/.test(numberText)) {
          for (let c = 0; c < Math.min(3, cells.length); c++) {
            const cellText = cells.eq(c).text().trim();
            if (/^\d{1,2}$/.test(cellText)) {
              numberText = cellText;
              break;
            }
          }
        }

        const number = parseInt(numberText) || 0;

        // Skip if no valid name or name is a header
        if (!name || name.toLowerCase() === 'name' || name.toLowerCase() === 'player' || name.length < 2) return;

        // Skip if name looks like a position abbreviation
        if (/^[A-Z]{1,3}$/.test(name) && /^(QB|RB|WR|TE|OL|DL|LB|CB|S|K|P|LS|DE|DT|OT|OG|C|FB|ATH|DB|NT)$/i.test(name)) return;

        players.push({
          name,
          number,
          position: normalizePosition(position),
          year: normalizeYear(year),
          height: height || '',
          weight: weight || '',
          hometown: hometown || '',
          highSchool: highSchool || '',
          previousSchool: previousSchool || '',
          url: playerUrl
        });
      });
    });

    // Strategy 2: Card/grid layout if no table found
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
            name,
            number,
            position: normalizePosition(position),
            year: normalizeYear(year),
            height: '',
            weight: '',
            hometown: '',
            highSchool: '',
            previousSchool: '',
            url: link ? (link.startsWith('http') ? link : baseUrl + link) : ''
          });
        }
      });
    }

    if (players.length === 0) {
      return res.status(400).json({
        error: 'Could not find roster data on this page. The site may use JavaScript rendering or have a different structure.',
        suggestion: 'Try using the manual import option instead.'
      });
    }

    console.log(`Successfully extracted ${players.length} players`);

    return res.status(200).json({
      team: {
        name: teamName,
        primaryColor,
        secondaryColor,
        rosterUrl: url
      },
      roster: players
    });

  } catch (error) {
    console.error('Scraping error:', error);
    return res.status(500).json({
      error: `Failed to scrape roster: ${error.message}`,
      suggestion: 'The site may block automated requests or use JavaScript rendering. Try using the manual import option.'
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
