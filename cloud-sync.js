import { firebaseConfig } from './firebase-config.js';

const get = (id) => document.getElementById('cloud-' + id);
const log = window.trainingLog;
const panel = document.getElementById('cloud');
panel.hidden = false;

if (firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.appId) {
  startCloud().catch(() => {
    panel.open = true;
    get('status').textContent = 'Online opslag is onbereikbaar. Je log op dit apparaat is nog beschikbaar.';
  });
} else {
  get('status').textContent = 'Firebase is nog niet ingesteld. Je log staat op dit apparaat.';
}

async function startCloud() {
  const sdk = 'https://www.gstatic.com/firebasejs/13.3.0/';
  const [appSDK, authSDK, dbSDK] = await Promise.all([
    import(sdk + 'firebase-app.js'),
    import(sdk + 'firebase-auth.js'),
    import(sdk + 'firebase-firestore.js')
  ]);
  const app = appSDK.initializeApp(firebaseConfig);
  const auth = authSDK.getAuth(app);
  const db = dbSDK.getFirestore(app);
  const form = get('login');
  const signIn = form.querySelector('button');
  const upload = get('upload');
  const download = get('download');
  const refresh = get('refresh');
  const logout = get('logout');
  const status = get('status');
  const summary = panel.querySelector('summary');
  let user = null;
  let busy = false;
  let queued = false;
  let generation = 0;

  function signedIn() {
    return user !== null && auth.currentUser?.uid === user.uid;
  }

  function show(message, { canUpload = false, canDownload = false } = {}) {
    status.textContent = message;
    summary.textContent = signedIn() ? 'Online opslag · ' + message : 'Online opslag';
    upload.hidden = !canUpload;
    download.hidden = !canDownload;
    if (canUpload || canDownload) panel.open = true;
  }

  function context() {
    const uid = user.uid;
    const key = 'trainingslog.firebase.' + firebaseConfig.projectId + '.' + uid;
    const ref = dbSDK.doc(db, 'trainingLogs', uid);
    return { key, ref };
  }

  function readBase(key) {
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) : null;
  }

  function remember(key, cloud) {
    localStorage.setItem(key, JSON.stringify(cloud));
  }

  function checkedSnapshot(snapshot) {
    if (!snapshot.exists()) return null;
    const value = snapshot.data();
    if (typeof value.revision !== 'string' || typeof value.payload !== 'string') {
      throw Error('De online versie heeft een onbekend formaat.');
    }
    return value;
  }

  async function push(ref, baseline, payload) {
    if (new TextEncoder().encode(payload).length > 950_000) {
      throw Error('Je log is te groot voor deze online opslag. Exporteer je log als back-up.');
    }
    const next = { revision: crypto.randomUUID(), payload };
    return dbSDK.runTransaction(db, async (transaction) => {
      const current = checkedSnapshot(await transaction.get(ref));
      if (current?.payload === payload) return current;
      if ((current?.revision ?? null) !== (baseline?.revision ?? null)) return null;
      transaction.set(ref, next);
      return next;
    });
  }

  async function reconcile(action = 'auto') {
    if (!signedIn()) return;
    if (busy) {
      if (action === 'auto') queued = true;
      return;
    }

    const expectedGeneration = generation;
    const active = () => signedIn() && generation === expectedGeneration;
    busy = true;
    refresh.disabled = upload.disabled = download.disabled = logout.disabled = true;
    try {
      const { key, ref } = context();
      const remote = checkedSnapshot(await dbSDK.getDocFromServer(ref));
      if (!active()) return;
      const local = log.payload();
      const base = readBase(key);

      if (remote?.payload === local) {
        remember(key,remote);
        show('Online opgeslagen.');
        return;
      }

      if (action === 'download' && remote) {
        const replacesLocal = (local && local !== base?.payload) || log.hasDraft();
        if (replacesLocal && !window.confirm('De cloudversie vervangt dit lokale log. Exporteer eerst een back-up als je de lokale wijzigingen wilt bewaren. Cloudversie ophalen?')) {
          show('De twee versies zijn nog apart. Maak zo nodig een back-up.', { canDownload:true });
          return;
        }
        log.applyCloud(remote.payload);
        remember(key,remote);
        show('Online log opgehaald.');
        return;
      }

      const localChanged = local && local !== base?.payload;
      if (localChanged && ((remote && base?.revision === remote.revision) || (action === 'upload' && !remote && !base))) {
        const saved = await push(ref,remote,local);
        if (!active()) return;
        if (saved) {
          remember(key,saved);
          show(log.payload() === local ? 'Online opgeslagen.' : 'Online opslaan…');
        } else {
          show('De online versie is net gewijzigd. Synchroniseer opnieuw.');
        }
        return;
      }

      if (!remote) {
        if (base) {
          show('Je online log ontbreekt. Je lokale log blijft beschikbaar. Controleer je Firebase-project.');
        } else if (local) {
          show('Sla je bestaande log één keer online op om te beginnen.', { canUpload:true });
        } else {
          show('Nog geen online log. Importeer je trainingsbestand als dit je eerste apparaat is.');
        }
        return;
      }

      if (localChanged || log.hasDraft()) {
        show('Dit apparaat en de cloud hebben verschillende gegevens. Exporteer zo nodig eerst een lokale back-up.', { canDownload:true });
        return;
      }

      log.applyCloud(remote.payload);
      remember(key,remote);
      show('Online log opgehaald.');
    } catch (error) {
      if (!active()) return;
      if (error.code === 'permission-denied') {
        show('Firebase geeft dit account geen toegang. Controleer de Firestore-regels en je gebruikers-ID.');
      } else if (error.code === 'unavailable' || !navigator.onLine) {
        show('Geen verbinding. Lokale wijzigingen worden opnieuw geprobeerd zodra je online bent.');
      } else {
        const message = error.code ? 'Synchroniseren is mislukt. Je lokale log is nog beschikbaar.' : error.message;
        show(message);
      }
    } finally {
      busy = false;
      refresh.disabled = upload.disabled = download.disabled = logout.disabled = false;
      if (queued) {
        queued = false;
        void reconcile();
      }
    }
  }

  authSDK.onAuthStateChanged(auth, (current) => {
    generation += 1;
    user = current;
    form.hidden = Boolean(current);
    refresh.hidden = logout.hidden = !current;
    if (current) {
      show('Je online log ophalen…');
      void reconcile();
    } else {
      panel.open = true;
      show('Log in om je trainingen online te bewaren.');
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    signIn.disabled = true;
    show('Inloggen…');
    try {
      await authSDK.signInWithEmailAndPassword(auth,form.elements.email.value.trim(),form.elements.password.value);
      form.elements.password.value = '';
    } catch (error) {
      show(error.code === 'auth/network-request-failed'
        ? 'Inloggen is mislukt door een verbindingsprobleem.'
        : 'Inloggen is mislukt. Controleer je e-mailadres en wachtwoord.');
    } finally {
      signIn.disabled = false;
    }
  });
  upload.onclick = () => reconcile('upload');
  download.onclick = () => reconcile('download');
  refresh.onclick = () => reconcile();
  logout.onclick = async () => {
    try {
      await authSDK.signOut(auth);
    } catch {
      show('Uitloggen is mislukt. Probeer opnieuw.');
    }
  };
  window.addEventListener('trainingslog:save', () => { if (signedIn()) show('Online opslaan…'); void reconcile(); });
  window.addEventListener('online', () => reconcile());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void reconcile(); });
}
