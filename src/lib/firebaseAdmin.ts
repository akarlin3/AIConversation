import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

/**
 * Firebase Admin singleton.
 *
 * All Firestore access happens server-side through this module (API routes only).
 * The client never receives Firebase credentials.
 *
 * Two init paths:
 *   - Production: service-account credentials from env (FIREBASE_PROJECT_ID,
 *     FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY). The private key is stored
 *     with literal "\n" escapes in env and restored to real newlines here.
 *   - Local dev: if FIRESTORE_EMULATOR_HOST is set, the Admin SDK talks to the
 *     Firestore emulator and no service-account credentials are required.
 */
let db: Firestore | null = null;

function initAdminApp(): App {
  // getApps() is a process-global registry — guards against re-init across
  // Next.js dev hot-reloads (which would otherwise throw "app already exists").
  const existing = getApps();
  if (existing.length > 0) return existing[0]!;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const usingEmulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

  if (usingEmulator) {
    // Emulator bypasses credentials; only a project id is needed for routing.
    return initializeApp({ projectId: projectId ?? "demo-dialectic" });
  }

  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const rawPrivateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !rawPrivateKey) {
    throw new Error(
      "Missing Firebase Admin credentials. Set FIREBASE_PROJECT_ID, " +
        "FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY in .env.local " +
        "(or set FIRESTORE_EMULATOR_HOST to use the local emulator).",
    );
  }

  // Env stores the PEM on one line with literal "\n"; restore real newlines.
  const privateKey = rawPrivateKey.replace(/\\n/g, "\n");

  return initializeApp({
    credential: cert({ projectId, clientEmail, privateKey }),
  });
}

export function getDb(): Firestore {
  if (!db) {
    db = getFirestore(initAdminApp());
  }
  return db;
}
