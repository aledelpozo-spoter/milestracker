/**
 * MilesTracker Agent — Exchange Rate Module
 *
 * Obtiene la cotización del dólar MEP (Bolsa) desde dolarapi.com.
 * Se usa para calcular el costo real por milla en pesos, ya que las
 * millas se fondean vía dólar MEP.
 *
 * Si la API falla, devuelve un fallback para no romper el optimizador,
 * pero loguea una advertencia (las recomendaciones quedan menos precisas).
 */

import fetch from 'node-fetch';

// Fallback solo para cuando la API no responde. Se loguea una advertencia.
const FALLBACK_ARS_PER_USD = 1200;
const MEP_URL = 'https://dolarapi.com/v1/dolares/bolsa';

export async function getUsdArs() {
  try {
    const res = await fetch(MEP_URL, {
      headers: { 'Accept': 'application/json' },
      timeout: 10000
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    // dolarapi devuelve { compra, venta, ... }. Usamos "venta" (lo que pagás).
    const rate = data.venta || data.compra;

    if (rate && rate > 0) {
      console.log(`   💵 Dólar MEP: AR$ ${rate} (dolarapi.com)`);
      return Math.round(rate);
    }
    throw new Error('Respuesta sin cotización válida');
  } catch (err) {
    console.log(`   ⚠️ No se pudo obtener el dólar MEP (${err.message}). Usando fallback AR$ ${FALLBACK_ARS_PER_USD}.`);
    return FALLBACK_ARS_PER_USD;
  }
}
