const fs = require('fs');
const path = require('path');

const ROSTER_FILE = path.join(__dirname, 'roster.json');
const TEAM_FILE = path.join(__dirname, 'team.json');
const HTML_FILE = path.join(__dirname, '..', 'index.html');

function updateHtml() {
  console.log('Reading roster data...');

  if (!fs.existsSync(ROSTER_FILE)) {
    console.error('Roster file not found. Run scrape-roster.js first.');
    console.error('Usage: node scrape-roster.js <roster-url>');
    process.exit(1);
  }

  const roster = JSON.parse(fs.readFileSync(ROSTER_FILE, 'utf8'));

  if (!Array.isArray(roster) || roster.length === 0) {
    console.error('Invalid or empty roster data.');
    process.exit(1);
  }

  console.log(`Loaded ${roster.length} players from roster.json`);

  // Load team info if available
  let team = null;
  if (fs.existsSync(TEAM_FILE)) {
    team = JSON.parse(fs.readFileSync(TEAM_FILE, 'utf8'));
    console.log(`Team: ${team.name}`);
  }

  // Format roster as JavaScript array
  const rosterJs = roster.map(player => {
    // Escape single quotes in string fields
    const safeName = (player.name || '').replace(/'/g, "\\'");
    const safeHometown = (player.hometown || '').replace(/'/g, "\\'");
    const safeHighSchool = (player.highSchool || '').replace(/'/g, "\\'");
    const safePreviousSchool = (player.previousSchool || '').replace(/'/g, "\\'");
    const safeUrl = player.url || '';

    return `      { name: '${safeName}', number: ${player.number}, position: '${player.position}', year: '${player.year}', height: '${player.height || ''}', weight: '${player.weight || ''}', hometown: '${safeHometown}', highSchool: '${safeHighSchool}', previousSchool: '${safePreviousSchool}', url: '${safeUrl}' }`;
  }).join(',\n');

  const newRosterBlock = `const DEFAULT_ROSTER = [\n${rosterJs}\n    ];`;

  console.log('Reading index.html...');
  let html = fs.readFileSync(HTML_FILE, 'utf8');

  // Find and replace the DEFAULT_ROSTER array
  const rosterRegex = /const DEFAULT_ROSTER = \[[\s\S]*?\];/;

  if (!rosterRegex.test(html)) {
    console.error('Could not find DEFAULT_ROSTER in index.html');
    process.exit(1);
  }

  html = html.replace(rosterRegex, newRosterBlock);

  // Update team info if available
  if (team) {
    const teamRegex = /const DEFAULT_TEAM = \{[\s\S]*?\};/;
    const safeName = (team.name || 'Your Team').replace(/'/g, "\\'");
    const newTeamBlock = `const DEFAULT_TEAM = {
      name: '${safeName}',
      primaryColor: '${team.primaryColor || '#1a1a2e'}',
      secondaryColor: '${team.secondaryColor || '#ffffff'}',
      rosterUrl: '${team.rosterUrl || ''}'
    };`;

    if (teamRegex.test(html)) {
      html = html.replace(teamRegex, newTeamBlock);
      console.log('Updated team configuration');
    }
  }

  console.log('Writing updated index.html...');
  fs.writeFileSync(HTML_FILE, html);

  console.log('Successfully updated index.html with new roster data!');
  if (team) {
    console.log(`Team: ${team.name}`);
    console.log(`Players: ${roster.length}`);
  }
}

updateHtml();
