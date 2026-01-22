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
  'DL': 'DL',
  'DT': 'DT',
  'NT': 'DT',
  'DE': 'DE',
  'EDGE': 'DE',
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

      // Helper: Check if text looks like a school name (high school, academy, etc.)
      const looksLikeSchoolName = (text) => {
        if (!text) return false;
        const schoolPatterns = /\b(high school|h\.s\.|hs|academy|prep|school|christian|catholic|central|north|south|east|west|regional|county)\b/i;
        const stateAbbrevs = /,\s*[A-Z]{2}$/;
        return schoolPatterns.test(text) || (stateAbbrevs.test(text) && text.split(/\s+/).length > 3);
      };

      // Helper: Check if text looks like a player name
      const looksLikePlayerName = (text) => {
        if (!text || text.length < 3 || text.length > 50) return false;
        // Should be 2-4 words, mostly letters, may have Jr./Sr./II/III
        const words = text.trim().split(/\s+/);
        if (words.length < 1 || words.length > 5) return false;
        // Exclude common non-name patterns
        const excludePatterns = /\b(roster|bio|stats|schedule|news|staff|coach|coordinator|director|analyst|assistant|trainer|manager|operations|jersey\s*number|number\s*\d|full\s*bio|view\s*bio|social\s*media)\b/i;
        if (excludePatterns.test(text)) return false;
        // Should start with capital letter
        if (!/^[A-Z]/.test(text)) return false;
        // Should not be just numbers or mostly numbers
        if (/^\d+$/.test(text.replace(/\s/g, ''))) return false;
        return true;
      };

      // Helper: Check if we're in a staff/coach section
      const isInStaffSection = (element) => {
        let parent = element;
        for (let i = 0; i < 10 && parent; i++) {
          const className = parent.className || '';
          const id = parent.id || '';
          const text = parent.querySelector('h1, h2, h3, h4')?.textContent || '';
          if (/staff|coach|directory/i.test(className + id + text)) {
            return true;
          }
          parent = parent.parentElement;
        }
        return false;
      };

      // Target the roster section specifically (not staff)
      const rosterSelectors = [
        '.roster-players',
        '.s-person-listing',
        '[class*="roster-list"]',
        'table[class*="roster"]',
        '[data-roster]',
        '#roster',
        '.roster'
      ];

      let rosterSection = null;
      for (const selector of rosterSelectors) {
        const el = document.querySelector(selector);
        if (el && !isInStaffSection(el)) {
          rosterSection = el;
          break;
        }
      }

      // Try table extraction first
      const tableRows = rosterSection
        ? rosterSection.querySelectorAll('table tbody tr')
        : document.querySelectorAll('.roster-players table tbody tr, [class*="roster"] table tbody tr:not([class*="staff"]), table.sidearm-table tbody tr');

      console.log(`Found ${tableRows.length} table rows`);

      if (tableRows.length > 0) {
        tableRows.forEach(row => {
          // Skip if in staff section
          if (isInStaffSection(row)) return;

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

          // Get name and URL from the link - prioritize player-specific selectors
          // Try multiple selectors in order of specificity
          const nameSelectors = [
            'a.table__roster-name',
            'a[class*="roster-name"]',
            'a[class*="player-name"]',
            'th a[href*="/roster/"]',
            'td:nth-child(2) a[href*="/roster/"]',
            'a[href*="/roster/player/"]',
            'a[href*="/sports/football/roster/"][href*="player"]'
          ];

          let nameLink = null;
          let name = '';
          let playerUrl = '';

          for (const selector of nameSelectors) {
            nameLink = row.querySelector(selector);
            if (nameLink) {
              const candidateName = nameLink.textContent?.trim() || '';
              // Verify it looks like a player name, not a school
              if (looksLikePlayerName(candidateName) && !looksLikeSchoolName(candidateName)) {
                name = candidateName;
                playerUrl = nameLink.getAttribute('href') || '';
                break;
              }
            }
          }

          // Fallback: try any roster link but validate the name
          if (!name) {
            const allLinks = row.querySelectorAll('a[href*="/roster/"], a[href*="/player/"]');
            for (const link of allLinks) {
              const candidateName = link.textContent?.trim() || '';
              if (looksLikePlayerName(candidateName) && !looksLikeSchoolName(candidateName)) {
                name = candidateName;
                playerUrl = link.getAttribute('href') || '';
                break;
              }
            }
          }

          // Get position - look for cell with position abbreviation
          let position = '';
          const posRegex = /^(QB|RB|FB|WR|TE|OL|OT|OG|DL|DT|NT|DE|EDGE|LB|ILB|OLB|MLB|DB|CB|S|SS|FS|K|PK|P|LS|SNP|C|ATH)$/i;
          for (const cell of cells) {
            const text = cell.textContent.trim();
            if (posRegex.test(text)) {
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

          // Get height - look for pattern like 6-2, 5-11, 6'2"
          let height = '';
          const heightRegex = /\b(\d['′'"-]\d{1,2}["″]?)\b/;
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

          // Get hometown - look for City, State pattern
          let hometown = '';
          const hometownCell = Array.from(cells).find(cell => {
            const text = cell.textContent.trim();
            // Match "City, ST" or "City, State" pattern but not school names
            return /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*,\s*[A-Z]{2}(?:\s|$)/.test(text) ||
                   /^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*,\s*[A-Z][a-z]+$/.test(text);
          });
          if (hometownCell && !looksLikeSchoolName(hometownCell.textContent)) {
            hometown = hometownCell.textContent.trim();
          }

          // Get high school and previous school
          let highSchool = '';
          let previousSchool = '';

          // Look for cells that contain school-like names
          for (const cell of cells) {
            const text = cell.textContent.trim();
            if (looksLikeSchoolName(text) && text !== name) {
              if (!highSchool) {
                highSchool = text;
              } else if (!previousSchool) {
                previousSchool = text;
              }
            }
          }

          if (name && looksLikePlayerName(name)) {
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

      // If table extraction failed, try roster-list-item pattern (Iowa, Auburn, etc.)
      if (playerList.length === 0) {
        const rosterItems = document.querySelectorAll('.roster-players .roster-list-item, .roster-players-list .roster-list-item');
        console.log(`Found ${rosterItems.length} roster list items`);

        rosterItems.forEach(item => {
          // Skip staff sections
          if (isInStaffSection(item)) return;

          // Get name from title element
          const nameEl = item.querySelector('.roster-list-item__title a, .roster-list-item__title');
          const name = nameEl?.textContent?.trim() || '';

          if (!name || !looksLikePlayerName(name) || looksLikeSchoolName(name)) return;

          // Get jersey number
          const numEl = item.querySelector('.roster-list-item__jersey-number');
          const number = parseInt(numEl?.textContent?.trim()) || 0;

          // Get position
          const posEl = item.querySelector('.roster-player-list-profile-field--position, [class*="position"]');
          let position = posEl?.textContent?.trim()?.replace(/Position:?\s*/i, '').trim() || '';

          // Get year
          const yearEl = item.querySelector('.roster-player-list-profile-field--class-level, [class*="class"]');
          const year = yearEl?.textContent?.trim()?.replace(/Class:?\s*/i, '').trim() || '';

          // Get height
          const heightEl = item.querySelector('.roster-player-list-profile-field--height, [class*="height"]');
          const height = heightEl?.textContent?.trim()?.replace(/Height:?\s*/i, '').trim() || '';

          // Get weight
          const weightEl = item.querySelector('.roster-player-list-profile-field--weight, [class*="weight"]');
          const weight = weightEl?.textContent?.trim()?.replace(/Weight:?\s*/i, '').trim() || '';

          // Get hometown
          const hometownEl = item.querySelector('.roster-player-list-profile-field--hometown, [class*="hometown"]');
          const hometown = hometownEl?.textContent?.trim()?.replace(/Hometown:?\s*/i, '').trim() || '';

          // Get player URL
          const linkEl = item.querySelector('a[href*="/roster/"]');
          const playerUrl = linkEl?.getAttribute('href') || '';

          playerList.push({
            name,
            number,
            position,
            year,
            height,
            weight,
            hometown,
            highSchool: '',
            previousSchool: '',
            playerUrl
          });
        });
      }

      // Helper: Check if position indicates a coach/staff member
      const isCoachPosition = (pos) => {
        if (!pos) return false;
        const coachPatterns = /\b(coach|coordinator|director|analyst|assistant|specialist|quality|control|operations|recruiting|strength|conditioning|manager|chief|general|video|associate)\b/i;
        return coachPatterns.test(pos);
      };

      // If still no players, try card-based extraction
      if (playerList.length === 0) {
        const playerCards = document.querySelectorAll('.s-person-card, [class*="player-card"], [class*="roster-card"], .sidearm-roster-player');
        console.log(`Found ${playerCards.length} player cards`);

        playerCards.forEach(card => {
          // Skip staff sections
          if (isInStaffSection(card)) return;

          // Skip cards that link to coach pages
          const cardLink = card.querySelector('a[href*="/roster/"]');
          if (cardLink && cardLink.href && cardLink.href.includes('/coaches/')) return;

          // Try multiple name selectors - prioritize heading and specific name classes
          const nameSelectors = [
            'h3 a[href*="/roster/"]',
            'h2 a[href*="/roster/"]',
            'h4 a[href*="/roster/"]',
            '.s-person-card__content a[href*="/roster/"]',
            '.s-person-details a[href*="/roster/"]',
            '[class*="person-name"] a',
            '[class*="player-name"] a',
            'a[class*="person-name"]',
            'a[class*="player-name"]',
            'a[class*="name"][href*="/roster/"]',
            'a[href*="/roster/player/"]',
            'a[href*="/roster/"]'
          ];

          let name = '';
          let playerUrl = '';

          for (const selector of nameSelectors) {
            const el = card.querySelector(selector);
            if (el) {
              const candidateName = el.textContent?.trim() || '';
              if (looksLikePlayerName(candidateName) && !looksLikeSchoolName(candidateName)) {
                name = candidateName;
                playerUrl = el.getAttribute?.('href') || '';
                break;
              }
            }
          }

          // Fallback: look for any link that looks like a player name
          if (!name) {
            const allLinks = card.querySelectorAll('a[href*="/roster/"]');
            for (const link of allLinks) {
              const candidateName = link.textContent?.trim() || '';
              if (looksLikePlayerName(candidateName) && !looksLikeSchoolName(candidateName)) {
                name = candidateName;
                playerUrl = link.getAttribute('href') || '';
                break;
              }
            }
          }

          if (!name) return;

          const text = card.textContent;

          // Extract jersey number - try multiple patterns
          let number = 0;
          const numMatch = text.match(/(?:^|\s)#(\d{1,2})(?:\s|$)/) ||
                          text.match(/Jersey\s*Number\s*(\d{1,2})/i) ||
                          text.match(/(?:^|\s)(\d{1,2})(?:\s|$)/);
          if (numMatch) {
            number = parseInt(numMatch[1]) || 0;
          }

          // Get position - try specific element first, then regex
          let position = '';
          const posEl = card.querySelector('.s-person-details__position, .s-person-card__position span, [class*="position"]');
          if (posEl) {
            position = posEl.textContent?.trim() || '';
          }
          // If position element has full text like "Wide Receiver", try to match abbreviation
          if (!position || position.length > 10) {
            const posMatch = text.match(/\b(QB|RB|FB|WR|TE|OL|OT|OG|DL|DT|NT|DE|EDGE|LB|ILB|OLB|MLB|DB|CB|S|SS|FS|K|PK|P|LS|SNP|C|ATH)\b/i);
            position = posMatch ? posMatch[1].toUpperCase() : position;
          }

          // Skip if position indicates a coach/staff member (early check)
          if (isCoachPosition(position)) return;

          const yearMatch = text.match(/\b(Fr\.|So\.|Jr\.|Sr\.|Freshman|Sophomore|Junior|Senior|R-Fr\.|R-So\.|R-Jr\.|R-Sr\.|Graduate|Grad)\b/i);
          const year = yearMatch ? yearMatch[1] : '';

          const heightMatch = text.match(/\b(\d['′'"-]\d{1,2}["″]?)\b/);
          const height = heightMatch ? heightMatch[1] : '';

          const weightMatch = text.match(/\b(\d{2,3})\s*lbs?\b/i);
          const weight = weightMatch ? weightMatch[1] + ' lbs' : '';

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
        });
      }

      // If still no players, try generic link extraction with better filtering
      if (playerList.length === 0) {
        const playerLinks = document.querySelectorAll('a[href*="/sports/football/roster/player/"], a[href*="/roster/player/"]');
        console.log(`Found ${playerLinks.length} player links`);

        playerLinks.forEach(link => {
          // Skip staff sections
          if (isInStaffSection(link)) return;

          const candidateName = link.textContent.trim();

          // Validate name
          if (!looksLikePlayerName(candidateName) || looksLikeSchoolName(candidateName)) return;

          const name = candidateName;
          const playerUrl = link.getAttribute('href') || '';
          const container = link.closest('tr, li, article, [class*="card"], [class*="player"]');
          const text = container?.textContent || '';

          const numMatch = text.match(/#?(\d{1,2})\b/);
          const number = numMatch ? parseInt(numMatch[1]) : 0;

          const posMatch = text.match(/\b(QB|RB|FB|WR|TE|OL|OT|OG|DL|DT|NT|DE|EDGE|LB|ILB|OLB|MLB|DB|CB|S|SS|FS|K|PK|P|LS|SNP|C|ATH)\b/i);
          const position = posMatch ? posMatch[1].toUpperCase() : '';

          const yearMatch = text.match(/\b(Fr\.|So\.|Jr\.|Sr\.|Freshman|Sophomore|Junior|Senior|R-Fr\.|R-So\.|R-Jr\.|R-Sr\.|Graduate|Grad)\b/i);
          const year = yearMatch ? yearMatch[1] : '';

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
