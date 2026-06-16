/**
 * MilesTracker Agent — Scraper Module
 * 
 * Scrapes promo data from:
 * - Smiles Argentina (promos, millas pricing)
 * - LATAM Pass Argentina (promos, puntos)
 * - Reference blogs (Ratamundo, PromillasBlog)
 * 
 * Writes results to Firestore collections: promos, prices, history
 * 
 * Usage:
 *   node scraper.js              # Full scrape + save to Firestore
 *   node scraper.js --dry-run    # Scrape only, print results, don't save
 */

import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { initFirebase } from './firebase-init.js';

const DRY_RUN = process.argv.includes('--dry-run');
const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf-8'));

// ---- Render HTML (Playwright headless con fallback a fetch) ----
// Smiles y LATAM son SPAs: el HTML inicial viene vacío y el contenido se
// arma con JavaScript. Playwright ejecuta ese JS y nos da el HTML real.
// Si Playwright no está instalado o falla, caemos a un fetch plano para
// no romper la corrida (en ese caso lo oficial probablemente venga vacío,
// pero el scraping de blogs por RSS sigue funcionando igual).
async function renderHtml(url) {
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
      });
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(2500); // dar tiempo a banners/promos tardíos
      const html = await page.content();
      return html;
    } finally {
      await browser.close();
    }
  } catch (err) {
    console.log(`   ⚠️ Playwright no disponible o falló (${err.message}). Usando fetch plano.`);
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'es-AR,es;q=0.9'
      },
      timeout: 15000
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.text();
  }
}

// ---- Main ----
async function main() {
  console.log(`\n🕷️  MilesTracker Scraper — ${new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}`);
  console.log(`   Mode: ${DRY_RUN ? 'DRY RUN (no Firestore writes)' : 'PRODUCTION'}\n`);

  const results = {
    timestamp: new Date().toISOString(),
    smiles_promos: [],
    latam_promos: [],
    blog_promos: [],
    prices: [],
    errors: []
  };

  // 1. Scrape Smiles
  try {
    console.log('📍 Scraping Smiles Argentina...');
    const smilesPromos = await scrapeSmiles();
    results.smiles_promos = smilesPromos;
    console.log(`   → ${smilesPromos.length} promos encontradas`);
  } catch (err) {
    console.error('   ❌ Error scraping Smiles:', err.message);
    results.errors.push({ source: 'smiles', error: err.message });
  }

  // 2. Scrape LATAM Pass
  try {
    console.log('📍 Scraping LATAM Pass...');
    const latamPromos = await scrapeLatam();
    results.latam_promos = latamPromos;
    console.log(`   → ${latamPromos.length} promos encontradas`);
  } catch (err) {
    console.error('   ❌ Error scraping LATAM:', err.message);
    results.errors.push({ source: 'latam', error: err.message });
  }

  // 3. Scrape blogs
  for (const blog of config.sources.blogs) {
    try {
      console.log(`📍 Scraping ${blog.name}...`);
      const blogPromos = await scrapeBlog(blog);
      results.blog_promos.push(...blogPromos);
      console.log(`   → ${blogPromos.length} posts relevantes`);
    } catch (err) {
      console.error(`   ❌ Error scraping ${blog.name}:`, err.message);
      results.errors.push({ source: blog.name, error: err.message });
    }
  }

  // Summary
  const totalPromos = results.smiles_promos.length + results.latam_promos.length + results.blog_promos.length;
  console.log(`\n📊 Resumen: ${totalPromos} promos totales, ${results.errors.length} errores\n`);

  // 4. Save to Firestore
  if (!DRY_RUN) {
    console.log('💾 Guardando en Firestore...');
    await saveToFirestore(results);
    console.log('   ✅ Datos guardados.\n');
  } else {
    console.log('🔍 Resultados (dry-run):');
    console.log(JSON.stringify(results, null, 2));
  }

  return results;
}

// ---- Smiles Scraper ----
async function scrapeSmiles() {
  const promos = [];

  try {
    // Render Smiles promos page (Playwright para ejecutar el JS de la SPA)
    const html = await renderHtml(config.sources.smiles.promos_url);
    const $ = cheerio.load(html);

    // Look for promo cards/sections
    // Note: Smiles page structure may change — these selectors need periodic updates
    $('[class*="promo"], [class*="Promo"], [class*="banner"], [class*="Banner"], [class*="offer"], [class*="Offer"]').each((i, el) => {
      const title = $(el).find('h2, h3, h4, [class*="title"], [class*="Title"]').first().text().trim();
      const description = $(el).find('p, [class*="desc"], [class*="Desc"], [class*="text"]').first().text().trim();
      const link = $(el).find('a').first().attr('href') || '';

      if (title && title.length > 5) {
        // Try to extract bonus percentage
        const bonusMatch = (title + ' ' + description).match(/(\d{2,3})\s*%/);
        const bonus = bonusMatch ? parseInt(bonusMatch[1]) : null;

        promos.push({
          source: 'smiles',
          program: 'smiles',
          title: title.substring(0, 200),
          description: description.substring(0, 500),
          bonus_pct: bonus,
          url: link.startsWith('http') ? link : `https://www.smiles.com.ar${link}`,
          detected_at: new Date().toISOString(),
          is_active: true
        });
      }
    });

    // If no promos found via selectors, try generic text search
    if (promos.length === 0) {
      const bodyText = $('body').text();
      const promoPatterns = [
        /(\d{2,3})%\s*(de\s+)?bonus/gi,
        /(\d{2,3})%\s*(de\s+)?descuento/gi,
        /comprar?\s+millas.*?(\d{2,3})%/gi,
        /hot\s*sale/gi,
        /cyber\s*monday/gi,
        /travel\s*sale/gi
      ];

      for (const pattern of promoPatterns) {
        const matches = bodyText.match(pattern);
        if (matches) {
          for (const match of matches.slice(0, 3)) {
            const numMatch = match.match(/(\d{2,3})/);
            promos.push({
              source: 'smiles',
              program: 'smiles',
              title: `Promo Smiles detectada: ${match.trim().substring(0, 100)}`,
              description: `Texto detectado automáticamente en smiles.com.ar`,
              bonus_pct: numMatch ? parseInt(numMatch[1]) : null,
              url: config.sources.smiles.promos_url,
              detected_at: new Date().toISOString(),
              is_active: true
            });
          }
        }
      }
    }
  } catch (err) {
    // Add a placeholder so we know the scan happened
    console.log(`   ⚠️ Could not fully scrape Smiles: ${err.message}`);
  }

  return promos;
}

// ---- LATAM Pass Scraper ----
async function scrapeLatam() {
  const promos = [];

  try {
    // Render LATAM Pass page (Playwright para ejecutar el JS de la SPA)
    const html = await renderHtml(config.sources.latam.promos_url);
    const $ = cheerio.load(html);

    // LATAM Pass page parsing
    $('[class*="promo"], [class*="banner"], [class*="offer"], [class*="campaign"], [class*="benefit"]').each((i, el) => {
      const title = $(el).find('h2, h3, h4, [class*="title"]').first().text().trim();
      const desc = $(el).find('p, [class*="desc"], [class*="text"]').first().text().trim();
      const link = $(el).find('a').first().attr('href') || '';

      if (title && title.length > 5) {
        const bonusMatch = (title + ' ' + desc).match(/(\d{2,3})\s*%/);
        promos.push({
          source: 'latam',
          program: 'latam',
          title: title.substring(0, 200),
          description: desc.substring(0, 500),
          bonus_pct: bonusMatch ? parseInt(bonusMatch[1]) : null,
          url: link.startsWith('http') ? link : `https://www.latamairlines.com${link}`,
          detected_at: new Date().toISOString(),
          is_active: true
        });
      }
    });

    // Generic text search fallback
    if (promos.length === 0) {
      const bodyText = $('body').text();
      const patterns = [
        /(\d{2,3})%\s*(de\s+)?bonus/gi,
        /comprar?\s+puntos/gi,
        /puntos\s+latam.*?(\d{2,3})%/gi
      ];

      for (const pattern of patterns) {
        const matches = bodyText.match(pattern);
        if (matches) {
          for (const match of matches.slice(0, 3)) {
            const numMatch = match.match(/(\d{2,3})/);
            promos.push({
              source: 'latam',
              program: 'latam',
              title: `Promo LATAM detectada: ${match.trim().substring(0, 100)}`,
              description: 'Texto detectado automáticamente en latamairlines.com',
              bonus_pct: numMatch ? parseInt(numMatch[1]) : null,
              url: config.sources.latam.promos_url,
              detected_at: new Date().toISOString(),
              is_active: true
            });
          }
        }
      }
    }
  } catch (err) {
    console.log(`   ⚠️ Could not fully scrape LATAM: ${err.message}`);
  }

  return promos;
}

// ---- Blog Scraper (RSS/HTML) ----
async function scrapeBlog(blog) {
  const promos = [];

  try {
    const url = blog.rss || blog.url;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html,application/xml,application/rss+xml',
      },
      timeout: 15000
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const text = await res.text();

    // Try RSS parsing first
    if (text.includes('<rss') || text.includes('<feed') || text.includes('<item>')) {
      const $ = cheerio.load(text, { xmlMode: true });

      $('item, entry').each((i, el) => {
        if (i >= 10) return; // Limit to 10 recent posts

        const title = $(el).find('title').first().text().trim();
        const desc = $(el).find('description, summary, content\\:encoded').first().text().trim();
        const link = $(el).find('link').first().text().trim() || $(el).find('link').first().attr('href') || '';
        const pubDate = $(el).find('pubDate, published, updated').first().text().trim();

        // Filter: only posts about promos, millas, bonus, etc.
        const relevantKeywords = /promo|bonus|millas|descuento|hot\s*sale|cyber|travel\s*sale|comprar|oferta|smiles|latam/i;
        if (relevantKeywords.test(title + ' ' + desc)) {
          const bonusMatch = (title + ' ' + desc).match(/(\d{2,3})\s*%/);
          promos.push({
            source: blog.name,
            program: /latam/i.test(title + desc) ? 'latam' : 'smiles',
            title: title.substring(0, 200),
            description: stripHtml(desc).substring(0, 500),
            bonus_pct: bonusMatch ? parseInt(bonusMatch[1]) : null,
            url: link,
            detected_at: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
            is_active: true
          });
        }
      });
    } else {
      // HTML fallback — look for article/post elements
      const $ = cheerio.load(text);
      $('article, [class*="post"], [class*="entry"]').each((i, el) => {
        if (i >= 10) return;
        const title = $(el).find('h2 a, h3 a, [class*="title"] a').first().text().trim();
        const link = $(el).find('h2 a, h3 a, [class*="title"] a').first().attr('href') || '';

        const relevantKeywords = /promo|bonus|millas|descuento|hot\s*sale|cyber|smiles|latam/i;
        if (title && relevantKeywords.test(title)) {
          promos.push({
            source: blog.name,
            program: /latam/i.test(title) ? 'latam' : 'smiles',
            title: title.substring(0, 200),
            description: `Vía ${blog.name}`,
            bonus_pct: null,
            url: link.startsWith('http') ? link : `${blog.url}${link}`,
            detected_at: new Date().toISOString(),
            is_active: true
          });
        }
      });
    }
  } catch (err) {
    console.log(`   ⚠️ Could not scrape ${blog.name}: ${err.message}`);
  }

  return promos;
}

// ---- Save to Firestore ----
async function saveToFirestore(results) {
  const db = initFirebase();
  const batch = db.batch();
  const now = new Date();

  // Deactivate old promos (older than 7 days)
  const oldPromos = await db.collection('promos')
    .where('is_active', '==', true)
    .get();

  for (const doc of oldPromos.docs) {
    const data = doc.data();
    const detectedAt = data.detected_at ? new Date(data.detected_at) : now;
    const daysSince = (now - detectedAt) / (1000 * 60 * 60 * 24);
    if (daysSince > 7) {
      batch.update(doc.ref, { is_active: false });
    }
  }

  // Add new promos (deduplicate by title)
  const existingTitles = new Set(oldPromos.docs.map(d => d.data().title));
  const allPromos = [...results.smiles_promos, ...results.latam_promos, ...results.blog_promos];

  for (const promo of allPromos) {
    if (!existingTitles.has(promo.title)) {
      const ref = db.collection('promos').doc();
      batch.set(ref, {
        ...promo,
        detected_at: now
      });
    }
  }

  // Save scan history
  const officialCount = results.smiles_promos.length + results.latam_promos.length;
  const histRef = db.collection('history').doc();
  batch.set(histRef, {
    type: 'scan',
    date: now,
    total_promos_found: allPromos.length,
    official_count: officialCount,
    smiles_count: results.smiles_promos.length,
    latam_count: results.latam_promos.length,
    blog_count: results.blog_promos.length,
    errors: results.errors,
    timestamp: now.toISOString()
  });

  await batch.commit();

  // Chequeo de salud del agente
  await checkAgentHealth(db, officialCount);
}

// ---- Health check: avisar si el scraping oficial dejó de funcionar ----
// Si dos scans seguidos no encuentran NINGUNA promo oficial (Smiles+LATAM),
// es muy probable que cambiaron el HTML o que Playwright está fallando.
// Encolamos un email de aviso (una sola vez por racha).
async function checkAgentHealth(db, currentOfficialCount) {
  try {
    const snap = await db.collection('history')
      .orderBy('date', 'desc')
      .limit(10)
      .get();

    const scans = snap.docs
      .map(d => d.data())
      .filter(d => d.type === 'scan');

    // scans[0] es el scan actual (recién commiteado), scans[1] el anterior.
    const prev = scans[1];
    const alreadyAlerted = scans.slice(2, 4).some(s => s.health_alerted);

    if (currentOfficialCount === 0 && prev && prev.official_count === 0 && !alreadyAlerted) {
      console.log('   🚨 Dos scans seguidos sin promos oficiales — encolando alerta de agente roto.');
      const email = config.notifications.email;
      if (email && email !== 'YOUR_EMAIL@gmail.com') {
        await db.collection('mail').add({
          to: email,
          message: {
            subject: '⚠️ MilesTracker: el scraping oficial podría estar roto',
            html: `
              <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
                <div style="background:#b45309;color:white;padding:20px;border-radius:12px 12px 0 0">
                  <h1 style="margin:0;font-size:20px">⚠️ MilesTracker — Aviso técnico</h1>
                </div>
                <div style="background:white;padding:24px;border:1px solid #e2e8f0;border-radius:0 0 12px 12px">
                  <p>Los últimos dos scans no encontraron <strong>ninguna promo oficial</strong> de Smiles ni LATAM.</p>
                  <p>Posibles causas: Smiles/LATAM cambiaron la estructura de su página, o Playwright no está instalado/funcionando en el runner.</p>
                  <p style="font-size:13px;color:#666">Las promos detectadas vía blogs (RSS) siguen funcionando. Conviene revisar los selectores del scraper o la instalación de Playwright.</p>
                  <p style="color:#999;font-size:12px;margin-top:16px">${new Date().toISOString()}</p>
                </div>
              </div>`
          },
          createdAt: new Date()
        });
        // Marcar el scan actual como ya alertado para no repetir en cada corrida.
        const current = snap.docs.find(d => d.data().type === 'scan');
        if (current) await current.ref.update({ health_alerted: true });
      }
    }
  } catch (err) {
    console.log(`   ⚠️ No se pudo ejecutar el health check: ${err.message}`);
  }
}

// ---- Utility ----
function stripHtml(html) {
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

// ---- Run (solo si se ejecuta directamente, no al importar para tests) ----
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(err => {
    console.error('💥 Fatal error:', err);
    process.exit(1);
  });
}

export { main as scrape, stripHtml };
