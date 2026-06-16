/**
 * MilesTracker Agent — Optimizer Module
 * 
 * Analyzes current promos and calculates the best investment strategy
 * for each of the 3 budget scenarios.
 * 
 * Outputs:
 * - Ranking of current investment opportunities
 * - Cost per mile for each active source
 * - "Buy now vs wait" recommendation
 * - ETA to each destination goal
 * 
 * Usage:
 *   node optimizer.js              # Full analysis + save to Firestore
 *   node optimizer.js --test       # Use sample data, print results
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { initFirebase } from './firebase-init.js';
import { getUsdArs } from './exchange.js';

const TEST_MODE = process.argv.includes('--test');
const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf-8'));

// ---- Exchange rate (dólar MEP, obtenido dinámicamente en main()) ----
let ARS_PER_USD = 1200; // valor inicial; se reemplaza por el MEP real al correr

// ---- Known pricing sources ----
const SOURCES = {
  club_smiles_10k: {
    name: 'Club Smiles 10.000',
    type: 'subscription',
    monthly_cost_ars: 21600, // ~$2.16 per mile with promo
    miles_per_month: 10000,
    bonus_first_month: 200,  // 200% bonus = 30,000 first month
    program: 'smiles',
    always_available: true
  },
  club_smiles_20k: {
    name: 'Club Smiles 20.000',
    type: 'subscription',
    monthly_cost_ars: 39800,
    miles_per_month: 20000,
    bonus_first_month: 200,
    program: 'smiles',
    always_available: true
  },
  smiles_direct_purchase: {
    name: 'Compra directa Smiles',
    type: 'purchase',
    base_price_per_mile_ars: 6.5,
    program: 'smiles',
    always_available: true
  },
  galicia_quiero: {
    name: 'Puntos Quiero! (Galicia)',
    type: 'transfer',
    cost_ars: 0, // Free transfer, points from spending
    program: 'smiles',
    always_available: true,
    note: 'Depende del gasto con tarjeta Galicia'
  },
  latam_purchase: {
    name: 'Compra puntos LATAM',
    type: 'purchase',
    base_price_per_point_usd: 0.035,
    program: 'latam',
    always_available: true
  }
};

// ---- Main ----
async function main() {
  console.log(`\n📊 MilesTracker Optimizer — ${new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}`);
  console.log(`   Mode: ${TEST_MODE ? 'TEST (sample data)' : 'PRODUCTION'}\n`);

  // Obtener cotización del dólar MEP en vivo (afecta todo el cálculo de costo/milla)
  ARS_PER_USD = await getUsdArs();

  // Get active promos
  let activePromos = [];
  if (TEST_MODE) {
    activePromos = getSamplePromos();
  } else {
    const db = initFirebase();
    const snap = await db.collection('promos').where('is_active', '==', true).get();
    activePromos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  console.log(`   Promos activas: ${activePromos.length}`);

  // Tendencia histórica de bonus + precios reales más recientes por destino
  let trends = { smiles: null, latam: null };
  let realPrices = {};
  if (!TEST_MODE) {
    const db = initFirebase();
    trends = await getBonusTrends(db);
    if (trends.smiles) console.log(`   📈 Bonus Smiles — prom: ${trends.smiles.avg}% · máx histórico: ${trends.smiles.max}% (n=${trends.smiles.count})`);
    realPrices = await getLatestPrices(db);
    const realCount = Object.keys(realPrices).length;
    if (realCount) console.log(`   🎫 Precios reales disponibles para ${realCount} destino(s): ${Object.keys(realPrices).join(', ')}`);
  }

  // Analyze each scenario
  const analysis = {};
  for (const [key, scenario] of Object.entries(config.scenarios)) {
    analysis[key] = analyzeScenario(key, scenario, activePromos, realPrices);
  }

  // Generate recommendations
  const recommendations = generateRecommendations(analysis, activePromos, trends);

  const result = {
    timestamp: new Date().toISOString(),
    exchange_rate: ARS_PER_USD,
    active_promos_count: activePromos.length,
    trends,
    analysis,
    recommendations
  };

  // Output
  console.log('\n📋 RECOMENDACIONES:\n');
  for (const rec of recommendations) {
    const icon = rec.urgency === 'high' ? '🔴' : rec.urgency === 'medium' ? '🟡' : '🟢';
    console.log(`   ${icon} ${rec.title}`);
    console.log(`      ${rec.description}\n`);
  }

  // Save to Firestore
  if (!TEST_MODE) {
    const db = initFirebase();
    await db.collection('history').add({
      type: 'optimization',
      date: new Date(),
      ...result
    });
    console.log('💾 Análisis guardado en Firestore.\n');
  }

  return result;
}

// ---- Scenario Analysis ----
function analyzeScenario(key, scenario, activePromos, realPrices = {}) {
  const monthlyBudgetARS = scenario.monthly_usd * ARS_PER_USD;

  // Find the best active bonus for Smiles
  const smilesBonus = findBestBonus(activePromos, 'smiles');
  const latamBonus = findBestBonus(activePromos, 'latam');

  // Calculate miles obtainable with current sources
  const sources = [];

  // 1. Club Smiles (always first)
  const clubCost = SOURCES.club_smiles_10k.monthly_cost_ars;
  const clubMiles = SOURCES.club_smiles_10k.miles_per_month;
  const clubCostPerMile = clubCost / clubMiles;
  sources.push({
    name: 'Club Smiles 10K',
    cost_ars: clubCost,
    miles: clubMiles,
    cost_per_mile: clubCostPerMile,
    program: 'smiles',
    recommendation: 'SIEMPRE activar',
    priority: 1
  });

  // 2. Direct purchase with bonus
  const remainingBudget = monthlyBudgetARS - clubCost;
  if (remainingBudget > 0) {
    const basePrice = SOURCES.smiles_direct_purchase.base_price_per_mile_ars;
    const effectiveBonus = smilesBonus || 0;
    const baseMiles = Math.floor(remainingBudget / basePrice);
    const totalMiles = Math.floor(baseMiles * (1 + effectiveBonus / 100));
    const effectiveCostPerMile = totalMiles > 0 ? remainingBudget / totalMiles : basePrice;

    sources.push({
      name: `Compra Smiles (${effectiveBonus}% bonus)`,
      cost_ars: remainingBudget,
      miles: totalMiles,
      cost_per_mile: effectiveCostPerMile,
      program: 'smiles',
      recommendation: effectiveBonus >= 150 ? '¡COMPRÁ AHORA!' : 'Esperá mejor promo',
      priority: effectiveBonus >= 150 ? 2 : 5
    });
  }

  // 3. LATAM purchase
  if (latamBonus && latamBonus >= 50) {
    const latamBudgetUSD = Math.min(scenario.monthly_usd * 0.3, 60); // 30% of budget for LATAM
    const basePoints = Math.floor(latamBudgetUSD / SOURCES.latam_purchase.base_price_per_point_usd);
    const totalPoints = Math.floor(basePoints * (1 + latamBonus / 100));

    sources.push({
      name: `Compra LATAM (${latamBonus}% bonus)`,
      cost_ars: latamBudgetUSD * ARS_PER_USD,
      miles: totalPoints,
      cost_per_mile: (latamBudgetUSD * ARS_PER_USD) / totalPoints,
      program: 'latam',
      recommendation: latamBonus >= 100 ? 'Buen complemento' : 'Opcional',
      priority: 3
    });
  }

  // 4. Galicia Quiero! (free, but limited)
  sources.push({
    name: 'Galicia Quiero! → Smiles',
    cost_ars: 0,
    miles: 0, // Depends on credit card spending
    cost_per_mile: 0,
    program: 'smiles',
    recommendation: 'Transferir cuando haya bonus 50%+',
    priority: 4,
    note: 'Cantidad depende del gasto mensual con tarjeta Galicia'
  });

  // Sort by cost per mile (ascending)
  sources.sort((a, b) => {
    if (a.cost_per_mile === 0 && b.cost_per_mile === 0) return 0;
    if (a.cost_per_mile === 0) return -1;
    if (b.cost_per_mile === 0) return 1;
    return a.cost_per_mile - b.cost_per_mile;
  });

  // Total estimated miles
  const totalMiles = sources.reduce((acc, s) => acc + s.miles, 0);

  // ETA to destinations — usa precio REAL si está disponible; si no, el rango del config
  const etas = {};
  for (const [destKey, dest] of Object.entries(config.destinations)) {
    const real = realPrices[dest.code];
    const perPax = real != null
      ? real
      : (dest.economy_per_pax[0] + dest.economy_per_pax[1]) / 2;
    const milesNeeded = perPax * config.family.total_pax_miles;
    const months = totalMiles > 0 ? Math.ceil(milesNeeded / totalMiles) : 999;
    etas[dest.code] = {
      name: dest.name,
      miles_needed: milesNeeded,
      miles_per_pax: perPax,
      months_eta: months,
      class: 'economy',
      price_source: real != null ? 'real' : 'estimate'
    };
  }

  return {
    scenario: scenario.label,
    monthly_budget_usd: scenario.monthly_usd,
    monthly_budget_ars: monthlyBudgetARS,
    sources,
    total_miles_per_month: totalMiles,
    best_smiles_bonus: smilesBonus,
    best_latam_bonus: latamBonus,
    etas
  };
}

// ---- Recommendations ----
function generateRecommendations(analysis, activePromos, trends = { smiles: null, latam: null }) {
  const recs = [];

  // Check for hot promos
  const bestSmilesBonus = findBestBonus(activePromos, 'smiles');
  const bestLatamBonus = findBestBonus(activePromos, 'latam');
  const smilesTrend = trendContext(bestSmilesBonus, trends.smiles);

  if (bestSmilesBonus && bestSmilesBonus >= 200) {
    recs.push({
      urgency: 'high',
      title: `🔥 Smiles tiene ${bestSmilesBonus}% de bonus — ¡COMPRÁ HOY!`,
      description: `Con bonus de ${bestSmilesBonus}%, el costo real por milla baja a ~AR$ ${(6.5 / (1 + bestSmilesBonus/100)).toFixed(2)}. ${smilesTrend || 'Este es un excelente momento para comprar.'}`,
      action: 'buy_smiles'
    });
  } else if (bestSmilesBonus && bestSmilesBonus >= 150) {
    recs.push({
      urgency: 'medium',
      title: `🟡 Smiles tiene ${bestSmilesBonus}% de bonus — Buen momento`,
      description: `Bonus decente. ${smilesTrend || 'Si estás en el escenario Agresivo, vale la pena; si sos Conservador, podés esperar algo mejor.'}`,
      action: 'consider_smiles'
    });
  } else {
    recs.push({
      urgency: 'low',
      title: '🟢 No hay promos fuertes de Smiles — Esperá',
      description: 'Sin bonus significativo, no conviene comprar millas. Mantené el Club Smiles activo y esperá la próxima promo.',
      action: 'wait'
    });
  }

  if (bestLatamBonus && bestLatamBonus >= 100) {
    const latamTrend = trendContext(bestLatamBonus, trends.latam);
    recs.push({
      urgency: 'medium',
      title: `✈️ LATAM Pass tiene ${bestLatamBonus}% de bonus en puntos`,
      description: `Buena oportunidad para complementar tus millas Smiles con puntos LATAM, útil para Madrid o Roma donde LATAM vuela directo. ${latamTrend || ''}`.trim(),
      action: 'buy_latam'
    });
  }

  // Calendar-based recommendations
  const now = new Date();
  const month = now.getMonth(); // 0-indexed

  const calendarEvents = [
    { month: 4, name: 'Hot Sale', desc: '¡El mejor evento del año para comprar millas Smiles! Prepará tu presupuesto.' },
    { month: 9, name: 'CyberMonday', desc: 'Segundo mejor evento. Bonus de hasta 250%.' },
    { month: 10, name: 'Black Friday', desc: 'Últimas promos fuertes del año.' }
  ];

  for (const event of calendarEvents) {
    const monthsUntil = (event.month - month + 12) % 12;
    if (monthsUntil === 1) {
      recs.push({
        urgency: 'medium',
        title: `📅 ${event.name} es el mes que viene — ¡Guardá presupuesto!`,
        description: event.desc,
        action: 'save_budget'
      });
    } else if (monthsUntil === 0) {
      recs.push({
        urgency: 'high',
        title: `🔥 ¡Estamos en mes de ${event.name}!`,
        description: `${event.desc} Revisá smiles.com.ar y latam.com todos los días.`,
        action: 'check_daily'
      });
    }
  }

  // Club Smiles reminder
  recs.push({
    urgency: 'low',
    title: '💳 Recordatorio: Club Smiles debe estar activo',
    description: 'El Club Smiles es la base de tu acumulación. Verificá que el débito automático esté funcionando.',
    action: 'verify_club'
  });

  return recs;
}

// ---- Helpers ----
function findBestBonus(promos, program) {
  const programPromos = promos.filter(p => p.program === program && p.bonus_pct);
  if (programPromos.length === 0) return null;
  return Math.max(...programPromos.map(p => p.bonus_pct));
}

// Tendencia histórica de bonus por programa (últimas ~300 promos detectadas)
async function getBonusTrends(db) {
  const out = { smiles: null, latam: null };
  try {
    const snap = await db.collection('promos').orderBy('detected_at', 'desc').limit(300).get();
    const byProgram = { smiles: [], latam: [] };
    snap.docs.forEach(d => {
      const p = d.data();
      if (p.bonus_pct && byProgram[p.program]) byProgram[p.program].push(p.bonus_pct);
    });
    out.smiles = bonusStats(byProgram.smiles);
    out.latam = bonusStats(byProgram.latam);
  } catch (err) {
    console.log(`   ⚠️ No se pudo calcular tendencia de bonus: ${err.message}`);
  }
  return out;
}

// Precio real más conveniente (menor millas/pax) por destino, de los últimos 30 días
async function getLatestPrices(db) {
  const out = {};
  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const snap = await db.collection('prices')
      .where('cabin', '==', 'economy')
      .get();
    snap.docs.forEach(d => {
      const p = d.data();
      const found = p.found_at ? new Date(p.found_at) : null;
      if (found && found < since) return;
      if (!p.destination || !p.miles_per_pax) return;
      if (out[p.destination] == null || p.miles_per_pax < out[p.destination]) {
        out[p.destination] = p.miles_per_pax;
      }
    });
  } catch (err) {
    console.log(`   ⚠️ No se pudieron leer precios reales: ${err.message}`);
  }
  return out;
}

function bonusStats(arr) {
  if (!arr || arr.length < 3) return null; // necesitamos historia mínima
  const sorted = [...arr].sort((a, b) => a - b);
  const avg = Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
  return { avg, max: Math.max(...arr), count: arr.length, sorted };
}

// Frase que ubica el bonus actual respecto del histórico
function trendContext(currentBonus, stats) {
  if (!currentBonus || !stats) return null;
  const below = stats.sorted.filter(v => v <= currentBonus).length;
  const pct = Math.round((below / stats.sorted.length) * 100);
  if (currentBonus >= stats.max) {
    return `Es el bonus más alto registrado (histórico máx ${stats.max}%, prom ${stats.avg}%). Difícil que aparezca algo mejor: comprá.`;
  }
  if (pct >= 75) {
    return `Está en el ${pct}% superior del histórico (prom ${stats.avg}%, máx ${stats.max}%). Buen momento para comprar.`;
  }
  if (pct <= 40) {
    return `Está por debajo del promedio histórico (${stats.avg}%, máx ${stats.max}%). Si podés, conviene esperar una promo mejor.`;
  }
  return `Está cerca del promedio histórico (${stats.avg}%, máx ${stats.max}%).`;
}

function getSamplePromos() {
  return [
    { program: 'smiles', title: 'Club Smiles + Mercado Pago 200% bonus', bonus_pct: 200, is_active: true },
    { program: 'smiles', title: 'Hot Sale Smiles 250% bonus', bonus_pct: 250, is_active: true },
    { program: 'latam', title: 'LATAM Pass compra con 100% bonus', bonus_pct: 100, is_active: true },
    { program: 'smiles', title: 'Transferencia Galicia con 50% bonus', bonus_pct: 50, is_active: true }
  ];
}

// ---- Run (solo si se ejecuta directamente, no al importar para tests) ----
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(err => {
    console.error('💥 Fatal error:', err);
    process.exit(1);
  });
}

export { main as optimize, analyzeScenario, generateRecommendations, bonusStats, trendContext, findBestBonus };
