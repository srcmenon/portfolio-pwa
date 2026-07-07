/* ============================================================
   CapIntel — db.js
   Firebase Auth + Firestore initialisation.
   Replaces IndexedDB entirely (see architecture note in memory —
   this file used to open a local "portfolioDB" IndexedDB database;
   that is gone, data now lives in Firestore under users/{uid}/...).

   Load order in index.html:
   1. Firebase SDK <script type="module"> block (app/auth/firestore)
   2. THIS file (db.js)
   3. app.js

   Auth flow:
   - On page load, shows the #loginGate overlay and hides #appRoot.
   - onAuthStateChanged fires once Firebase resolves whether a user
     is already signed in (persisted session) or not.
   - If signed in: hide #loginGate, show #appRoot, call startApp()
     from app.js — same contract as the old initDB() → startApp().
   - If not signed in: show #loginGate, wait for the login form submit.

   Firestore paths (all data is scoped under the signed-in user's UID):
     users/{uid}/assets/{docId}           — one doc per buy lot
     users/{uid}/portfolioHistory/{docId} — one doc per snapshot

   IMPORTANT: doc IDs from Firestore are random alphanumeric STRINGS,
   not sequential integers like the old IndexedDB autoIncrement keys.
   Every asset document now carries an explicit `createdAt` (Date.now())
   field written at save time — this is what "Sort: Date Added" in
   app.js reads, NOT the doc ID (Firestore IDs are deliberately
   randomised for write-scaling and carry no chronological meaning).
   ============================================================ */

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js"
import {
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js"
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  collection,
  doc,
  addDoc,
  getDocs,
  getDoc,
  deleteDoc,
  updateDoc,
  writeBatch,
  query,
  orderBy
} from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js"

/* ── Your Firebase project config ── */
const firebaseConfig = {
  apiKey:            "AIzaSyDQ60vw7W8dvoJFSd-2nf9Vlq90Q-h92cA",
  authDomain:        "capintel070726.firebaseapp.com",
  projectId:         "capintel070726",
  storageBucket:     "capintel070726.firebasestorage.app",
  messagingSenderId: "340420536163",
  appId:             "1:340420536163:web:63b6caef5dd9998dd41556"
  /* measurementId intentionally omitted — Analytics not used */
}

const firebaseApp = initializeApp(firebaseConfig)
const auth        = getAuth(firebaseApp)

/* Firestore with offline persistence — modern API (enableIndexedDbPersistence
   is deprecated). Multi-tab manager avoids a "failed-precondition" error if
   you ever have the app open in two browser tabs on the same machine. */
const firestoreDb = initializeFirestore(firebaseApp, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager()
  })
})

/* ── Globals used throughout app.js ──────────────────────
   `db` is kept as the variable name app.js already expects
   (minimises changes elsewhere) but it is now a Firestore
   instance, not an IndexedDB database handle.
   `currentUid` is set once auth resolves — every Firestore
   path in app.js is built as `users/${currentUid}/...`. */
let db = firestoreDb
let currentUid = null

window._firebaseAuth = auth
window._getUid = () => currentUid

/* app.js is a classic (non-module) script and cannot use `import`.
   Expose exactly the Firestore functions it needs here, plus the
   db instance itself. app.js calls these as window._fs.addDoc(...) etc. */
window._fs = {
  db: firestoreDb,
  collection, doc, addDoc, getDocs, getDoc, deleteDoc, updateDoc,
  writeBatch, query, orderBy
}

/* ── Auth state listener ──────────────────────────────────
   Fires on page load (checks persisted session) and again
   whenever sign-in/sign-out happens. */
onAuthStateChanged(auth, user => {
  const gate    = document.getElementById("loginGate")
  const appRoot = document.getElementById("appRoot")

  if (user) {
    currentUid = user.uid
    if (gate)    gate.style.display = "none"
    if (appRoot) appRoot.style.display = "contents"
    if (typeof startApp === "function") {
      startApp()
    }
  } else {
    currentUid = null
    if (gate)    gate.style.display = "flex"
    if (appRoot) appRoot.style.display = "none"
  }
})

/* ── Login form handlers — called from index.html ── */
window.handleLogin = async function(){
  const emailEl = document.getElementById("loginEmail")
  const passEl  = document.getElementById("loginPassword")
  const errEl   = document.getElementById("loginError")
  const btn     = document.getElementById("loginBtn")

  const email    = emailEl?.value?.trim()
  const password = passEl?.value

  if (errEl) errEl.textContent = ""
  if (!email || !password) {
    if (errEl) errEl.textContent = "Enter both email and password."
    return
  }

  if (btn) { btn.disabled = true; btn.textContent = "Signing in…" }

  try {
    await signInWithEmailAndPassword(auth, email, password)
    /* onAuthStateChanged above handles showing the app */
  } catch (e) {
    if (errEl) {
      errEl.textContent = e.code === "auth/invalid-credential" || e.code === "auth/wrong-password" || e.code === "auth/user-not-found"
        ? "Incorrect email or password."
        : `Sign-in failed: ${e.message}`
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Sign in" }
  }
}

window.handleLogout = async function(){
  if (!confirm("Sign out of CapIntel?")) return
  await signOut(auth)
  /* onAuthStateChanged above handles showing the login gate */
}
