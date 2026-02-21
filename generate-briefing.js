#!/usr/bin/env node
/**
 * Config-driven Levant news briefing scraper
 *
 * Reads sources from sources.json and scrapes them in parallel.
 * Supports: rss (direct + Google News proxy), screenshot (Playwright)
 * Handles Arabic translation via Google Translate free API.
 *
 * Run: node generate-briefing.js
 * Output: briefing.json + screenshots/ folder
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ============================================
// CONFIGURATION
// ============================================

const CONFIG_PATH = './sources.json';
const SCREENSHOTS_DIR = './screenshots';

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`Config file not found: ${CONFIG_PATH}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

// ============================================
// FETCH UTILITIES
// ============================================

function fetchURL(url, options = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html, application/rss+xml, application/xml, text/xml',
        ...options.headers
      }
    }, (res) => {
      // Follow redirects (up to 5 hops)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const hops = (options._hops || 0) + 1;
        if (hops > 5) return reject(new Error('Too many redirects'));
        fetchURL(res.headers.location, { ...options, _hops: hops }).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(options.timeout || 15000, () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
  });
}

// ============================================
// TRANSLATION (Google Translate API - free tier)
// Translates Arabic → English for headline display
// ============================================

async function translateText(text, targetLang = 'en') {
  if (!text || text.length === 0) return text;

  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`;

  try {
    const response = await fetchURL(url);
    const data = JSON.parse(response);
    if (data && data[0]) {
      return data[0].map(item => item[0]).join('');
    }
    return text;
  } catch (e) {
    // Translation failed — return original Arabic text
    return text;
  }
}

/**
 * Detect if text contains Arabic characters
 * Arabic Unicode range: \u0600-\u06FF (basic), \u0750-\u077F (supplement),
 * \u08A0-\u08FF (extended-A), \uFB50-\uFDFF, \uFE70-\uFEFF
 */
function hasArabic(text) {
  return /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(text);
}

/**
 * Translate Arabic headlines to English.
 * Adds original Arabic in parentheses for reference.
 */
async function translateIfArabic(text) {
  if (!text) return text;
  if (!hasArabic(text)) return text;

  const translated = await translateText(text);
  // If translation looks identical to input, it failed — return original
  if (translated === text) return text;
  return translated;
}

// ============================================
// HEADLINE CLEANING
// ============================================

function cleanHeadline(text) {
  if (!text) return null;
  let h = text.trim().replace(/\s+/g, ' ');
  // Remove "X min read" tags
  h = h.replace(/^\d+\s*min\s*(read|listen)/i, '').trim();
  h = h.replace(/\d+\s*min\s*(read|listen)$/i, '').trim();
  // Allow slightly shorter headlines for Arabic sources (translated text can be terse)
  return (h.length >= 5 && h.length <= 500) ? h : null;
}

// ============================================
// GOOGLE NEWS URL EXTRACTION
// Google News RSS wraps real URLs in redirects.
// We need to extract the actual destination URL.
// ============================================

function extractGoogleNewsURL(gnUrl) {
  if (!gnUrl) return gnUrl;
  // Google News links look like: https://news.google.com/rss/articles/...
  // The actual URL is NOT directly extractable from the RSS <link> field
  // for article links. But for search RSS, the <link> inside <item>
  // often contains the real URL directly, OR a redirect that resolves.
  // For now, return as-is and let the redirect follower handle it.
  return gnUrl;
}

// ============================================
// RSS PARSER
// ============================================

function parseRSS(xml, source) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xml)) !== null && items.length < 15) {
    const itemXml = match[1];

    // Extract title — handle CDATA and plain text
    const title = (itemXml.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) ||
                   itemXml.match(/<title>(.*?)<\/title>/))?.[1]?.trim();

    // Extract link — handle CDATA, plain text, and href attribute
    let link = (itemXml.match(/<link><!\[CDATA\[(.*?)\]\]><\/link>/) ||
                itemXml.match(/<link>(.*?)<\/link>/) ||
                itemXml.match(/<link[^>]*href="([^"]+)"/))?.[1]?.trim();

    // For Google News proxy sources, the link field sometimes has
    // a news.google.com redirect. Try to extract the real URL.
    if (link && link.includes('news.google.com')) {
      link = extractGoogleNewsURL(link);
    }

    const description = (itemXml.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/) ||
                        itemXml.match(/<description>(.*?)<\/description>/))?.[1]?.trim();
    const pubDate = (itemXml.match(/<pubDate>(.*?)<\/pubDate>/))?.[1]?.trim();

    const headline = cleanHeadline(title?.replace(/<[^>]*>/g, ''));
    if (headline && link) {
      items.push({
        headline,
        url: link,
        source: source.name,
        sourceId: source.id,
        category: source.category || 'general',
        priority: source.priority || 'secondary',
        language: source.language || 'en',
        date: pubDate || null,
        description: description ? description.replace(/<[^>]*>/g, '').trim().slice(0, 300) : ''
      });
    }
  }

  // Try Atom format if RSS didn't find anything
  if (items.length === 0) {
    const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
    while ((match = entryRegex.exec(xml)) !== null && items.length < 15) {
      const entryXml = match[1];
      const title = (entryXml.match(/<title[^>]*>(.*?)<\/title>/))?.[1]?.trim();
      const link = (entryXml.match(/<link[^>]*href="([^"]+)"/))?.[1]?.trim();
      const updated = (entryXml.match(/<updated>(.*?)<\/updated>/))?.[1]?.trim();

      const headline = cleanHeadline(title?.replace(/<[^>]*>/g, ''));
      if (headline && link) {
        items.push({
          headline,
          url: link,
          source: source.name,
          sourceId: source.id,
          category: source.category || 'general',
          priority: source.priority || 'secondary',
          language: source.language || 'en',
          date: updated || null,
          description: ''
        });
      }
    }
  }

  return items;
}

// ============================================
// SCREENSHOT HANDLER (Playwright)
// ============================================

let browser = null;

async function initBrowser() {
  if (browser) return browser;

  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    return browser;
  } catch (e) {
    console.error('Failed to launch browser:', e.message);
    return null;
  }
}

async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

async function takeScreenshot(source) {
  const b = await initBrowser();
  if (!b) {
    return { ...source, screenshot: null, error: 'Browser not available' };
  }

  try {
    const page = await b.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });

    await page.goto(source.url, {
      waitUntil: 'domcontentloaded',
      timeout: 45000
    });

    // Wait for images to start loading
    await page.waitForTimeout(4000);

    if (!fs.existsSync(SCREENSHOTS_DIR)) {
      fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    }

    const filename = `${source.id}.png`;
    const filepath = path.join(SCREENSHOTS_DIR, filename);

    // Use Chrome DevTools Protocol for reliable screenshots
    // (Playwright's built-in screenshot times out on some Arabic news sites)
    const client = await page.context().newCDPSession(page);
    const result = await client.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width: 1280, height: 900, scale: 1 }
    });

    fs.writeFileSync(filepath, Buffer.from(result.data, 'base64'));
    await page.close();

    return { ...source, screenshot: filename, error: null };
  } catch (e) {
    return { ...source, screenshot: null, error: e.message };
  }
}

// ============================================
// SOURCE SCRAPING
// ============================================

async function scrapeRSSSource(source) {
  try {
    const content = await fetchURL(source.url);
    const stories = parseRSS(content, source);
    return { ...source, stories, storyCount: stories.length, error: null };
  } catch (e) {
    return { ...source, stories: [], storyCount: 0, error: e.message };
  }
}

async function scrapeSource(source) {
  if (source._comment) return null;

  switch (source.type) {
    case 'rss':
      return scrapeRSSSource(source);
    case 'screenshot':
      return takeScreenshot(source);
    default:
      return { ...source, stories: [], error: `Unknown type: ${source.type}` };
  }
}

// ============================================
// ARABIC TRANSLATION PASS
// Runs after all RSS feeds are scraped.
// Translates Arabic headlines to English in bulk.
// ============================================

async function translateArabicStories(stories) {
  const arabicStories = stories.filter(s => s.language === 'ar' && hasArabic(s.headline));
  if (arabicStories.length === 0) return stories;

  console.log(`\nTranslating ${arabicStories.length} Arabic headlines...`);

  // Translate sequentially to avoid rate limits
  for (const story of arabicStories) {
    const originalHeadline = story.headline;
    story.headline = await translateIfArabic(story.headline);
    story.originalHeadline = originalHeadline; // Keep Arabic for reference

    if (story.description && hasArabic(story.description)) {
      story.description = await translateIfArabic(story.description);
    }

    // Small delay to avoid Google Translate rate limits
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`  Translated ${arabicStories.length} headlines`);
  return stories;
}

// ============================================
// BEAT KEYWORD SCAN
// Flags stories from wire/regional sources
// that match Levant-specific keywords.
// ============================================

function scanBeatKeywords(stories, keywords) {
  const flagged = [];
  for (const story of stories) {
    if (story.category === 'wire' || story.category === 'regional') {
      const text = `${story.headline} ${story.description}`.toLowerCase();
      const matches = keywords.filter(kw => text.includes(kw.toLowerCase()));
      if (matches.length > 0) {
        story.beatRelevant = true;
        story.beatKeywords = matches;
        flagged.push(story);
      }
    }
  }
  return flagged;
}

// ============================================
// MAIN SCRAPING LOGIC
// ============================================

async function scrapeAll(config) {
  const sources = config.sources.filter(s => !s._comment);

  const rssSources = sources.filter(s => s.type === 'rss');
  const screenshotSources = sources.filter(s => s.type === 'screenshot');

  console.log(`Fetching ${rssSources.length} RSS feeds...`);

  // RSS in parallel
  const rssResults = await Promise.all(rssSources.map(s => scrapeSource(s)));

  // Log RSS results
  for (const r of rssResults) {
    if (!r) continue;
    if (r.error) {
      console.log(`  \u2717 ${r.name}: ${r.error}`);
    } else {
      console.log(`  \u2713 ${r.name} (${r.storyCount} stories)${r.language === 'ar' ? ' [AR]' : ''}`);
    }
  }

  // Screenshots sequentially (prevents browser crashes)
  console.log(`\nTaking ${screenshotSources.length} screenshots...`);
  const screenshotResults = [];
  for (const source of screenshotSources) {
    const result = await scrapeSource(source);
    screenshotResults.push(result);
    if (result.error) {
      console.log(`  \u2717 ${source.name}: ${result.error}`);
    } else {
      console.log(`  \u2713 ${source.name}`);
    }
  }

  await closeBrowser();

  // Process results
  const allResults = [...rssResults, ...screenshotResults].filter(Boolean);
  const allStories = [];
  const byCategory = {};
  const byPriority = { primary: [], secondary: [], tertiary: [] };
  const screenshots = [];
  const failed = [];

  for (const result of allResults) {
    if (result.error && !result.stories?.length) {
      failed.push({ name: result.name, error: result.error });
      continue;
    }

    // RSS stories
    if (result.stories && result.stories.length > 0) {
      for (const story of result.stories) {
        allStories.push(story);
        const cat = story.category || 'general';
        if (!byCategory[cat]) byCategory[cat] = [];
        byCategory[cat].push(story);
        const pri = story.priority || 'secondary';
        if (byPriority[pri]) byPriority[pri].push(story);
      }
    }

    // Screenshots
    if (result.screenshot) {
      screenshots.push({
        id: result.id,
        name: result.name,
        url: result.url,
        filename: result.screenshot,
        category: result.category,
        priority: result.priority,
        language: result.language || 'en'
      });
    }
  }

  // Dedupe stories by URL
  const seen = new Set();
  const deduped = allStories.filter(story => {
    if (seen.has(story.url)) return false;
    seen.add(story.url);
    return true;
  });

  // Translate Arabic headlines
  const translated = await translateArabicStories(deduped);

  // Beat keyword scan on wire/regional stories
  const beatKeywords = config.beat_keywords || [];
  const beatFlagged = scanBeatKeywords(translated, beatKeywords);
  if (beatFlagged.length > 0) {
    console.log(`\nBeat keyword matches: ${beatFlagged.length} stories flagged`);
    beatFlagged.forEach(s => {
      console.log(`  ${s.source}: "${s.headline.slice(0, 60)}..." [${s.beatKeywords.join(', ')}]`);
    });
  }

  return {
    allStories: translated,
    byCategory,
    byPriority,
    screenshots,
    failed,
    beatFlagged,
    sourceCount: sources.length,
    successCount: sources.length - failed.length
  };
}

// ============================================
// MAIN
// ============================================

async function main() {
  const config = loadConfig();

  console.log('='.repeat(50));
  console.log(`${config.metadata?.name || 'Levant Briefing'}`);
  console.log(`For: ${config.metadata?.owner || 'Unknown'}`);
  console.log(new Date().toISOString());
  console.log('='.repeat(50));
  console.log('');

  const startTime = Date.now();
  const results = await scrapeAll(config);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  const briefing = {
    metadata: {
      ...config.metadata,
      generated: new Date().toISOString(),
      generatedTimestamp: Date.now()
    },
    stats: {
      sourceCount: results.sourceCount,
      successCount: results.successCount,
      totalStories: results.allStories.length,
      totalScreenshots: results.screenshots.length,
      beatFlaggedCount: results.beatFlagged.length,
      elapsed: `${elapsed}s`
    },
    stories: {
      all: results.allStories,
      byCategory: results.byCategory,
      byPriority: results.byPriority,
      beatFlagged: results.beatFlagged
    },
    screenshots: results.screenshots,
    feedHealth: { failed: results.failed }
  };

  fs.writeFileSync('briefing.json', JSON.stringify(briefing, null, 2));

  console.log('');
  console.log('='.repeat(50));
  console.log('RESULTS');
  console.log('='.repeat(50));
  console.log(`Sources: ${results.successCount}/${results.sourceCount}`);
  console.log(`Stories: ${results.allStories.length}`);
  console.log(`Screenshots: ${results.screenshots.length}`);
  console.log(`Beat flagged: ${results.beatFlagged.length}`);

  if (results.failed.length > 0) {
    console.log(`\n\u26A0\uFE0F  ${results.failed.length} failed:`);
    results.failed.forEach(f => console.log(`   ${f.name}: ${f.error}`));
  }

  console.log(`\nTime: ${elapsed}s`);

  if (results.allStories.length === 0 && results.screenshots.length === 0) {
    console.error('\u274C FAILED: No content scraped');
    process.exit(1);
  }

  console.log('\u2705 briefing.json written');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
