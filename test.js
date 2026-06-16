/**
 * MilesTracker Agent — Test Suite (offline)
 * Ejercita la lógica pura de cada módulo con asserts. No requiere red ni Firebase.
 * Uso: node test.js
 */

import { bonusStats, trendContext, findBestBonus, analyzeScenario } from './optimizer.js';
import { findMinMiles, findMaxSeats } from './priceScraper.js';
import { buildExpiryAlert, buildAvailabilityAlert, buildUrgentAlert, computeTotals, buildStrategy } from './notifier.js';
import { readFileSync } from 'fs';
import { getUsdArs } from './exchange.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ✅', name); } else { fail++; console.log('  ❌', name); } };

console.log('\n🧪 MilesTracker — Test Suite\n');

// ---- optimizer: bonusStats ----
console.log('• optimizer.bonusStats');
const s3 = bonusStats([100, 200, 250]);
ok('avg de [100,200,250] = 183', s3.avg === 183);
ok('max = 250', s3.max === 250);
ok('count = 3', s3.count === 3);
ok('con <3 datos devuelve null', bonusStats([100, 200]) === null);

// ---- optimizer: trendContext ----
console.log('• optimizer.trendContext');
ok('bonus = máx histórico → "más alto registrado"',
  /más alto registrado/.test(trendContext(250, bonusStats([100, 200, 250]))));
ok('bonus en top → "superior del histórico"',
  /superior del histórico/.test(trendContext(200, bonusStats([100, 120, 150, 200, 250]))));
ok('bonus bajo → "por debajo del promedio"',
  /por debajo del promedio/.test(trendContext(120, bonusStats([100, 150, 200, 250]))));
ok('sin stats → null', trendContext(200, null) === null);

// ---- optimizer: findBestBonus ----
console.log('• optimizer.findBestBonus');
ok('toma el mayor bonus smiles',
  findBestBonus([{ program: 'smiles', bonus_pct: 150 }, { program: 'smiles', bonus_pct: 200 }], 'smiles') === 200);
ok('sin promos del programa → null',
  findBestBonus([{ program: 'latam', bonus_pct: 100 }], 'smiles') === null);

// ---- optimizer: analyzeScenario (precio real vs estimado) ----
console.log('• optimizer.analyzeScenario (precio real vs estimado)');
const sc = { monthly_usd: 100, label: 'Moderado' };
const withReal = analyzeScenario('moderate', sc, [], { MIA: 50000 });
ok('MIA usa precio REAL cuando existe', withReal.etas.MIA.price_source === 'real');
ok('MIA miles_per_pax = 50000', withReal.etas.MIA.miles_per_pax === 50000);
ok('MIA miles_needed = 50000 × 3 pax', withReal.etas.MIA.miles_needed === 150000);
const noReal = analyzeScenario('moderate', sc, [], {});
ok('MIA cae a ESTIMADO sin precio real', noReal.etas.MIA.price_source === 'estimate');

// ---- priceScraper: parsers ----
console.log('• priceScraper.findMinMiles / findMaxSeats');
const apiSample = { requestedFlightSegmentList: [{ flightList: [
  { fareList: [{ type: 'SMILES', miles: 95000, availableSeats: 2 }] },
  { fareList: [{ type: 'CLUB', miles: 76000, seatsAvailable: 4 }] }
] }] };
ok('findMinMiles toma el menor (76000)', findMinMiles(apiSample) === 76000);
ok('findMaxSeats toma el mayor (4)', findMaxSeats(apiSample) === 4);
ok('findMinMiles sin millas → null', findMinMiles({ precio: 999 }) === null);
ok('findMaxSeats sin asientos → null', findMaxSeats({ miles: 9000 }) === null);

// ---- notifier: email builders ----
console.log('• notifier builders');
const expiry = buildExpiryAlert({ amount: 30000, program: 'smiles', expiry_date: '2026-07-01' }, 10);
ok('alerta vencimiento: asunto menciona "10 días"', /10 días/.test(expiry.subject));
ok('alerta vencimiento: monto 30.000 en asunto', /30[.,]000/.test(expiry.subject));
const avail = buildAvailabilityAlert({ route: 'EZE-MIA', date: '2026-09-15', seats_available: 4, miles_per_pax: 70000 });
ok('alerta cupo: asunto menciona la ruta', /EZE-MIA/.test(avail.subject));
ok('alerta cupo: total 3 pax = 210.000 en html', /210[.,]000/.test(avail.html));
const urgent = buildUrgentAlert({ program: 'smiles', title: 'Hot Sale', bonus_pct: 200 });
ok('alerta promo: asunto menciona 200%', /200%/.test(urgent.subject));

// ---- notifier: análisis estratégico personalizado ----
console.log('• notifier.computeTotals / buildStrategy');
const cfg = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf-8'));
const milesSample = [
  { program:'smiles', type:'purchased', amount:60000 },
  { program:'smiles', type:'earned', amount:40000 },
  { program:'latam', type:'purchased', amount:40000 },
  { program:'smiles', type:'redeemed', amount:10000 }
];
const tot = computeTotals(milesSample);
ok('computeTotals Smiles = 90.000 (resta el canje)', tot.smiles === 90000);
ok('computeTotals LATAM = 40.000', tot.latam === 40000);
const stratHot = buildStrategy(tot, [{program:'smiles', bonus_pct:220}], {}, cfg);
ok('con bonus 220% la urgencia es alta', stratHot.urgency === 'high');
ok('calcula base a comprar para cerrar la brecha', stratHot.baseToBuy > 0 && stratHot.baseToBuy < stratHot.gap);
ok('elige un destino objetivo', !!stratHot.target && stratHot.target.needed > 0);
const stratWait = buildStrategy(tot, [], {}, cfg);
ok('sin promo, urgencia baja (esperar)', stratWait.urgency === 'low');

// ---- exchange: fallback offline ----
console.log('• exchange.getUsdArs (offline → fallback)');
const rate = await getUsdArs();
ok('devuelve un número > 0', typeof rate === 'number' && rate > 0);

// ---- Resumen ----
console.log(`\n📊 Resultado: ${pass} ✅  ${fail} ❌\n`);
process.exit(fail === 0 ? 0 : 1);
