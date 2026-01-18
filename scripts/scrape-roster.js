const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// Get roster URL from command line argument
const ROSTER_URL = process.argv[2];

if (!ROSTER_URL) {
  console.error('Usage: node scrape-roster.js <roster-url>');
  console.error('Example: node scrape-roster.js https://example.com/sports/football/roster');
  process.exit(1);
}

// Map website positions to our app's position codes
const positionMap = {
  'QB': 'QB',
  'RB': 'RB',
  'FB': 'RB',
  'WR': 'WR',
  'TE': 'TE',
  'OL': 'OL',
  'OT': 'OL',
  'OG': 'OL',
  'C': 'OL',
  'DL': 'DT',
  'DT': 'DT',
  'NT': 'DT',
  'DE': 'DE',
  'LB': 'LB',
  'ILB': 'LB',
  'OLB': 'LB',
  'MLB': 'LB',
  'DB': 'CB',
  'CB': 'CB',
  'S': 'S',
  'SS': 'S',
  'FS': 'S',
  'K': 'K',
  'PK': 'K',
  'P': 'P',
  'LS': 'LS',
  'SNP': 'LS'
};

// Map full year names to abbreviated codes
const yearMap = {
  'freshman': 'Fr.',
  'sophomore': 'So.',
  'junior': 'Jr.',
  'senior': 'Sr.',
  'redshirt freshman': 'R-Fr.',
  'redshirt sophomore': 'R-So.',
  'redshirt junior': 'R-Jr.',
  'redshirt senior': 'R-Sr.',
  'graduate': 'Grad',
  'graduate student': 'Grad',
  'grad': 'Grad',
  '5th year': 'Sr.',
  '6th year': 'Grad'
};

async function scrapeRoster() {
  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();

    // Set a realistic user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    console.log(`Navigating to ${ROSTER_URL}...`);
    await page.goto(ROSTER_URL, {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    // Wait for page to fully load
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Save page HTML for debugging
    const html = await page.content();
    fs.writeFileSync(path.join(__dirname, 'page-debug.html'), html);
    console.log('Saved page HTML to page-debug.html');

    // Extract team information
    console.log('Extracting team information...');
    const teamInfo = await page.evaluate(() => {
      // Try to get team name from various sources
      let teamName = '';
      let primaryColor = '#041E42'; // Default navy
      let secondaryColor = '#FFFFFF';

      // Try meta tags
      const ogSiteName = document.querySelector('meta[property="og:site_name"]');
      if (ogSiteName) {
        teamName = ogSiteName.getAttribute('content') || '';
      }

      // Try page title
      if (!teamName) {
        const title = document.title || '';
        // Extract team name from title like "Football Roster - Ohio State Buckeyes"
        const match = title.match(/(?:Roster|Football).*?[-–]\s*(.+?)(?:\s*(?:Official|Athletics))?$/i);
        if (match) {
          teamName = match[1].trim();
        } else {
          teamName = title.split('-')[0].trim();
        }
      }

      // Try to find school name from header/logo
      if (!teamName || teamName.length < 3) {
        const header = document.querySelector('.site-header, header, [class*="header"]');
        if (header) {
          const logoAlt = header.querySelector('img')?.alt;
          if (logoAlt) teamName = logoAlt;
        }
      }

      // Try to extract colors from CSS variables or computed styles
      const root = document.documentElement;
      const computedStyle = getComputedStyle(root);

      // Check for CSS variables
      const primaryVar = computedStyle.getPropertyValue('--primary-color') ||
                         computedStyle.getPropertyValue('--school-primary') ||
                         computedStyle.getPropertyValue('--brand-primary');
      if (primaryVar) primaryColor = primaryVar.trim();

      // Try to get colors from header or prominent elements
      const headerEl = document.querySelector('.site-header, header, [class*="navbar"]');
      if (headerEl) {
        const bgColor = getComputedStyle(headerEl).backgroundColor;
        if (bgColor && bgColor !== 'rgba(0, 0, 0, 0)' && bgColor !== 'transparent') {
          primaryColor = bgColor;
        }
      }

      // Get base URL for player links
      const baseUrl = window.location.origin;

      return {
        name: teamName,
        primaryColor,
        secondaryColor,
        baseUrl,
        rosterUrl: window.location.href
      };
    });

    console.log(`Team: ${teamInfo.name}`);
    console.log(`Base URL: ${teamInfo.baseUrl}`);

    console.log('Extracting roster data...');

    // Extract player data from the page
    const players = await page.evaluate(() => {
      const playerList = [];

      // Target the roster table specifically (not staff table)
      // The roster table is inside .roster-players section
      const rosterSection = document.querySelector('.roster-players, .s-person-listing, [class*="roster-list"], table[class*="roster"]');

      // Try table extraction first
      const tableRows = rosterSection
        ? rosterSection.querySelectorAll('table tbody tr')
        : document.querySelectorAll('.roster-players table tbody tr, [class*="roster"] table tbody tr, table.sidearm-table tbody tr');

      console.log(`Found ${tableRows.length} table rows`);

      if (tableRows.length > 0) {
        tableRows.forEach(row => {
          // Get all cells (td and th)
          const cells = row.querySelectorAll('td, th');
          if (cells.length < 3) return;

          // Try to find jersey number - usually first cell or has specific class
          let number = 0;
          let numberCell = row.querySelector('[class*="number"], [class*="jersey"]');
          if (numberCell) {
            number = parseInt(numberCell.textContent.trim()) || 0;
          } else {
            const firstCellText = cells[0]?.textContent?.trim() || '';
            if (/^\d{1,2}$/.test(firstCellText)) {
              number = parseInt(firstCellText);
            }
          }

          // Get name and URL from the link
          const nameLink = row.querySelector('a[href*="/roster/"], a[href*="/player/"], a.table__roster-name');
          const name = nameLink?.textContent?.trim() || '';
          const playerUrl = nameLink?.getAttribute('href') || '';

          // Get position - look for cell with position abbreviation
          let position = '';
          const posRegex = /\b(QB|RB|FB|WR|TE|OL|OT|OG|DL|DT|NT|DE|LB|ILB|OLB|MLB|DB|CB|S|SS|FS|K|PK|P|LS|SNP|C|ATH)\b/i;
          for (const cell of cells) {
            const text = cell.textContent.trim();
            if (text.length <= 4 && posRegex.test(text)) {
              position = text.toUpperCase();
              break;
            }
          }

          // Get year/class
          let year = '';
          const yearRegex = /\b(Fr\.|So\.|Jr\.|Sr\.|Freshman|Sophomore|Junior|Senior|R-Fr\.|R-So\.|R-Jr\.|R-Sr\.|Redshirt\s+(?:Freshman|Sophomore|Junior|Senior)|Graduate|Grad|GR)\b/i;
          for (const cell of cells) {
            const match = cell.textContent.match(yearRegex);
            if (match) {
              year = match[1];
              break;
            }
          }

          // Get height - look for pattern like 6-2, 5-11
          let height = '';
          const heightRegex = /\b(\d['′']-\d{1,2})\b/;
          for (const cell of cells) {
            const match = cell.textContent.match(heightRegex);
            if (match) {
              height = match[1];
              break;
            }
          }

          // Get weight - look for pattern like 195 lbs, 220
          let weight = '';
          const weightRegex = /\b(\d{2,3})\s*(?:lbs?\.?|pounds?)?\b/i;
          for (const cell of cells) {
            const text = cell.textContent;
            if (text.includes('lbs') || text.includes('lb') || /^\d{3}$/.test(text.trim())) {
              const match = text.match(weightRegex);
              if (match) {
                weight = match[1] + ' lbs';
                break;
              }
            }
          }

          // Get hometown
          let hometown = '';
          const hometownCell = Array.from(cells).find(cell => {
            const text = cell.textContent;
            return text.includes(',') && /[A-Z][a-z]+,\s*[A-Z]/.test(text);
          });
          if (hometownCell) {
            hometown = hometownCell.textContent.trim();
          }

          // Get high school (usually after hometown)
          let highSchool = '';
          let previousSchool = '';

          if (name && name.length > 2 && name.length < 50 && !name.toLowerCase().includes('roster')) {
            playerList.push({
              name,
              number,
              position,
              year,
              height,
              weight,
              hometown,
              highSchool,
              previousSchool,
              playerUrl
            });
          }
        });
      }

      // If table extraction failed, try card-based extraction
      if (playerList.length === 0) {
        const playerCards = document.querySelectorAll('.s-person-card, [class*="player-card"], [class*="roster-card"], .sidearm-roster-player');
        console.log(`Found ${playerCards.length} player cards`);

        playerCards.forEach(card => {
          const nameEl = card.querySelector('a[href*="/roster/"], a[href*="/player/"], [class*="name"]');
          const name = nameEl?.textContent?.trim() || '';
          const playerUrl = nameEl?.getAttribute('href') || '';

          const text = card.textContent;

          const numMatch = text.match(/#(\d{1,2})/);
          const number = numMatch ? parseInt(numMatch[1]) : 0;

          const posMatch = text.match(/\b(QB|RB|FB|WR|TE|OL|OT|OG|DL|DT|NT|DE|LB|ILB|OLB|MLB|DB|CB|S|SS|FS|K|PK|P|LS|SNP|C|ATH)\b/i);
          const position = posMatch ? posMatch[1].toUpperCase() : '';

          const yearMatch = text.match(/\b(Fr\.|So\.|Jr\.|Sr\.|Freshman|Sophomore|Junior|Senior|R-Fr\.|R-So\.|R-Jr\.|R-Sr\.|Graduate|Grad)\b/i);
          const year = yearMatch ? yearMatch[1] : '';

          const heightMatch = text.match(/\b(\d['′']-\d{1,2})\b/);
          const height = heightMatch ? heightMatch[1] : '';

          const weightMatch = text.match(/\b(\d{2,3})\s*lbs?\b/i);
          const weight = weightMatch ? weightMatch[1] + ' lbs' : '';

          if (name && name.length > 2 && name.length < 50) {
            playerList.push({
              name,
              number,
              position,
              year,
              height,
              weight,
              hometown: '',
              highSchool: '',
              previousSchool: '',
              playerUrl
            });
          }
        });
      }

      // If still no players, try generic link extraction
      if (playerList.length === 0) {
        const playerLinks = document.querySelectorAll('a[href*="/sports/football/roster/player/"], a[href*="/roster/player/"]');
        console.log(`Found ${playerLinks.length} player links`);

        playerLinks.forEach(link => {
          const name = link.textContent.trim();
          const playerUrl = link.getAttribute('href') || '';
          const container = link.closest('tr, li, article, [class*="card"], [class*="player"]');
          const text = container?.textContent || '';

          const numMatch = text.match(/#?(\d{1,2})\b/);
          const number = numMatch ? parseInt(numMatch[1]) : 0;

          const posMatch = text.match(/\b(QB|RB|FB|WR|TE|OL|OT|OG|DL|DT|NT|DE|LB|ILB|OLB|MLB|DB|CB|S|SS|FS|K|PK|P|LS|SNP|C|ATH)\b/i);
          const position = posMatch ? posMatch[1].toUpperCase() : '';

          const yearMatch = text.match(/\b(Fr\.|So\.|Jr\.|Sr\.|Freshman|Sophomore|Junior|Senior|R-Fr\.|R-So\.|R-Jr\.|R-Sr\.|Graduate|Grad)\b/i);
          const year = yearMatch ? yearMatch[1] : '';

          if (name && name.length > 2 && name.length < 50 && !name.toLowerCase().includes('roster') && !name.toLowerCase().includes('bio')) {
            playerList.push({
              name,
              number,
              position,
              year,
              height: '',
              weight: '',
              hometown: '',
              highSchool: '',
              previousSchool: '',
              playerUrl
            });
          }
        });
      }

      return playerList;
    });

    if (players.length === 0) {
      console.error('No players found. The page structure may not be supported.');
      console.error('Check page-debug.html to analyze the page structure.');
      process.exit(1);
    }

    // Clean up and normalize the data
    const cleanedPlayers = players
      .filter(p => p.name && p.name.length > 2)
      .map(p => {
        // Normalize year
        const yearLower = (p.year || '').toLowerCase().trim();
        const normalizedYear = yearMap[yearLower] || p.year || 'Unknown';

        // Build full player URL
        let fullUrl = '';
        if (p.playerUrl) {
          if (p.playerUrl.startsWith('http')) {
            fullUrl = p.playerUrl;
          } else {
            fullUrl = teamInfo.baseUrl + p.playerUrl;
          }
        }

        return {
          name: p.name.replace(/\s+/g, ' ').trim(),
          number: p.number || 0,
          position: positionMap[p.position] || p.position || 'Unknown',
          year: normalizedYear,
          height: p.height || '',
          weight: p.weight || '',
          hometown: p.hometown || '',
          highSchool: p.highSchool || '',
          previousSchool: p.previousSchool || '',
          url: fullUrl
        };
      });

    // Remove duplicates
    const uniquePlayers = [];
    const seen = new Set();
    for (const p of cleanedPlayers) {
      const key = p.name.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        uniquePlayers.push(p);
      }
    }

    console.log(`Successfully extracted ${uniquePlayers.length} players`);

    // Save team info
    fs.writeFileSync(
      path.join(__dirname, 'team.json'),
      JSON.stringify(teamInfo, null, 2)
    );
    console.log('Team info saved to scripts/team.json');

    // Save roster to JSON file
    fs.writeFileSync(
      path.join(__dirname, 'roster.json'),
      JSON.stringify(uniquePlayers, null, 2)
    );
    console.log('Roster saved to scripts/roster.json');

  } catch (error) {
    console.error('Error scraping roster:', error);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

scrapeRoster();
