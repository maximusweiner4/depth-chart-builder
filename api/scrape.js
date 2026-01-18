const cheerio = require('cheerio');

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

    // Look for theme color meta tag
    const themeColor = $('meta[name="theme-color"]').attr('content');
    if (themeColor) {
      primaryColor = themeColor;
    }

    // Extract roster data
    const players = [];

    // Strategy 1: Sidearm Sports table format (Penn State, Ohio State, etc.)
    const rosterTable = $('.sidearm-roster-players-container table tbody tr, .roster-players table tbody tr, table.roster tbody tr');

    if (rosterTable.length > 0) {
      rosterTable.each((i, row) => {
        const cells = $(row).find('td');
        if (cells.length >= 3) {
          const numberCell = cells.eq(0).text().trim();
          const nameLink = cells.eq(1).find('a');
          const name = nameLink.length ? nameLink.text().trim() : cells.eq(1).text().trim();
          const playerUrl = nameLink.length ? baseUrl + nameLink.attr('href') : '';
          const position = cells.eq(2).text().trim();
          const year = cells.length > 3 ? cells.eq(3).text().trim() : '';
          const height = cells.length > 4 ? cells.eq(4).text().trim() : '';
          const weight = cells.length > 5 ? cells.eq(5).text().trim() : '';
          const hometown = cells.length > 6 ? cells.eq(6).text().trim() : '';
          const highSchool = cells.length > 7 ? cells.eq(7).text().trim() : '';
          const previousSchool = cells.length > 8 ? cells.eq(8).text().trim() : '';

          const number = parseInt(numberCell) || 0;

          if (name && name !== 'Name') {
            players.push({
              name,
              number,
              position: normalizePosition(position),
              year: normalizeYear(year),
              height,
              weight,
              hometown,
              highSchool,
              previousSchool,
              url: playerUrl
            });
          }
        }
      });
    }

    // Strategy 2: Card/grid layout
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

    // Strategy 3: Simple list/table without specific classes
    if (players.length === 0) {
      $('table tr').each((i, row) => {
        const cells = $(row).find('td');
        if (cells.length >= 2) {
          const text = cells.map((j, cell) => $(cell).text().trim()).get();
          // Look for number, name, position pattern
          const numberMatch = text.find(t => /^\d{1,2}$/.test(t));
          const positionMatch = text.find(t => /^(QB|RB|WR|TE|OL|OT|OG|C|DL|DE|DT|LB|CB|S|K|P|LS|ATH)$/i.test(t));

          if (numberMatch !== undefined && positionMatch) {
            const numberIdx = text.indexOf(numberMatch);
            const posIdx = text.indexOf(positionMatch);
            const nameIdx = numberIdx + 1;

            if (nameIdx < text.length && nameIdx !== posIdx) {
              players.push({
                name: text[nameIdx],
                number: parseInt(numberMatch) || 0,
                position: normalizePosition(positionMatch),
                year: '',
                height: '',
                weight: '',
                hometown: '',
                highSchool: '',
                previousSchool: '',
                url: ''
              });
            }
          }
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
};

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
    'GR': 'Gr.', 'GR.': 'Gr.'
  };
  const upper = year.toUpperCase().trim();
  return yearMap[upper] || year || 'Unknown';
}
