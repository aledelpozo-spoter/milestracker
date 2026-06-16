/**
 * MilesTracker Agent — Notifier Module
 * 
 * Sends email notifications via Firebase "Trigger Email from Firestore" extension.
 * Writes documents to the `mail` collection in Firestore, which the extension
 * picks up and sends via configured SMTP.
 * 
 * Email types:
 * 1. Daily summary (8 AM) — current state + recommendations
 * 2. Urgent alert — when a promo exceeds threshold
 * 3. Weekly summary (Mondays) — progress report
 * 
 * Usage:
 *   node notifier.js              # Send pending notifications
 *   node notifier.js --test       # Send test email
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { initFirebase } from './firebase-init.js';

const TEST_MODE = process.argv.includes('--test');
const config = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf-8'));

// ---- Main ----
async function main() {
  console.log(`\n📧 MilesTracker Notifier — ${new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })}`);
  console.log(`   Mode: ${TEST_MODE ? 'TEST' : 'PRODUCTION'}\n`);

  const db = initFirebase();
  const now = new Date();
  const hour = parseInt(now.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires', hour: 'numeric', hour12: false }));
  const dayOfWeek = now.getDay(); // 0 = Sunday, 1 = Monday

  if (TEST_MODE) {
    await sendTestEmail(db);
    return;
  }

  // Get latest optimization results
  const latestOpt = await db.collection('history')
    .where('type', '==', 'optimization')
    .orderBy('date', 'desc')
    .limit(1)
    .get();

  const optimization = latestOpt.docs[0]?.data() || null;

  // Get active promos
  const promosSnap = await db.collection('promos').where('is_active', '==', true).get();
  const activePromos = promosSnap.docs.map(d => d.data());

  // Get user config (find the first user with email configured)
  const usersSnap = await db.collection('users').limit(10).get();
  const users = usersSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  // Disponibilidad familiar nueva (cupo para 3 pax) detectada en los últimos scans.
  // Se calcula una vez y se deduplica por ruta+fecha para no spamear.
  const familyAvailability = await getNewFamilyAvailability(db);

  for (const user of users) {
    const email = user.email || config.notifications.email;
    if (!email || email === 'YOUR_EMAIL@gmail.com') {
      console.log('   ⚠️ No email configured. Skipping notifications.');
      continue;
    }

    const notifications = user.notifications || { daily: true, weekly: true, urgent: true };

    // Leer los saldos reales del usuario (la web guarda, el agente decide)
    const userMilesSnap = await db.collection('users').doc(user.id).collection('miles').get();
    const userMiles = userMilesSnap.docs.map(d => ({ id: d.id, ref: d.ref, ...d.data() }));

    // 1. Check for urgent alerts (promos with high bonus)
    if (notifications.urgent) {
      const threshold = user.thresholds?.min_bonus || config.thresholds.min_bonus_pct_alert;
      const urgentPromos = activePromos.filter(p =>
        p.bonus_pct && p.bonus_pct >= threshold && !p.notified
      );

      for (const promo of urgentPromos) {
        console.log(`   🚨 Alerta urgente: ${promo.title} (${promo.bonus_pct}% bonus)`);
        await sendEmail(db, email, buildUrgentAlert(promo));

        // Mark as notified
        if (promo.id) {
          await db.collection('promos').doc(promo.id).update({ notified: true });
        }

        // Save alert to user's alerts subcollection
        await db.collection('users').doc(user.id).collection('alerts').add({
          type: 'urgent',
          title: `🔥 ${promo.title}`,
          body: `Bonus: ${promo.bonus_pct}% — ${promo.program === 'smiles' ? 'Smiles' : 'LATAM Pass'}`,
          date: now,
          read: false
        });
      }
    }

    // 1b. Vencimiento de millas — avisar cuando faltan ≤ X días
    if (notifications.urgent) {
      const expiryThreshold = user.thresholds?.expiry_days || config.thresholds.days_before_expiry_alert || 30;
      const POSITIVE = ['earned', 'purchased', 'transferred', 'bonus'];

      for (const mDoc of userMiles) {
        const m = mDoc;
        if (!m.expiry_date || !POSITIVE.includes(m.type) || m.expiry_notified) continue;

        const days = Math.ceil((new Date(m.expiry_date) - now) / (1000 * 60 * 60 * 24));
        if (days <= expiryThreshold) {
          console.log(`   ⏳ Vencimiento próximo: ${m.amount} ${m.program} en ${days} días`);
          await sendEmail(db, email, buildExpiryAlert(m, days));
          await mDoc.ref.update({ expiry_notified: true });
          await db.collection('users').doc(user.id).collection('alerts').add({
            type: 'expiry',
            title: `⏳ ${m.amount.toLocaleString()} millas ${m.program} por vencer`,
            body: days < 0 ? `Vencieron hace ${Math.abs(days)} días` : `Vencen en ${days} días (${m.expiry_date})`,
            date: now,
            read: false
          });
        }
      }
    }

    // 1c. Disponibilidad de cupo para 3 pax en rutas monitoreadas
    if (notifications.urgent && familyAvailability.length) {
      for (const fa of familyAvailability) {
        console.log(`   💺 Cupo 3 pax: ${fa.route} ${fa.date} (${fa.seats_available} asientos)`);
        await sendEmail(db, email, buildAvailabilityAlert(fa));
        await db.collection('users').doc(user.id).collection('alerts').add({
          type: 'availability',
          title: `💺 Cupo para 3 en ${fa.route}`,
          body: `${fa.seats_available} asientos en millas para ${fa.date} (${fa.miles_per_pax.toLocaleString()} mi/pax)`,
          date: now,
          read: false
        });
      }
    }

    // 2. Visión estratégica diaria (scan de la mañana, ~8 AM)
    if (notifications.daily && (hour >= 7 && hour <= 9)) {
      console.log('   🧭 Enviando visión estratégica diaria...');
      const totals = computeTotals(userMiles);
      const strategy = buildStrategy(totals, activePromos, user, config);
      await sendEmail(db, email, buildStrategicBriefing(totals, strategy, activePromos));

      await db.collection('users').doc(user.id).collection('alerts').add({
        type: 'daily',
        title: '🧭 Visión estratégica del día',
        body: strategy.headline,
        date: now,
        read: false
      });
    }

    // 3. Weekly summary (Monday morning)
    if (notifications.weekly && dayOfWeek === 1 && (hour >= 7 && hour <= 9)) {
      console.log('   📊 Enviando resumen semanal...');
      await sendEmail(db, email, buildWeeklySummary(activePromos, optimization, user));
    }
  }

  console.log('\n   ✅ Notificaciones procesadas.\n');
}

// ---- Email Builders ----
function buildUrgentAlert(promo) {
  const programName = promo.program === 'smiles' ? 'Smiles' : 'LATAM Pass';
  const programColor = promo.program === 'smiles' ? '#FF6B00' : '#4A1580';

  return {
    subject: `🔥 MilesTracker: ${programName} ${promo.bonus_pct}% bonus — ¡Aprovechá ahora!`,
    html: `
      <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:600px;margin:0 auto;background:#f8f9fa;padding:20px">
        <div style="background:linear-gradient(135deg,#4A1580,#FF6B00);color:white;padding:20px;border-radius:12px 12px 0 0;text-align:center">
          <h1 style="margin:0;font-size:22px">✈️ MilesTracker</h1>
          <p style="margin:4px 0 0;opacity:0.85;font-size:14px">Alerta de Promo Detectada</p>
        </div>
        <div style="background:white;padding:24px;border-radius:0 0 12px 12px;border:1px solid #e2e8f0">
          <div style="background:${programColor}15;border-left:4px solid ${programColor};padding:16px;border-radius:8px;margin-bottom:16px">
            <h2 style="margin:0 0 8px;color:${programColor};font-size:18px">${promo.title}</h2>
            <p style="margin:0;color:#555;font-size:14px">${promo.description || ''}</p>
          </div>
          <table style="width:100%;border-collapse:collapse;margin-bottom:16px">
            <tr>
              <td style="padding:8px 12px;font-weight:bold;color:#666;font-size:13px">Programa</td>
              <td style="padding:8px 12px;font-weight:bold;color:${programColor}">${programName}</td>
            </tr>
            <tr style="background:#f8f9fa">
              <td style="padding:8px 12px;font-weight:bold;color:#666;font-size:13px">Bonus</td>
              <td style="padding:8px 12px;font-weight:bold;color:#10b981;font-size:20px">${promo.bonus_pct}%</td>
            </tr>
            <tr>
              <td style="padding:8px 12px;font-weight:bold;color:#666;font-size:13px">Costo real/milla</td>
              <td style="padding:8px 12px;font-weight:bold;color:#FF6B00">~AR$ ${(6.5 / (1 + (promo.bonus_pct || 0) / 100)).toFixed(2)}</td>
            </tr>
          </table>
          ${promo.url ? `<a href="${promo.url}" style="display:block;background:linear-gradient(135deg,#4A1580,#FF6B00);color:white;padding:12px;text-align:center;border-radius:8px;text-decoration:none;font-weight:bold;font-size:15px">Ver promo →</a>` : ''}
          <p style="margin-top:16px;font-size:12px;color:#999;text-align:center">MilesTracker · Agente automático · Smiles & LATAM Pass</p>
        </div>
      </div>
    `
  };
}

function buildExpiryAlert(mile, days) {
  const programName = mile.program === 'smiles' ? 'Smiles' : mile.program === 'latam' ? 'LATAM Pass' : 'Galicia';
  const venceTxt = days < 0 ? `vencieron hace ${Math.abs(days)} días`
    : days === 0 ? 'vencen HOY' : `vencen en ${days} días`;
  return {
    subject: `⏳ MilesTracker: ${mile.amount.toLocaleString()} millas ${programName} ${venceTxt}`,
    html: `
      <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
        <div style="background:#b45309;color:white;padding:20px;border-radius:12px 12px 0 0;text-align:center">
          <h1 style="margin:0;font-size:20px">⏳ MilesTracker — Vencimiento</h1>
        </div>
        <div style="background:white;padding:24px;border:1px solid #e2e8f0;border-radius:0 0 12px 12px">
          <p style="font-size:16px"><strong>${mile.amount.toLocaleString()} millas ${programName}</strong> ${venceTxt}.</p>
          <table style="width:100%;border-collapse:collapse;margin:12px 0">
            ${mile.account ? `<tr><td style="padding:6px 8px;color:#666;font-size:13px">Cuenta</td><td style="padding:6px 8px;font-weight:bold">${mile.account}</td></tr>` : ''}
            <tr style="background:#f8f9fa"><td style="padding:6px 8px;color:#666;font-size:13px">Vencimiento</td><td style="padding:6px 8px;font-weight:bold">${mile.expiry_date}</td></tr>
            ${mile.description ? `<tr><td style="padding:6px 8px;color:#666;font-size:13px">Detalle</td><td style="padding:6px 8px">${mile.description}</td></tr>` : ''}
          </table>
          <p style="font-size:13px;color:#666">Tip: una actividad mínima (transferencia, compra chica o canje) suele renovar la vigencia. No dejes vencer millas que costaron meses de inversión.</p>
        </div>
      </div>`
  };
}

// Devuelve las disponibilidades familiares (family_ok) nuevas, deduplicadas por
// ruta+fecha vía la colección availability_alerts (no repite antes de 7 días).
async function getNewFamilyAvailability(db) {
  const out = [];
  try {
    const snap = await db.collection('prices').where('family_ok', '==', true).get();
    const now = Date.now();
    for (const d of snap.docs) {
      const p = d.data();
      const found = p.found_at?.toDate ? p.found_at.toDate() : new Date(p.found_at);
      if (now - found.getTime() > 2 * 24 * 60 * 60 * 1000) continue; // solo últimas 48h

      const key = `${p.route}_${p.date}`;
      const stateRef = db.collection('availability_alerts').doc(key);
      const st = await stateRef.get();
      if (st.exists) {
        const last = st.data().last_notified?.toDate ? st.data().last_notified.toDate() : new Date(st.data().last_notified);
        if (now - last.getTime() < 7 * 24 * 60 * 60 * 1000) continue; // ya avisado hace poco
      }
      out.push(p);
      await stateRef.set({ route: p.route, date: p.date, last_notified: new Date() });
    }
  } catch (err) {
    console.log(`   ⚠️ No se pudo chequear disponibilidad familiar: ${err.message}`);
  }
  return out;
}

function buildAvailabilityAlert(fa) {
  return {
    subject: `💺 MilesTracker: ¡Cupo para 3 pax en ${fa.route} (${fa.date})!`,
    html: `
      <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
        <div style="background:linear-gradient(135deg,#10b981,#059669);color:white;padding:20px;border-radius:12px 12px 0 0;text-align:center">
          <h1 style="margin:0;font-size:20px">💺 MilesTracker — Cupo disponible</h1>
          <p style="margin:4px 0 0;opacity:0.9;font-size:14px">¡Se abrió disponibilidad en millas para la familia!</p>
        </div>
        <div style="background:white;padding:24px;border:1px solid #e2e8f0;border-radius:0 0 12px 12px">
          <p style="font-size:16px">Hay <strong>${fa.seats_available} asientos</strong> en clase millas en <strong>${fa.route}</strong> para el <strong>${fa.date}</strong> — suficiente para los 3 pax.</p>
          <table style="width:100%;border-collapse:collapse;margin:12px 0">
            <tr style="background:#f8f9fa"><td style="padding:6px 8px;color:#666;font-size:13px">Costo</td><td style="padding:6px 8px;font-weight:bold">${fa.miles_per_pax.toLocaleString()} millas/pax</td></tr>
            <tr><td style="padding:6px 8px;color:#666;font-size:13px">Total 3 pax</td><td style="padding:6px 8px;font-weight:bold">${(fa.miles_per_pax * 3).toLocaleString()} millas</td></tr>
          </table>
          <p style="font-size:13px;color:#666">El cupo en millas vuela rápido. Si te sirve la fecha, conviene emitir cuanto antes.</p>
        </div>
      </div>`
  };
}

// Suma saldos reales por programa (la web guarda el dato; el agente lo lee)
function computeTotals(userMiles) {
  const t = { smiles: 0, latam: 0, galicia: 0 };
  for (const m of userMiles) {
    const sign = (m.type === 'redeemed' || m.type === 'expired') ? -1 : 1;
    if (t[m.program] != null) t[m.program] += sign * (m.amount || 0);
  }
  return t;
}

// El "cerebro": cruza tus saldos con las promos y decide el próximo movimiento
function buildStrategy(totals, activePromos, user, config) {
  const pax = config.family?.total_pax_miles || 1;
  const smiles = totals.smiles;

  const goals = Object.values(config.destinations)
    .filter(d => (d.programs || []).includes('smiles') && d.economy_per_pax)
    .map(d => ({ name: d.name, code: d.code, needed: Math.round((d.economy_per_pax[0] + d.economy_per_pax[1]) / 2) * pax }))
    .sort((a, b) => a.needed - b.needed);

  const target = goals.find(g => g.needed > smiles) || goals[goals.length - 1];
  const gap = Math.max(0, target.needed - smiles);
  const smilesBonuses = activePromos.filter(p => p.program === 'smiles' && p.bonus_pct).map(p => p.bonus_pct);
  const bestBonus = smilesBonuses.length ? Math.max(...smilesBonuses) : 0;
  const baseToBuy = bestBonus > 0 ? Math.ceil(gap / (1 + bestBonus / 100)) : gap;

  let headline, action, urgency;
  if (gap === 0) {
    headline = `Ya tenés las ${target.needed.toLocaleString()} millas para ${target.name} (${pax} pax). Es momento de emitir.`;
    action = `Buscá disponibilidad en clase millas para ${target.name} y emití antes de que cambien las tablas.`;
    urgency = 'high';
  } else if (bestBonus >= 200) {
    headline = `Te faltan ${gap.toLocaleString()} millas para ${target.name}. Hay un bonus Smiles de ${bestBonus}%: comprá ~${baseToBuy.toLocaleString()} de base y lo cerrás hoy.`;
    action = `Comprar ~${baseToBuy.toLocaleString()} millas Smiles con el ${bestBonus}% para llegar a ${target.needed.toLocaleString()} (${target.name}). Juntá las cuentas de los 2 adultos para emitir de una.`;
    urgency = 'high';
  } else if (bestBonus >= 150) {
    headline = `Te faltan ${gap.toLocaleString()} millas para ${target.name}. Hoy hay ${bestBonus}% de bonus: decente, pero suele aparecer 200%+.`;
    action = `Si querés acelerar, comprá ~${baseToBuy.toLocaleString()} de base; si no, esperá una promo más fuerte (Hot Sale / CyberMonday).`;
    urgency = 'medium';
  } else {
    headline = `Te faltan ${gap.toLocaleString()} millas para ${target.name}. Hoy no hay promo fuerte: sostené y esperá un bonus 200%+.`;
    action = `No comprar millas sueltas. Mantené el Club Smiles activo y juntá puntos bancarios (Galicia) para transferir en la próxima promo.`;
    urgency = 'low';
  }
  return { target, gap, bestBonus, baseToBuy, headline, action, urgency, goals };
}

function buildStrategicBriefing(totals, s, activePromos) {
  const color = s.urgency === 'high' ? '#10b981' : s.urgency === 'medium' ? '#f59e0b' : '#64748b';
  const goalsRows = s.goals.slice(0, 4).map(g => {
    const have = Math.min(totals.smiles, g.needed);
    const pct = Math.min(100, Math.round((totals.smiles / g.needed) * 100));
    return `<tr>
      <td style="padding:6px 8px;font-size:13px">${g.name}</td>
      <td style="padding:6px 8px;font-size:13px;text-align:right">${g.needed.toLocaleString()}</td>
      <td style="padding:6px 8px;font-size:13px;text-align:right;font-weight:bold;color:${pct>=100?'#10b981':'#64748b'}">${pct}%</td>
    </tr>`;
  }).join('');

  return {
    subject: `🧭 MilesTracker: ${s.headline.substring(0, 90)}`,
    html: `
      <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:600px;margin:0 auto;background:#f8f9fa;padding:20px">
        <div style="background:linear-gradient(135deg,#4A1580,#FF6B00);color:white;padding:20px;border-radius:12px 12px 0 0;text-align:center">
          <h1 style="margin:0;font-size:21px">🧭 Tu visión estratégica del día</h1>
        </div>
        <div style="background:white;padding:24px;border-radius:0 0 12px 12px;border:1px solid #e2e8f0">
          <div style="display:flex;gap:12px;margin-bottom:16px">
            <div style="flex:1;background:#fff3e8;border-radius:8px;padding:12px;text-align:center">
              <div style="font-size:12px;color:#666">Smiles</div>
              <div style="font-size:22px;font-weight:800;color:#FF6B00">${totals.smiles.toLocaleString()}</div>
            </div>
            <div style="flex:1;background:#f3eaff;border-radius:8px;padding:12px;text-align:center">
              <div style="font-size:12px;color:#666">LATAM</div>
              <div style="font-size:22px;font-weight:800;color:#4A1580">${totals.latam.toLocaleString()}</div>
            </div>
          </div>
          <div style="background:${color}18;border-left:4px solid ${color};padding:14px;border-radius:8px;margin-bottom:16px">
            <strong style="color:${color};font-size:15px">Decisión de hoy</strong>
            <p style="margin:6px 0 0;font-size:14px;color:#333">${s.headline}</p>
            <p style="margin:8px 0 0;font-size:13px;color:#555"><strong>Acción:</strong> ${s.action}</p>
          </div>
          <h3 style="margin:0 0 8px;color:#4A1580;font-size:15px">🎯 Progreso hacia tus destinos (Smiles)</h3>
          <table style="width:100%;border-collapse:collapse">
            <tr style="background:#f8f9fa"><td style="padding:6px 8px;font-size:12px;color:#666">Destino (3 pax)</td><td style="padding:6px 8px;font-size:12px;color:#666;text-align:right">Necesitás</td><td style="padding:6px 8px;font-size:12px;color:#666;text-align:right">Tenés</td></tr>
            ${goalsRows}
          </table>
          <p style="margin-top:16px;font-size:12px;color:#999;text-align:center">MilesTracker · La web guarda, el agente decide · ${activePromos.length} promos activas</p>
        </div>
      </div>`
  };
}

function buildDailySummary(promos, optimization) {
  const smilesPromos = promos.filter(p => p.program === 'smiles');
  const latamPromos = promos.filter(p => p.program === 'latam');
  const recs = optimization?.recommendations || [];

  const recsHtml = recs.map(r => {
    const icon = r.urgency === 'high' ? '🔴' : r.urgency === 'medium' ? '🟡' : '🟢';
    return `<div style="padding:10px;border-bottom:1px solid #eee">
      <strong>${icon} ${r.title}</strong>
      <p style="margin:4px 0 0;font-size:13px;color:#666">${r.description}</p>
    </div>`;
  }).join('');

  const promosHtml = promos.slice(0, 5).map(p => {
    const color = p.program === 'smiles' ? '#FF6B00' : '#4A1580';
    return `<div style="padding:8px;border-left:3px solid ${color};margin-bottom:6px;background:#f8f9fa;border-radius:0 6px 6px 0">
      <strong style="font-size:13px">${p.title}</strong>
      ${p.bonus_pct ? `<span style="color:#10b981;font-weight:bold;margin-left:8px">${p.bonus_pct}%</span>` : ''}
    </div>`;
  }).join('');

  return {
    subject: `📋 MilesTracker: Resumen diario — ${promos.length} promos activas`,
    html: `
      <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:600px;margin:0 auto;background:#f8f9fa;padding:20px">
        <div style="background:linear-gradient(135deg,#4A1580,#FF6B00);color:white;padding:20px;border-radius:12px 12px 0 0;text-align:center">
          <h1 style="margin:0;font-size:22px">✈️ MilesTracker — Resumen Diario</h1>
          <p style="margin:4px 0 0;opacity:0.85;font-size:14px">${new Date().toLocaleDateString('es-AR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Argentina/Buenos_Aires' })}</p>
        </div>
        <div style="background:white;padding:24px;border-radius:0 0 12px 12px;border:1px solid #e2e8f0">
          <h3 style="margin:0 0 12px;color:#4A1580">📊 Estado</h3>
          <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
            <tr style="background:#f8f9fa"><td style="padding:8px;font-size:13px">Promos Smiles activas</td><td style="padding:8px;font-weight:bold;text-align:right">${smilesPromos.length}</td></tr>
            <tr><td style="padding:8px;font-size:13px">Promos LATAM activas</td><td style="padding:8px;font-weight:bold;text-align:right">${latamPromos.length}</td></tr>
          </table>
          
          ${recs.length > 0 ? `<h3 style="margin:0 0 12px;color:#4A1580">💡 Recomendaciones</h3><div style="margin-bottom:20px">${recsHtml}</div>` : ''}
          
          ${promos.length > 0 ? `<h3 style="margin:0 0 12px;color:#4A1580">🔥 Promos Activas</h3><div style="margin-bottom:16px">${promosHtml}</div>` : ''}
          
          <p style="margin-top:16px;font-size:12px;color:#999;text-align:center">MilesTracker · Próximo scan: 20:00 ART</p>
        </div>
      </div>
    `
  };
}

function buildWeeklySummary(promos, optimization, user) {
  const scenario = config.scenarios[user.scenario || 'moderate'];

  return {
    subject: `📊 MilesTracker: Resumen semanal — ${scenario?.label || 'Moderado'}`,
    html: `
      <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:600px;margin:0 auto;background:#f8f9fa;padding:20px">
        <div style="background:linear-gradient(135deg,#4A1580,#FF6B00);color:white;padding:20px;border-radius:12px 12px 0 0;text-align:center">
          <h1 style="margin:0;font-size:22px">✈️ MilesTracker — Resumen Semanal</h1>
          <p style="margin:4px 0 0;opacity:0.85;font-size:14px">Escenario: ${scenario?.label || 'Moderado'} (USD ${scenario?.monthly_usd || 100}/mes)</p>
        </div>
        <div style="background:white;padding:24px;border-radius:0 0 12px 12px;border:1px solid #e2e8f0">
          <h3 style="color:#4A1580">📈 Esta semana</h3>
          <ul style="list-style:none;padding:0;margin:0 0 20px">
            <li style="padding:8px 0;border-bottom:1px solid #eee;font-size:14px">📌 ${promos.length} promos activas detectadas</li>
            <li style="padding:8px 0;border-bottom:1px solid #eee;font-size:14px">💰 Inversión recomendada: USD ${scenario?.monthly_usd || 100}/mes</li>
            <li style="padding:8px 0;font-size:14px">🎯 Millas estimadas/mes: ${(scenario?.miles_per_month_low || 0).toLocaleString()}-${(scenario?.miles_per_month_high || 0).toLocaleString()}</li>
          </ul>
          
          <h3 style="color:#4A1580">🗺️ Progreso hacia destinos</h3>
          <p style="font-size:13px;color:#666;margin-bottom:16px">Con tu escenario ${scenario?.label || 'Moderado'}:</p>
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <tr style="background:#f8f9fa"><td style="padding:6px 8px">🗽 Miami Economy (3 pax)</td><td style="padding:6px 8px;text-align:right;font-weight:bold">~4-5 meses</td></tr>
            <tr><td style="padding:6px 8px">🇮🇹 Roma Economy (3 pax)</td><td style="padding:6px 8px;text-align:right;font-weight:bold">~5-7 meses</td></tr>
            <tr style="background:#f8f9fa"><td style="padding:6px 8px">🇪🇸 Madrid Economy (3 pax)</td><td style="padding:6px 8px;text-align:right;font-weight:bold">~4-6 meses</td></tr>
            <tr><td style="padding:6px 8px">🦁 Sudáfrica Economy (3 pax)</td><td style="padding:6px 8px;text-align:right;font-weight:bold">~7-9 meses</td></tr>
          </table>
          
          <p style="margin-top:20px;font-size:12px;color:#999;text-align:center">MilesTracker · Agente automático · Smiles & LATAM Pass</p>
        </div>
      </div>
    `
  };
}

// ---- Send Email via Firestore ----
async function sendEmail(db, to, emailContent) {
  try {
    await db.collection('mail').add({
      to,
      message: {
        subject: emailContent.subject,
        html: emailContent.html
      },
      createdAt: new Date()
    });
    console.log(`   📨 Email queued: ${emailContent.subject.substring(0, 60)}...`);
  } catch (err) {
    console.error(`   ❌ Error queueing email: ${err.message}`);
  }
}

// ---- Test Email ----
async function sendTestEmail(db) {
  const testEmail = config.notifications.email;
  if (!testEmail || testEmail === 'YOUR_EMAIL@gmail.com') {
    console.log('   ⚠️ Configurá tu email en config.json primero.');
    return;
  }

  console.log(`   Enviando email de prueba a ${testEmail}...`);
  await sendEmail(db, testEmail, {
    subject: '✅ MilesTracker — Test exitoso',
    html: `
      <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
        <div style="background:linear-gradient(135deg,#4A1580,#FF6B00);color:white;padding:20px;border-radius:12px;text-align:center">
          <h1 style="margin:0">✈️ MilesTracker</h1>
          <p style="margin:8px 0 0;font-size:18px">✅ Test de email exitoso</p>
        </div>
        <div style="background:white;padding:24px;border-radius:0 0 12px 12px;border:1px solid #e2e8f0">
          <p>Si recibiste este email, las notificaciones están configuradas correctamente.</p>
          <p>El agente te enviará:</p>
          <ul>
            <li>📋 Resumen diario (8 AM)</li>
            <li>🔥 Alertas urgentes de promos</li>
            <li>📊 Resumen semanal (lunes)</li>
          </ul>
          <p style="color:#999;font-size:12px;margin-top:16px">Timestamp: ${new Date().toISOString()}</p>
        </div>
      </div>
    `
  });

  console.log('   ✅ Email de prueba encolado. Debería llegar en unos segundos.\n');
}

// ---- Run (solo si se ejecuta directamente, no al importar para tests) ----
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(err => {
    console.error('💥 Fatal error:', err);
    process.exit(1);
  });
}

export { main as notify, buildUrgentAlert, buildExpiryAlert, buildAvailabilityAlert, buildDailySummary, buildWeeklySummary, computeTotals, buildStrategy, buildStrategicBriefing };
