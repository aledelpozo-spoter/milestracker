/**
 * MilesTracker Agent — Price Scraper Module
 *
 * Consulta el buscador de premios de Smiles para las rutas prioritarias
 * y meses objetivo, y guarda el costo REAL en millas por pasajero (economy)
 * en la colección `prices` de Firestore. El optimizer luego usa estos datos
 * en lugar de los rangos estimados del config.
 *
 * IMPORTANTE — credencial requerida:
 *   La API de Smiles exige un header `x-api-key` que se obtiene capturando
 *   el tráfico de red en smiles.com.ar al hacer una búsqueda de vuelo
 *   (DevTools → Network → request a /api/flight/search → copiar el header).
 *   Cargalo en config.json → price_tracking.smiles_api.headers["x-api-key"].
 *   Mientras price_tracking.enabled sea false, este módulo no consulta nada
 *   y termina sin error (no rompe la corrida programada).
 *
 * Uso:
 *   node priceScraper.js            # consulta y guarda en `prices`
 *   node priceScraper.js --dry-run  # consulta e imprime, no guarda
 */

import fetch from 'node-fetch';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { initFirebase } from './firebase-init.js';

const DRY_RUN = process.argv.includes('--dry-run');
const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf-8'));

async function main() {
  console.log(`\n🎫 MilesTracker Price Scraper — ${new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}`);

  const pt = config.price_tracking;
  if (!pt || !pt.enabled) {
    console.log('   ⏸️ price_tracking.enabled = false. No se consultan precios. (Cargá la x-api-key y activalo en config.json.)');
    return [];
  }
  if (!pt.smiles_api?.headers?.['x-api-key']) {
    console.log('   ⚠️ Falta x-api-key en config.json → price_tracking.smiles_api.headers. Abortando sin error.');
    return [];
  }

  const results = [];
  for (const route of pt.routes) {
    for (const month of pt.target_months) {
      const date = `${month}-${String(pt.sample_day).padStart(2, '0')}`;
      const required = pt.family_pax_required ?? ((pt.pax?.adults ?? 1) + (pt.pax?.children ?? 0));
      try {
        const { miles, seats } = await searchSmilesAward(route, date, pt);
        if (miles != null) {
          const family_ok = seats == null ? null : seats >= required;
          const record = {
            program: 'smiles',
            route: `${route.origin}-${route.destination}`,
            origin: route.origin,
            destination: route.destination,
            date,
            cabin: pt.cabin || 'economy',
            miles_per_pax: miles,
            seats_available: seats,
            family_pax_required: required,
            family_ok,
            found_at: new Date().toISOString()
          };
          results.push(record);
          const seatTxt = seats == null ? 'cupo s/d' : `${seats} asientos${family_ok ? ' ✅3pax' : ''}`;
          console.log(`   ✈️ ${record.route} ${date}: ${miles.toLocaleString()} millas/pax · ${seatTxt}`);
        } else {
          console.log(`   ➖ ${route.origin}-${route.destination} ${date}: sin disponibilidad en millas`);
        }
      } catch (err) {
        console.log(`   ❌ ${route.origin}-${route.destination} ${date}: ${err.message}`);
      }
    }
  }

  console.log(`\n📊 ${results.length} precios obtenidos.`);

  if (!DRY_RUN && results.length > 0) {
    const db = initFirebase();
    const batch = db.batch();
    for (const r of results) {
      batch.set(db.collection('prices').doc(), { ...r, found_at: new Date() });
    }
    await batch.commit();
    console.log('   💾 Precios guardados en Firestore.\n');
  } else if (DRY_RUN) {
    console.log(JSON.stringify(results, null, 2));
  }

  return results;
}

/**
 * Consulta la API de Smiles y devuelve { miles, seats } para esa ruta/fecha:
 *   miles → menor costo en millas por pasajero (economy), o null si no hay.
 *   seats → asientos en millas disponibles para esa tarifa, o null si no se
 *           puede determinar (la respuesta no siempre lo expone).
 *
 * El parseo es defensivo: la estructura puede cambiar, así que recorremos el
 * JSON buscando los campos de forma robusta.
 */
async function searchSmilesAward(route, date, pt) {
  const url = new URL(pt.smiles_api.search_url);
  const params = {
    originAirportCode: route.origin,
    destinationAirportCode: route.destination,
    departureDate: date,
    adults: pt.pax?.adults ?? 1,
    children: pt.pax?.children ?? 0,
    infants: pt.pax?.infants ?? 0,
    cabinType: 'all',
    tripType: '2', // one-way para sondear precio
    currencyCode: 'ARS'
  };
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url.toString(), {
    headers: { 'Accept': 'application/json', ...pt.smiles_api.headers },
    timeout: 20000
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const data = await res.json();
  return { miles: findMinMiles(data), seats: findMaxSeats(data) };
}

// Busca recursivamente el menor valor de "miles" plausible en el JSON de respuesta.
function findMinMiles(obj, min = Infinity) {
  if (obj == null || typeof obj !== 'object') return min === Infinity ? null : min;

  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === 'number' && /mile/i.test(key) && val >= 1000 && val < 2000000) {
      if (val < min) min = val;
    } else if (val && typeof val === 'object') {
      const sub = findMinMiles(val, min);
      if (sub != null && sub < min) min = sub;
    }
  }
  return min === Infinity ? null : min;
}

// Busca recursivamente el mayor "asientos disponibles" plausible en la respuesta.
// Campos típicos: availableSeats, seatsAvailable, seatAvailability, quantity.
function findMaxSeats(obj, max = -1) {
  if (obj == null || typeof obj !== 'object') return max < 0 ? null : max;

  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === 'number' && /seat|asiento|availab/i.test(key) && val >= 0 && val <= 9) {
      if (val > max) max = val;
    } else if (val && typeof val === 'object') {
      const sub = findMaxSeats(val, max);
      if (sub != null && sub > max) max = sub;
    }
  }
  return max < 0 ? null : max;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(err => {
    console.error('💥 Fatal error:', err);
    process.exit(1);
  });
}

export { main as scrapePrices, findMinMiles, findMaxSeats };
