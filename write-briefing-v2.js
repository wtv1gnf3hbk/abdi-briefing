#!/usr/bin/env node
/**
 * V2 — 3-pass Levant briefing writer (Write → Edit → Revise)
 *
 * Drop-in upgrade from write-briefing.js with editorial quality layers.
 * Reads briefing.json, makes 3 sequential Claude API calls, outputs
 * briefing-v2/index.html + briefing-v2/briefing.md.
 *
 * Pass 1 (Write):  Generate draft from headline data
 * Pass 2 (Edit):   Proofread, enforce style rules, check source diversity
 * Pass 3 (Revise): Apply edits, produce final briefing
 *
 * ~3-5x token cost of V1, ~2-3x wall clock time.
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

function callClaude(prompt, systemPrompt = '', maxTokens = 3000) {
  return new Promise((resolve, reject) => {
    const messages = [{ role: 'user', content: prompt }];

    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
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
    req.setTimeout(180000, () => {
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
  <title>${title} (V2)</title>
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
    .version-badge {
      display: inline-block;
      font-size: 0.7rem;
      background: #333;
      color: #fff;
      padding: 2px 6px;
      border-radius: 3px;
      vertical-align: middle;
      margin-left: 8px;
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
    <div class="title">${title}<span class="version-badge">V2</span></div>
    <div class="timestamp">
      Generated ${timestamp.full}
      · <a class="refresh-link" onclick="refreshBriefing()">Refresh</a>
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
          <img src="../screenshots/${s.filename}" alt="${s.name}" loading="lazy">
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
// PASS 1: WRITE
// ============================================

function buildWritePrompt(briefing) {
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

  // Organize stories — keep more from primary categories
  const stories = briefing.stories || {};
  const byCategory = stories.byCategory || {};
  const beatFlagged = stories.beatFlagged || [];

  const condensed = {
    syria: (byCategory.syria || []).slice(0, 12),
    lebanon: (byCategory.lebanon || []).slice(0, 10),
    wire: (byCategory.wire || []).slice(0, 8),
    regional: (byCategory.regional || []).slice(0, 5),
    beatFlagged: beatFlagged.slice(0, 5)
  };

  const screenshots = briefing.screenshots || [];

  const systemPrompt = `You are writing a daily news briefing for ${ownerName}, an NYT correspondent covering Syria, Lebanon, and the broader Levant/Middle East.

Your job is to synthesize scraped headlines into a conversational, readable briefing focused on Syria, Lebanon, and regional developments.

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
// PASS 2: EDIT
// ============================================

function buildEditPrompt(draft, briefing) {
  const stories = briefing.stories || {};
  const byCategory = stories.byCategory || {};

  // Build a source summary for fact-checking
  const sourceSummary = [];
  for (const [cat, items] of Object.entries(byCategory)) {
    sourceSummary.push(`${cat.toUpperCase()} (${items.length} stories):`);
    items.slice(0, 5).forEach(s => {
      sourceSummary.push(`  - "${s.headline}" [${s.source}] ${s.url || ''}`);
    });
  }

  const systemPrompt = `You are a senior editor reviewing a Levant news briefing for an NYT correspondent covering Syria and Lebanon. Your job is line-level quality control.`;

  const userPrompt = `Review this Levant briefing draft against the source data below. Produce a numbered list of specific issues found.

Check EVERY one of these:

1. FACT-CHECK: Is every claim, number, name, and attribution traceable to the source data? Flag anything embellished, conflated, or unsupported.

2. STYLE - CONTRACTIONS: Search for any use of "'s" as a contraction for "is" or "has" (e.g., "Syria's facing", "the ceasefire's holding"). Possessive "'s" is fine (e.g., "Syria's interior ministry", "Lebanon's parliament"). List every violation with the exact text.

3. STYLE - "AMID": Flag any use of the word "amid".

4. STYLE - EM-DASHES: Flag any em-dash (—) or hyphen used to join two independent clauses.

5. LINKS: Check that (a) every link text is MAX 3 words, and (b) every bullet point has at least one markdown link.

6. TONE: Flag any bullet that reads like a dry headline summary rather than conversational prose. Also flag any editorializing ("saber-rattling", "makes diplomats nervous", "reaching a crescendo").

7. SECTION COVERAGE (BLOCKING): Are Syria, Lebanon, and Broader Levant sections all present? Both Syria and Lebanon MUST have content. If either is missing, this is a BLOCKING issue. Coverage Flags is optional.

12. LEAD QUALITY (BLOCKING): Is the lead paragraph 3-5 sentences of written-through prose with context, stakes, and source attribution? Or is it a single sentence that restates a headline? If it reads like "X announced Y, marking a significant step toward Z" — that is a BAD lead. Flag it and suggest how to expand with context and a second beat. This is a BLOCKING issue.

8. SOURCE DIVERSITY (BLOCKING): Extract every markdown link URL from the draft. Count how many unique outlet domains appear. AT LEAST 3 different news outlet domains must appear across the entire briefing. If the quota is not met, list which source stories from the data below should be added. This is a BLOCKING issue.

9. ATTRIBUTION: For every link, check that there is explicit source attribution nearby ("according to BBC", "Reuters reports", "per Enab Baladi", "NNA reports"). Flag any link missing attribution text.

10. ARABIC SOURCE QUALITY: For stories sourced from Arabic-language outlets, verify the translation quality seems reasonable and the country attribution is present (e.g., "Syria TV (Syria) reports", "El Shark (Lebanon) reports").

11. "ADD CONTEXT" CLAUSES: Flag any bullet that ends with implications rather than facts ("showing how...", "highlighting...", "underscoring...", "which could mean..."). Bullets should end with the fact.

SOURCE DATA:
${sourceSummary.join('\n')}

DRAFT TO REVIEW:
${draft}

List every issue found, with exact quotes and specific fixes. If no issues for a category, say "Clean." Be thorough — this is the quality gate before publication.`;

  return { systemPrompt, userPrompt };
}

// ============================================
// PASS 3: REVISE
// ============================================

function buildRevisePrompt(draft, editFeedback) {
  const systemPrompt = `You are revising a Levant news briefing based on editorial feedback. Apply every fix listed below to produce the final, clean briefing.`;

  const userPrompt = `Apply all fixes from the editorial feedback to produce the final briefing.

RULES:
- Apply all fixes from the editorial feedback
- Do not add new content beyond what the fixes require
- Do not remove content unless the feedback specifically says to
- Preserve the overall structure and tone
- Output ONLY the final briefing text — no commentary, no "here is the revised version", just the briefing itself

CURRENT DRAFT:
${draft}

EDITORIAL FEEDBACK:
${editFeedback}

Output the final revised briefing now.`;

  return { systemPrompt, userPrompt };
}

// ============================================
// MAIN
// ============================================

async function main() {
  console.log('='.repeat(50));
  console.log('Levant Briefing V2 — 3-Pass Chain');
  console.log(new Date().toISOString());
  console.log('='.repeat(50));
  console.log('');

  console.log('Reading briefing.json...');

  if (!fs.existsSync('briefing.json')) {
    console.error('briefing.json not found. Run generate-briefing.js first.');
    process.exit(1);
  }

  const briefing = JSON.parse(fs.readFileSync('briefing.json', 'utf8'));

  console.log(`Found ${briefing.stats?.totalStories || 0} stories`);
  console.log(`Categories: ${Object.keys(briefing.stories?.byCategory || {}).join(', ')}`);
  console.log('');

  const totalStart = Date.now();

  try {
    // ---- PASS 1: WRITE ----
    console.log('Pass 1/3: Writing draft...');
    const writeStart = Date.now();
    const { systemPrompt: writeSys, userPrompt: writeUser } = buildWritePrompt(briefing);
    const draft = await callClaude(writeUser, writeSys, 3000);
    const writeTime = ((Date.now() - writeStart) / 1000).toFixed(1);
    console.log(`   Done in ${writeTime}s (${draft.length} chars)`);

    // ---- PASS 2: EDIT ----
    console.log('Pass 2/3: Editing draft...');
    const editStart = Date.now();
    const { systemPrompt: editSys, userPrompt: editUser } = buildEditPrompt(draft, briefing);
    const editFeedback = await callClaude(editUser, editSys, 2000);
    const editTime = ((Date.now() - editStart) / 1000).toFixed(1);
    console.log(`   Done in ${editTime}s`);

    // Log edit findings for visibility
    const issueCount = (editFeedback.match(/\d+\./g) || []).length;
    console.log(`   Found ~${issueCount} items to review`);

    // Check for blocking issues
    const hasBlocking = editFeedback.toLowerCase().includes('blocking');
    if (hasBlocking) {
      console.log('   *** BLOCKING issues found — revise pass will address them ***');
    }

    // ---- PASS 3: REVISE ----
    console.log('Pass 3/3: Revising...');
    const reviseStart = Date.now();
    const { systemPrompt: reviseSys, userPrompt: reviseUser } = buildRevisePrompt(draft, editFeedback);
    const finalBriefing = await callClaude(reviseUser, reviseSys, 3000);
    const reviseTime = ((Date.now() - reviseStart) / 1000).toFixed(1);
    console.log(`   Done in ${reviseTime}s`);

    const totalTime = ((Date.now() - totalStart) / 1000).toFixed(1);

    // Save outputs to briefing-v2/ for separate URL
    fs.mkdirSync('briefing-v2', { recursive: true });

    fs.writeFileSync('briefing-v2/briefing.md', finalBriefing);
    console.log('\nSaved briefing-v2/briefing.md');

    const htmlContent = generateHTML(finalBriefing, briefing);
    fs.writeFileSync('briefing-v2/index.html', htmlContent);
    console.log('Saved briefing-v2/index.html');

    // Also save the intermediate edit feedback for debugging
    fs.writeFileSync('briefing-v2/edit-feedback.txt', editFeedback);
    console.log('Saved briefing-v2/edit-feedback.txt');

    console.log(`\nV2 briefing complete in ${totalTime}s (write: ${writeTime}s, edit: ${editTime}s, revise: ${reviseTime}s)`);

  } catch (e) {
    console.error('Failed to write V2 briefing:', e.message);
    process.exit(1);
  }
}

main();
