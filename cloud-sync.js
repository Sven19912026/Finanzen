(function(){
  const APP_ID = window.CLOUD_APP_ID;
  const statusEl = document.getElementById('cloudStatus');
  const authLayer = document.getElementById('authLayer');
  const emailEl = document.getElementById('authEmail');
  const passEl = document.getElementById('authPassword');
  const msgEl = document.getElementById('authMessage');
  let db=null, auth=null, uid=null, unsubscribe=null, saveTimer=null, applyingRemote=false, cloudReady=false;

  function setStatus(text, state=''){
    if(!statusEl) return;
    statusEl.textContent=text;
    statusEl.dataset.state=state;
  }
  function validConfig(c){return c && c.apiKey && !String(c.apiKey).includes('HIER_EINTRAGEN') && c.projectId && !String(c.projectId).includes('HIER_EINTRAGEN')}
  function showAuth(show){if(authLayer) authLayer.classList.toggle('hidden',!show)}
  function errText(e){
    const m={
      'auth/invalid-credential':'E-Mail oder Passwort ist falsch.',
      'auth/email-already-in-use':'Für diese E-Mail gibt es bereits ein Konto.',
      'auth/weak-password':'Das Passwort muss mindestens 6 Zeichen lang sein.',
      'auth/invalid-email':'Bitte eine gültige E-Mail-Adresse eingeben.',
      'auth/network-request-failed':'Keine Internetverbindung.'
    };
    return m[e?.code] || e?.message || 'Unbekannter Fehler';
  }
  window.scheduleCloudSave=function(){
    if(applyingRemote || !cloudReady || !uid) return;
    clearTimeout(saveTimer);
    setStatus('Speichert …','sync');
    saveTimer=setTimeout(pushState,500);
  };
  async function pushState(){
    if(!cloudReady || !uid) return;
    try{
      const payload=window.exportCloudState();
      await db.collection('users').doc(uid).collection('apps').doc(APP_ID).set({
        ...payload, schemaVersion:1, updatedAt:firebase.firestore.FieldValue.serverTimestamp(), updatedAtClient:new Date().toISOString()
      },{merge:false});
      setStatus('Cloud aktuell','ok');
      await dailyBackup(payload);
    }catch(e){console.error(e);setStatus('Cloudfehler','error')}
  }
  async function dailyBackup(payload){
    const day=new Date().toISOString().slice(0,10);
    const marker='cloud_backup_'+APP_ID+'_'+day;
    if(localStorage.getItem(marker)) return;
    try{
      await db.collection('users').doc(uid).collection('apps').doc(APP_ID).collection('backups').doc(day).set({
        ...payload, createdAt:firebase.firestore.FieldValue.serverTimestamp(), dateKey:day, reason:'Taegliche automatische Sicherung'
      });
      localStorage.setItem(marker,'1');
    }catch(e){console.warn('Backup nicht erstellt',e)}
  }
  function subscribe(){
    if(unsubscribe) unsubscribe();
    cloudReady=false;
    const ref=db.collection('users').doc(uid).collection('apps').doc(APP_ID);
    unsubscribe=ref.onSnapshot({includeMetadataChanges:true},async snap=>{
      // Firestore kann beim Start zuerst einen leeren lokalen Cache melden.
      // Dieser Zwischenstand darf niemals die vorhandenen Serverdaten überschreiben.
      if(snap.metadata?.fromCache){
        setStatus('Cloud lädt …','sync');
        return;
      }

      if(!snap.exists){
        cloudReady=true;
        setStatus('Lokale Daten werden hochgeladen …','sync');
        await pushState();
        return;
      }

      const remote=snap.data();
      const local=window.exportCloudState();
      const remoteJson=JSON.stringify(window.normalizeCloudState(remote));
      const localJson=JSON.stringify(window.normalizeCloudState(local));
      if(remoteJson!==localJson){
        applyingRemote=true;
        try{
          window.importCloudState(remote);
        }finally{
          applyingRemote=false;
        }
      }
      cloudReady=true;
      setStatus('Cloud aktuell','ok');
      await dailyBackup(window.exportCloudState());
    },e=>{console.error(e);cloudReady=false;setStatus('Cloud nicht erreichbar','error')});
  }
  async function login(create){
    msgEl.textContent='';
    const email=emailEl.value.trim(), pass=passEl.value;
    if(!email || pass.length<6){msgEl.textContent='E-Mail und Passwort mit mindestens 6 Zeichen eingeben.';return}
    try{
      if(create) await auth.createUserWithEmailAndPassword(email,pass);
      else await auth.signInWithEmailAndPassword(email,pass);
    }catch(e){msgEl.textContent=errText(e)}
  }
  window.cloudLogin=()=>login(false);
  window.cloudRegister=()=>login(true);
  window.cloudLogout=()=>auth?.signOut();

  const config=window.PRIVATE_FIREBASE_CONFIG;
  if(!validConfig(config)){
    setStatus('Firebase noch einrichten','error');
    showAuth(true);
    msgEl.textContent='Zuerst die Werte in firebase-config.js eintragen.';
    document.querySelectorAll('#authLayer button').forEach(b=>b.disabled=true);
    return;
  }
  try{
    if(!firebase.apps.length) firebase.initializeApp(config);
    auth=firebase.auth(); db=firebase.firestore();
    db.enablePersistence({synchronizeTabs:true}).catch(()=>{});
    auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
    auth.onAuthStateChanged(user=>{
      if(user){uid=user.uid;showAuth(false);setStatus('Cloud verbindet …','sync');subscribe()}
      else{uid=null;cloudReady=false;if(unsubscribe)unsubscribe();showAuth(true);setStatus('Nicht angemeldet','error')}
    });
  }catch(e){console.error(e);setStatus('Firebase-Fehler','error');showAuth(true);msgEl.textContent=errText(e)}
})();
