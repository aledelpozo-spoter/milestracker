/**
 * MilesTracker Agent — Firebase Admin Init
 * Shared Firebase Admin instance for all agent modules.
 */

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

let db;

export function initFirebase() {
  if (db) return db;

  const serviceAccountJSON = process.env.FIREBASE_SERVICE_ACCOUNT;

  if (serviceAccountJSON) {
    // GitHub Actions: service account from secret
    const serviceAccount = JSON.parse(serviceAccountJSON);
    initializeApp({ credential: cert(serviceAccount) });
  } else {
    // Local dev: uses Application Default Credentials
    initializeApp();
  }

  db = getFirestore();
  return db;
}

export function getDb() {
  if (!db) return initFirebase();
  return db;
}
