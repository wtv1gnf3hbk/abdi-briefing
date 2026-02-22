#!/usr/bin/env node
/**
 * V1 — Single-pass Levant briefing writer
 *
 * Reads briefing.json (from generate-briefing.js), calls Claude API
 * to generate a conversational briefing, outputs index.html + briefing.md.
 *
 * Requires: ANTHROPIC_API_KEY environment variable
 */

const https = require('https');
const fs = require('fs');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY environment variable');
  process.exit(1);
}

// ============================================
// CLAUDE API CALL
// ============================================

function callClaude(prompt, systemPrompt = '') {
  return new Promise((resolve, reject) => {
    const messages = [{ role: 'user', content: prompt }];

    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 3000,
      system: systemPrompt,
      messages
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            reject(new Error(json.error.message));
          } else {
            resolve(json.content[0].text);
          }
        } catch (e) {
          reject(new Error('Failed to parse API response: ' + data.slice(0, 200)));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(120000, () => {
      req.destroy();
      reject(new Error('API timeout'));
    });

    req.write(body);
    req.end();
  });
}

// ============================================
// TIMEZONE UTILITIES
// ============================================

function formatTimestamp(timezone = 'Africa/Nairobi') {
  const now = new Date();

  const dateStr = now.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: timezone
  });

  const timeStr = now.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: timezone
  });

  const tzAbbr = now.toLocaleTimeString('en-US', {
    timeZone: timezone,
    timeZoneName: 'short'
  }).split(' ').pop();

  return { dateStr, timeStr, tzAbbr, full: `${dateStr} at ${timeStr} ${tzAbbr}` };
}

// ============================================
// MARKDOWN → HTML CONVERSION
// ============================================

// Done OUTSIDE the template literal to avoid escaping nightmares.
// Handles: **bold**, [links](url), • bullets, - bullets, paragraphs, section headers
function markdownToHTML(md) {
  // Step 1: Convert markdown links to <a> tags
  let html = md.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

  // Step 2: Convert **bold** to <strong>
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Step 3: Convert ## headers to section headers
  html = html.replace(/^## (.+)$/gm, '<p class="section-header"><strong>$1</strong></p>');

  // Step 4: Process line by line
  const lines = html.split('\n');
  const output = [];
  let inList = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Bullet lines: match both "• " and "- " prefixes
    const bulletMatch = trimmed.match(/^[•\-\*] (.+)$/);
    if (bulletMatch) {
      if (!inList) {
        output.push('<ul>');
        inList = true;
      }
      output.push(`<li>${bulletMatch[1]}</li>`);
      continue;
    }

    // Close list if we were in one
    if (inList) {
      output.push('</ul>');
      inList = false;
    }

    // Empty lines: skip (spacing handled by CSS)
    if (!trimmed) continue;

    // Section headers (bold text on its own line, already converted to <strong>)
    if (trimmed.match(/^<strong>[^<]+<\/strong>$/) && !trimmed.includes('<a ')) {
      output.push(`<p class="section-header">${trimmed}</p>`);
      continue;
    }

    // Already has HTML tags from ## conversion
    if (trimmed.startsWith('<p class="section-header">')) {
      output.push(trimmed);
      continue;
    }

    // Regular paragraph
    output.push(`<p>${trimmed}</p>`);
  }

  // Close any trailing list
  if (inList) output.push('</ul>');

  return output.join('\n');
}

// ============================================
// HTML GENERATION
// ============================================

function generateHTML(briefingText, config) {
  const timezone = config.metadata?.timezone || 'Africa/Nairobi';
  const timestamp = formatTimestamp(timezone);
  const title = config.metadata?.name || "Abdi's Briefing";
  const screenshots = config.screenshots || [];

  // Convert markdown to HTML BEFORE the template literal
  const contentHTML = markdownToHTML(briefingText);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: Georgia, 'Times New Roman', serif;
      line-height: 1.7;
      max-width: 680px;
      margin: 0 auto;
      padding: 32px 16px;
      background: #fafafa;
      color: #1a1a1a;
    }
    .header {
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid #e0e0e0;
    }
    .title {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 1.5rem;
      font-weight: 700;
      margin-bottom: 8px;
    }
    .timestamp {
      font-size: 0.85rem;
      color: #666;
    }
    .refresh-link {
      color: #666;
      text-decoration: underline;
      cursor: pointer;
    }
    h1, h2, strong {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    p { margin-bottom: 16px; }
    ul { margin: 12px 0 20px 0; padding-left: 0; list-style: none; }
    li { margin-bottom: 10px; padding-left: 16px; position: relative; }
    li::before { content: "\\2022"; position: absolute; left: 0; color: #999; }
    a {
      color: #1a1a1a;
      text-decoration: underline;
      text-decoration-color: #999;
      text-underline-offset: 2px;
    }
    a:hover { text-decoration-color: #333; }
    strong { font-weight: 600; }
    .section-header { margin-top: 24px; margin-bottom: 12px; }
    .screenshots-section {
      margin-top: 40px;
      padding-top: 24px;
      border-top: 1px solid #e0e0e0;
    }
    .screenshots-header {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 1.1rem;
      font-weight: 600;
      margin-bottom: 16px;
    }
    .screenshots-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 16px;
    }
    .screenshot-card {
      border: 1px solid #e0e0e0;
      border-radius: 8px;
      overflow: hidden;
      background: white;
    }
    .screenshot-card img {
      width: 100%;
      height: auto;
      display: block;
    }
    .screenshot-card .label {
      padding: 8px 12px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 0.85rem;
      background: #f5f5f5;
      border-top: 1px solid #e0e0e0;
    }
    .screenshot-card .label a {
      color: #666;
      text-decoration: none;
    }
    .screenshot-card .label a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="title">${title}</div>
    <div class="timestamp">
      Generated ${timestamp.full}
      \u00B7 <a class="refresh-link" onclick="refreshBriefing()">Refresh</a>
    </div>
  </div>

  <script>
    const WORKER_URL = 'https://abdi-briefing-refresh.adampasick.workers.dev';

    async function refreshBriefing() {
      const link = event.target;
      const originalText = link.textContent;

      try {
        link.textContent = 'Triggering...';
        const triggerRes = await fetch(WORKER_URL + '/trigger', { method: 'POST' });
        if (!triggerRes.ok) throw new Error('Failed to trigger');

        link.textContent = 'Starting...';
        await new Promise(r => setTimeout(r, 3000));

        link.textContent = 'Finding run...';
        const runsRes = await fetch(WORKER_URL + '/runs');
        const runsData = await runsRes.json();
        if (!runsData.workflow_runs?.length) throw new Error('No runs found');

        const runId = runsData.workflow_runs[0].id;
        const runUrl = runsData.workflow_runs[0].html_url;

        var attempts = 0;
        while (attempts < 60) {
          const statusRes = await fetch(WORKER_URL + '/status/' + runId);
          const statusData = await statusRes.json();

          if (statusData.status === 'completed') {
            if (statusData.conclusion === 'success') {
              link.textContent = 'Done! Reloading...';
              await new Promise(r => setTimeout(r, 5000));
              location.reload(true);
              return;
            } else {
              link.innerHTML = 'Failed (<a href="' + runUrl + '" target="_blank">logs</a>)';
              return;
            }
          }

          link.textContent = 'Running... ' + (attempts * 5) + 's';
          await new Promise(r => setTimeout(r, 5000));
          attempts++;
        }

        link.innerHTML = 'Timeout (<a href="' + runUrl + '" target="_blank">check</a>)';
      } catch (error) {
        console.error('Refresh error:', error);
        link.textContent = 'Error';
        setTimeout(function() { link.textContent = originalText; }, 3000);
      }
    }
  </script>

  <div id="content">
${contentHTML}
  </div>

  ${screenshots.length > 0 ? `
  <div class="screenshots-section">
    <div class="screenshots-header">Homepage Screenshots</div>
    <div class="screenshots-grid">
      ${screenshots.map(s => `
      <div class="screenshot-card">
        <a href="${s.url}" target="_blank">
          <img src="screenshots/${s.filename}" alt="${s.name}" loading="lazy">
        </a>
        <div class="label">
          <a href="${s.url}" target="_blank">${s.name}</a>
          ${s.language && s.language !== 'en' ? '<span style="color:#999">(' + s.language + ')</span>' : ''}
        </div>
      </div>
      `).join('')}
    </div>
  </div>
  ` : ''}
</body>
</html>`;
}

// ============================================
// PROMPT BUILDING
// ============================================

function buildPrompt(briefing) {
  const config = briefing.metadata || {};
  const ownerName = config.owner || 'the correspondent';
  const timezone = config.timezone || 'Africa/Nairobi';

  // Get current hour in target timezone for greeting
  const hour = new Date().toLocaleString('en-US', {
    hour: 'numeric',
    hour12: false,
    timeZone: timezone
  });
  const hourNum = parseInt(hour);

  let greeting;
  if (hourNum >= 5 && hourNum < 12) {
    greeting = 'Good morning.';
  } else if (hourNum >= 12 && hourNum < 17) {
    greeting = 'Good afternoon.';
  } else if (hourNum >= 17 && hourNum < 21) {
    greeting = 'Good evening.';
  } else {
    greeting = "Here's your briefing.";
  }

  // Organize stories for the prompt
  const stories = briefing.stories || {};
  const byCategory = stories.byCategory || {};
  const byPriority = stories.byPriority || {};
  const beatFlagged = stories.beatFlagged || [];

  // Condense for token efficiency — keep more from primary categories
  const condensed = {
    syria: (byCategory.syria || []).slice(0, 12),
    lebanon: (byCategory.lebanon || []).slice(0, 10),
    wire: (byCategory.wire || []).slice(0, 8),
    regional: (byCategory.regional || []).slice(0, 5),
    beatFlagged: beatFlagged.slice(0, 5)
  };

  const screenshots = briefing.screenshots || [];

  const systemPrompt = `You are writing a daily news briefing for ${ownerName}, an NYT correspondent covering Syria, Lebanon, and the broader Levant/Middle East.

Your job is to synthesize scraped headlines into a conversational, readable briefing. Think of it as the morning email a sharp bureau chief would want before their first coffee.

SECTION STRUCTURE (in this exact order):

1. LEAD PARAGRAPH (no header, 3-5 sentences of narrative prose):
   Pick the single biggest story in the region right now. Write it through as a real paragraph — not a headline restated as a sentence. Give the reader the who, what, and WHY IT MATTERS. Add a second or third sentence of context: what led to this, what happens next, who is reacting. If multiple sources are covering the same story, synthesize them. This paragraph should feel like the top of a newspaper article, not a bullet point expanded into sentences.

   ATTRIBUTION IN THE LEAD: Name your sources explicitly. "according to Reuters", "BBC reports", "per Al Jazeera". Do not present facts without identifying where they came from.

   GOOD LEAD EXAMPLE:
   "Israeli airstrikes killed at least 10 people in eastern Lebanon overnight, including senior Hezbollah members, in the heaviest bombardment since the ceasefire took effect in November, [according to BBC](url). The strikes hit targets in the Bekaa Valley and Baalbek, Reuters [reports](url), and drew an immediate condemnation from Beirut. The escalation comes as US envoy Amos Hochstein is due in the region this week for talks on the ceasefire's future."

   BAD LEAD EXAMPLE:
   "Syrian leader Ahmed al-Sharaa has issued a general amnesty ahead of Ramadan, marking another significant gesture toward national reconciliation in the post-Assad era."
   (This is a headline with a tacked-on significance clause. No context, no stakes, no second beat.)

2. **Syria** (3-5 bullets): Government/SDF integration, security, reconstruction, governance, sanctions
3. **Lebanon** (3-5 bullets): Politics, security, Hezbollah, elections, economy
4. **Broader Levant** (2-4 bullets): Jordan, Iraq, Turkey, Iran, Israel/Palestine, refugee flows, reconstruction deals, international aid, diplomatic moves — anything that touches Syria/Lebanon or the wider region
5. **Coverage Flags** (1-2 sentences, optional): Note stories where regional Arabic-language outlets are ahead of wire services, or stories that might warrant NYT coverage. Skip entirely if nothing notable.

CRITICAL WRITING RULES:
1. NEVER use the word "amid" — find a better construction.
2. Link text must be MAX 3 WORDS.
   - GOOD: "Israel [struck eastern Lebanon](url) overnight"
   - BAD: "[Israeli strikes kill at least 10 in Lebanon](url)"
3. NEVER use 's as a contraction for "is" or "has" — only for possessives.
   - BAD: "Syria's facing" -> GOOD: "Syria is facing"
   - OK: "Syria's Interior Ministry" (possessive)
4. NEVER use em-dashes to join independent clauses. Write separate sentences.
5. Be conversational — like talking to a well-informed colleague, not headline fragments.
6. No editorializing. No "saber-rattling", "reaching a crescendo", "makes diplomats nervous". Report facts.
7. End bullets with the fact, not the implication. No "showing how...", "highlighting...", "underscoring..." clauses.
8. Every bullet must have at least one embedded link.
9. Vary attribution: "Reuters reports", "according to BBC", "per Enab Baladi", "NNA reports" (use each phrasing only once).
10. For Arabic-language sources, attribute with country: "Syria TV (Syria) reports...", "El Shark (Lebanon) reports..."
11. Do NOT pad sections. If Lebanon only has 2 real stories, write 2 bullets. Never fill space with "X called for Y at a conference" filler.`;

  const userPrompt = `${greeting} Here is what is happening across Syria, Lebanon, and the Levant:

Write the briefing using the headline data below. Follow the section structure exactly: Lead paragraph (written through, no header) > Syria > Lebanon > Broader Levant > Coverage Flags (optional).

Pick the single most consequential story for the lead paragraph — the one with the highest body count, biggest policy shift, or most geopolitical consequence. Write it as 3-5 sentences of narrative prose with real context and explicit source attribution, not a headline restated.

LEAD SELECTION PRIORITY: Stories covered by MULTIPLE sources are almost always more important than stories from a single outlet. Scan ALL categories below — Syria, Lebanon, wire, regional, AND beat-flagged — for the same event appearing in 2+ sources. That is your strongest lead candidate. ISIS/camp stories, mass displacement, and security events that appear across outlets should get special weight.

SYRIA STORIES:
${JSON.stringify(condensed.syria, null, 2)}

LEBANON STORIES:
${JSON.stringify(condensed.lebanon, null, 2)}

WIRE SERVICE STORIES (filter for Levant relevance):
${JSON.stringify(condensed.wire, null, 2)}

REGIONAL/COMPETITOR STORIES:
${JSON.stringify(condensed.regional, null, 2)}

BEAT-RELEVANT STORIES (flagged by keyword scan):
${JSON.stringify(condensed.beatFlagged, null, 2)}

HOMEPAGE SCREENSHOTS CAPTURED:
${screenshots.map(s => `- ${s.name} (${s.language || 'en'}): screenshots/${s.filename}`).join('\n')}

FEED HEALTH:
${briefing.feedHealth?.failed?.length > 0 ? `Failed sources: ${briefing.feedHealth.failed.map(f => f.name).join(', ')}` : 'All sources healthy'}

Write the briefing now. Keep it concise but comprehensive. Every bullet must have at least one link.`;

  return { systemPrompt, userPrompt };
}

// ============================================
// MAIN
// ============================================

async function main() {
  console.log('Reading briefing.json...');

  if (!fs.existsSync('briefing.json')) {
    console.error('briefing.json not found. Run generate-briefing.js first.');
    process.exit(1);
  }

  const briefing = JSON.parse(fs.readFileSync('briefing.json', 'utf8'));

  console.log(`Found ${briefing.stats?.totalStories || 0} stories`);
  console.log('');

  const { systemPrompt, userPrompt } = buildPrompt(briefing);

  console.log('Calling Claude API (V1)...');
  const startTime = Date.now();

  try {
    const briefingText = await callClaude(userPrompt, systemPrompt);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`Claude responded in ${elapsed}s`);

    // Save markdown
    fs.writeFileSync('briefing.md', briefingText);
    console.log('Saved briefing.md');

    // Save HTML
    const htmlContent = generateHTML(briefingText, briefing);
    fs.writeFileSync('index.html', htmlContent);
    console.log('Saved index.html');

    console.log('');
    console.log('V1 briefing written successfully');

  } catch (e) {
    console.error('Failed to write briefing:', e.message);
    process.exit(1);
  }
}

main();
