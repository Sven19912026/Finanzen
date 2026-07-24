(function(){
  const APP_ID = window.CLOUD_APP_ID;
  const statusEl = document.getElementById('cloudStatus');
  const authLayer = document.getElementById('authLayer');
  const emailEl = document.getElementById('authEmail');
  const passEl = document.getElementById('authPassword');
  const msgEl = document.getElementById('authMessage');
  const backupDialog = document.getElementById('backupDialog');
  const backupListEl = document.getElementById('backupList');
  const backupMessageEl = document.getElementById('backupMessage');

  let db = null;
  let auth = null;
  let uid = null;
  let unsubscribe = null;
  let saveTimer = null;
  let applyingRemote = false;
  let cloudReady = false;
  let restoringBackup = false;
  let lastProtectionMessage = '';
  let syncInProgress = false;

  function setStatus(text, state = ''){
    if(!statusEl) return;
    statusEl.textContent = text;
    statusEl.dataset.state = state;
  }

  function validConfig(config){
    return config
      && config.apiKey
      && !String(config.apiKey).includes('HIER_EINTRAGEN')
      && config.projectId
      && !String(config.projectId).includes('HIER_EINTRAGEN');
  }

  function showAuth(show){
    if(authLayer) authLayer.classList.toggle('hidden', !show);
  }

  function errText(error){
    const messages = {
      'auth/invalid-credential': 'E-Mail oder Passwort ist falsch.',
      'auth/email-already-in-use': 'Für diese E-Mail gibt es bereits ein Konto.',
      'auth/weak-password': 'Das Passwort muss mindestens 6 Zeichen lang sein.',
      'auth/invalid-email': 'Bitte eine gültige E-Mail-Adresse eingeben.',
      'auth/network-request-failed': 'Keine Internetverbindung.',
    };
    return messages[error?.code] || error?.message || 'Unbekannter Fehler';
  }

  function normalizedState(source){
    if(typeof window.normalizeCloudState === 'function'){
      return window.normalizeCloudState(source || {});
    }
    return {
      debts: Array.isArray(source?.debts) ? source.debts : [],
      items: Array.isArray(source?.items) ? source.items : [],
      trash: Array.isArray(source?.trash) ? source.trash : [],
      history: Array.isArray(source?.history) ? source.history : [],
      balances: source?.balances || { n26: 0, ps3838: 0, cash: 0 },
    };
  }

  function counts(source){
    const state = normalizedState(source);
    return {
      debts: state.debts.length,
      items: state.items.length,
      trash: state.trash.length,
      history: state.history.length,
      balanceTotal: Number(state.balances?.n26 || 0) + Number(state.balances?.ps3838 || 0) + Number(state.balances?.cash || 0),
      total: state.debts.length + state.items.length + state.trash.length + state.history.length,
    };
  }

  function hasUsefulData(source){
    const value = counts(source);
    return value.debts > 0 || value.items > 0 || value.trash > 0 || value.history > 0 || Math.abs(value.balanceTotal) > 0.001;
  }

  function destructiveEmptyReason(localState, remoteState){
    const local = counts(localState);
    const remote = counts(remoteState);
    const reasons = [];
    if(remote.debts > 0 && local.debts === 0) reasons.push(`${remote.debts} Gesamtschulden`);
    if(remote.items > 0 && local.items === 0) reasons.push(`${remote.items} Monatszahlungen`);
    if(remote.history > 0 && local.history === 0) reasons.push(`${remote.history} Historieneinträge`);
    return reasons.length ? reasons.join(', ') : '';
  }

  function safeTimestamp(){
    return new Date().toISOString().replace(/[:.]/g, '-');
  }

  function appRef(){
    return db.collection('users').doc(uid).collection('apps').doc(APP_ID);
  }

  function backupsRef(){
    return appRef().collection('backups');
  }

  async function createSafetyBackup(payload, reason){
    if(!uid || !hasUsefulData(payload)) return null;
    const id = `safety-${safeTimestamp()}`;
    const data = normalizedState(payload);
    await backupsRef().doc(id).set({
      ...data,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      dateKey: new Date().toISOString().slice(0, 10),
      reason: reason || 'Automatische Sicherung vor Cloud-Schreiben',
      backupType: 'safety',
    });
    return id;
  }

  async function dailyBackup(payload){
    if(!uid || !hasUsefulData(payload)) return;
    const day = new Date().toISOString().slice(0, 10);
    const ref = backupsRef().doc(day);
    try{
      const existing = await ref.get();
      // Ein vorhandenes Tagesbackup wird niemals überschrieben.
      if(existing.exists) return;
      await ref.set({
        ...normalizedState(payload),
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        dateKey: day,
        reason: 'Tägliche automatische Sicherung',
        backupType: 'daily',
      });
    }catch(error){
      console.warn('Tagesbackup konnte nicht erstellt werden.', error);
    }
  }

  window.scheduleCloudSave = function(){
    if(applyingRemote || restoringBackup || syncInProgress || !cloudReady || !uid) return;
    clearTimeout(saveTimer);
    setStatus('Speichert …', 'sync');
    saveTimer = setTimeout(() => pushState(), 650);
  };

  async function pushState(options = {}){
    const { force = false, skipSafety = false, reason = 'Automatische Sicherung vor Cloud-Schreiben' } = options;
    if(!cloudReady || !uid || syncInProgress) return false;

    syncInProgress = true;
    try{
      const payload = normalizedState(window.exportCloudState());
      const ref = appRef();
      let remoteData = null;

      try{
        const remoteSnapshot = await ref.get({ source: 'server' });
        if(remoteSnapshot.exists) remoteData = remoteSnapshot.data();
      }catch(error){
        console.warn('Serverstand konnte vor dem Schreiben nicht geprüft werden.', error);
        if(!force){
          setStatus('Cloud-Prüfung fehlgeschlagen', 'error');
          return false;
        }
      }

      if(remoteData && !force){
        const danger = destructiveEmptyReason(payload, remoteData);
        if(danger){
          setStatus('Schutz aktiv – nichts überschrieben', 'error');
          const message = `Sicherheitsstopp: Der lokale Stand enthält keine Daten für ${danger}, die Cloud aber schon. Es wurde nichts überschrieben. Öffne „Cloud-Backups“, wenn du einen Stand wiederherstellen möchtest.`;
          if(lastProtectionMessage !== message){
            lastProtectionMessage = message;
            window.alert(message);
          }
          return false;
        }
      }

      // Ein komplett leerer Erststand wird nicht automatisch in die Cloud geschrieben.
      if(!remoteData && !hasUsefulData(payload) && !force){
        setStatus('Cloud leer – keine Daten gespeichert', 'error');
        return false;
      }

      if(remoteData && !skipSafety){
        await createSafetyBackup(remoteData, reason);
      }

      await ref.set({
        ...payload,
        schemaVersion: 3,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAtClient: new Date().toISOString(),
      }, { merge: false });

      setStatus('Cloud aktuell', 'ok');
      await dailyBackup(payload);
      return true;
    }catch(error){
      console.error(error);
      setStatus('Cloudfehler', 'error');
      return false;
    }finally{
      syncInProgress = false;
    }
  }

  function subscribe(){
    if(unsubscribe) unsubscribe();
    cloudReady = false;
    const ref = appRef();

    unsubscribe = ref.onSnapshot(async snapshot => {
      if(restoringBackup || syncInProgress) return;
      if(snapshot.metadata?.hasPendingWrites) return;

      // Der erste leere Offline-Cache darf niemals als echter Serverstand gelten.
      if(snapshot.metadata?.fromCache){
        setStatus('Cloud lädt …', 'sync');
        return;
      }

      if(!snapshot.exists){
        cloudReady = true;
        const local = normalizedState(window.exportCloudState());
        if(hasUsefulData(local)){
          setStatus('Lokale Daten werden hochgeladen …', 'sync');
          await pushState();
        }else{
          setStatus('Cloud leer – Backup prüfen', 'error');
        }
        return;
      }

      const remote = snapshot.data();
      const local = window.exportCloudState();
      const remoteJson = JSON.stringify(normalizedState(remote));
      const localJson = JSON.stringify(normalizedState(local));
      let mergedNeedsUpload = false;

      if(remoteJson !== localJson){
        applyingRemote = true;
        try{
          mergedNeedsUpload = Boolean(window.importCloudState(remote));
        }finally{
          applyingRemote = false;
        }
      }

      cloudReady = true;
      if(mergedNeedsUpload){
        setStatus('Daten werden zusammengeführt …', 'sync');
        await pushState({ reason: 'Sicherung vor Zusammenführung' });
        return;
      }

      setStatus('Cloud aktuell', 'ok');
      await dailyBackup(window.exportCloudState());
    }, error => {
      console.error(error);
      cloudReady = false;
      setStatus('Cloud nicht erreichbar', 'error');
    });
  }

  function escapeHtml(value){
    return String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[char]));
  }

  function backupDateLabel(entry){
    const data = entry.data;
    if(data?.dateKey){
      const date = new Date(`${data.dateKey}T00:00:00`);
      if(!Number.isNaN(date.getTime())) return date.toLocaleDateString('de-DE');
    }
    if(data?.createdAt?.toDate){
      return data.createdAt.toDate().toLocaleString('de-DE');
    }
    if(/^\d{4}-\d{2}-\d{2}$/.test(entry.id)){
      return new Date(`${entry.id}T00:00:00`).toLocaleDateString('de-DE');
    }
    return entry.id.replace(/^safety-/, 'Sicherung ');
  }

  async function loadBackups(){
    if(!uid || !backupListEl) return;
    backupMessageEl.textContent = 'Backups werden geladen …';
    backupListEl.innerHTML = '';
    try{
      const snapshot = await backupsRef().get();
      const entries = snapshot.docs.map(doc => ({ id: doc.id, data: doc.data() }));
      entries.sort((a, b) => {
        const aTime = a.data?.createdAt?.toMillis?.() || Date.parse(a.data?.dateKey || a.id) || 0;
        const bTime = b.data?.createdAt?.toMillis?.() || Date.parse(b.data?.dateKey || b.id) || 0;
        return bTime - aTime;
      });

      backupMessageEl.textContent = entries.length
        ? `${entries.length} Sicherung${entries.length === 1 ? '' : 'en'} gefunden.`
        : 'Keine Cloud-Backups gefunden.';

      backupListEl.innerHTML = entries.map(entry => {
        const count = counts(entry.data);
        const label = backupDateLabel(entry);
        const reason = entry.data?.reason || (entry.id.startsWith('safety-') ? 'Sicherheitsbackup' : 'Tagesbackup');
        return `<div class="backup-entry">
          <div class="backup-entry-main">
            <strong>${escapeHtml(label)}</strong>
            <div class="meta">${escapeHtml(reason)}</div>
            <div class="backup-counts">${count.debts} Schulden · ${count.items} Monatszahlungen · ${count.history} Verlauf · Kontostände ${new Intl.NumberFormat('de-DE',{style:'currency',currency:'EUR'}).format(count.balanceTotal)}</div>
          </div>
          <button class="btn success" onclick="cloudRestoreBackup('${escapeHtml(entry.id)}')">Wiederherstellen</button>
        </div>`;
      }).join('');
    }catch(error){
      console.error(error);
      backupMessageEl.textContent = 'Backups konnten nicht geladen werden.';
    }
  }

  window.cloudOpenBackups = async function(){
    if(!uid){
      window.alert('Bitte zuerst bei der privaten Cloud anmelden.');
      return;
    }
    if(!backupDialog){
      window.alert('Die Backup-Ansicht ist in dieser App-Version nicht vorhanden.');
      return;
    }
    backupDialog.showModal();
    await loadBackups();
  };

  window.cloudRefreshBackups = loadBackups;

  window.cloudRestoreBackup = async function(backupId){
    if(!uid || !backupId || restoringBackup) return;
    try{
      const backupSnapshot = await backupsRef().doc(backupId).get();
      if(!backupSnapshot.exists){
        window.alert('Dieses Backup wurde nicht gefunden.');
        return;
      }

      const backupData = normalizedState(backupSnapshot.data());
      const count = counts(backupData);
      if(!hasUsefulData(backupData)){
        window.alert('Dieses Backup ist leer und wird deshalb nicht wiederhergestellt.');
        return;
      }

      const confirmed = window.confirm(
        `Backup wiederherstellen?\n\n${count.debts} Gesamtschulden\n${count.items} Monatszahlungen\n${count.history} Historieneinträge\nKontostände: ${new Intl.NumberFormat('de-DE',{style:'currency',currency:'EUR'}).format(count.balanceTotal)}\n\nDer aktuelle Cloud-Stand wird vorher zusätzlich gesichert.`
      );
      if(!confirmed) return;

      restoringBackup = true;
      cloudReady = false;
      setStatus('Backup wird wiederhergestellt …', 'sync');
      if(backupMessageEl) backupMessageEl.textContent = 'Wiederherstellung läuft …';

      const currentSnapshot = await appRef().get({ source: 'server' });
      if(currentSnapshot.exists && hasUsefulData(currentSnapshot.data())){
        await createSafetyBackup(currentSnapshot.data(), `Automatische Sicherung vor Wiederherstellung von ${backupId}`);
      }

      applyingRemote = true;
      try{
        if(typeof window.replaceCloudState !== 'function'){
          throw new Error('replaceCloudState ist nicht verfügbar.');
        }
        window.replaceCloudState(backupData);
      }finally{
        applyingRemote = false;
      }

      await appRef().set({
        ...backupData,
        schemaVersion: 3,
        restoredFromBackup: backupId,
        restoredAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAtClient: new Date().toISOString(),
      }, { merge: false });

      cloudReady = true;
      restoringBackup = false;
      setStatus('Backup wiederhergestellt', 'ok');
      if(backupDialog.open) backupDialog.close();
      window.alert(`Backup erfolgreich wiederhergestellt: ${count.debts} Schulden und ${count.items} Monatszahlungen.`);
    }catch(error){
      console.error(error);
      restoringBackup = false;
      cloudReady = true;
      setStatus('Wiederherstellung fehlgeschlagen', 'error');
      if(backupMessageEl) backupMessageEl.textContent = 'Wiederherstellung fehlgeschlagen.';
      window.alert(`Backup konnte nicht wiederhergestellt werden: ${errText(error)}`);
    }
  };

  async function login(create){
    if(msgEl) msgEl.textContent = '';
    const email = emailEl?.value.trim() || '';
    const password = passEl?.value || '';
    if(!email || password.length < 6){
      if(msgEl) msgEl.textContent = 'E-Mail und Passwort mit mindestens 6 Zeichen eingeben.';
      return;
    }
    try{
      if(create) await auth.createUserWithEmailAndPassword(email, password);
      else await auth.signInWithEmailAndPassword(email, password);
    }catch(error){
      if(msgEl) msgEl.textContent = errText(error);
    }
  }

  window.cloudLogin = () => login(false);
  window.cloudRegister = () => login(true);
  window.cloudLogout = () => auth?.signOut();

  const config = window.PRIVATE_FIREBASE_CONFIG;
  if(!validConfig(config)){
    setStatus('Firebase noch einrichten', 'error');
    showAuth(true);
    if(msgEl) msgEl.textContent = 'Zuerst die Werte in firebase-config.js eintragen.';
    document.querySelectorAll('#authLayer button').forEach(button => { button.disabled = true; });
    return;
  }

  try{
    if(!firebase.apps.length) firebase.initializeApp(config);
    auth = firebase.auth();
    db = firebase.firestore();
    db.enablePersistence({ synchronizeTabs: true }).catch(() => {});
    auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
    auth.onAuthStateChanged(user => {
      if(user){
        uid = user.uid;
        if(emailEl) emailEl.value = '';
        if(passEl) passEl.value = '';
        showAuth(false);
        setStatus('Cloud verbindet …', 'sync');
        subscribe();
      }else{
        uid = null;
        cloudReady = false;
        if(unsubscribe) unsubscribe();
        showAuth(true);
        setStatus('Nicht angemeldet', 'error');
      }
    });
  }catch(error){
    console.error(error);
    setStatus('Firebase-Fehler', 'error');
    showAuth(true);
    if(msgEl) msgEl.textContent = errText(error);
  }
})();
