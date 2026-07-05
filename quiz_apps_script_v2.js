// ============================================================
// QuizForge — Google Apps Script v2
// Architettura: repository domande separato dai risultati
// ============================================================
// Distribuisci come App Web:
//   - Esegui come: Me (franapoli@gmail.com)
//   - Chi può accedere: Chiunque
// ============================================================

const VERSION = "2.24.2"; // aggiornare ad ogni deploy

// ID di default dei due Google Sheets (fallback se non configurati via ScriptProperties)
const SHEET_QUESTIONS_ID_DEFAULT = "1qrDVCr4yxBHD3qINQSl-Jk4hIU-O4OS4NVHXa3nbOzQ";
const SHEET_RESULTS_ID_DEFAULT   = "1WQ1fnjN-j3o5yxjtH66qkmPIO532Y5t-DTSSK0MhOgA";
// Cartella Drive dove risiedono i fogli gestiti (default = cartella QuizForge)
const DRIVE_FOLDER_ID_DEFAULT    = "1FCl15simn4Ev363a59aEfOq1qZF4T78H";

// Legge gli ID attivi: prima da ScriptProperties, poi dal default hardcoded.
// ScriptProperties è indipendente da entrambi i fogli → nessuna circolarità.
function getSheetQuestionsId() {
  return PropertiesService.getScriptProperties().getProperty("SHEET_QUESTIONS_ID") || SHEET_QUESTIONS_ID_DEFAULT;
}
function getSheetResultsId() {
  return PropertiesService.getScriptProperties().getProperty("SHEET_RESULTS_ID") || SHEET_RESULTS_ID_DEFAULT;
}
function getDriveFolderId() {
  return PropertiesService.getScriptProperties().getProperty("DRIVE_FOLDER_ID") || DRIVE_FOLDER_ID_DEFAULT;
}

// Indici colonne foglio risultati (1-based, identici a v1)
const COL_MATRICOLA  = 1;
const COL_NOMINATIVO = 2;
const COL_EMAIL      = 3;
const COL_SCORE      = 4;
const COL_TOTALE     = 5;
const COL_TS_START   = 6;
const COL_TS_END     = 7;
const COL_ELAPSED    = 8;
const COL_QIDS       = 9; // IDs domande assegnate (comma-separated)
const COL_ANS_FIRST  = 10; // Dom1, Pt1, Dom2, Pt2, ...

// Indici colonne foglio "questions" (0-based)
const Q_ID            = 0;  // A
const Q_CORSO         = 1;  // B
const Q_CATEGORIA     = 2;  // C
const Q_SOTTOCATEG    = 3;  // D
const Q_TAGS          = 4;  // E  tag separati da virgola (es. "blast,phylogeny")
const Q_STATO         = 5;  // F  "bozza" | "verificato"
const Q_TIPO          = 6;  // G  "mc" | "fitb" | "match" | "free" | "multi-fitb" | "cloze"
const Q_TESTO         = 7;  // H
const Q_OPTIONS       = 8;  // I  JSON array di opzioni (mc/match); vuoto per fitb/free/cloze/multi-fitb
const Q_CORRETTA      = 9;  // J  lettera A-Z (mc), testo esatto (fitb), JSON array destra (match)
const Q_PUNTI         = 10; // K
const Q_PLACEHOLDER   = 11; // L  solo per fitb
const Q_DATA          = 12; // M  JSON per tipi complessi (multi-fitb, cloze)

// Tracce sheet — solo template domande, riutilizzabili (3 colonne)
const T_ID    = 0;  // A  track_id (t-<6char>)
const T_NOME  = 1;  // B  nome traccia
const T_ITEMS = 2;  // C  JSON array items

// Esami sheet — sessioni d'esame contestualizzate (9 colonne)
const E_ID       = 0;  // A  exam_id (YYYY-MM-DD-<6char>)
const E_TRACCIA  = 1;  // B  traccia_id
const E_NOME     = 2;  // C  nome esame (se vuoto usa nome traccia)
const E_DATA     = 3;  // D  data YYYY-MM-DD
const E_DURATA   = 4;  // E  durata minuti
const E_CORSO    = 5;  // F  nome corso
const E_MODALITA = 6;  // G  "exam" | "practice"
const E_STATO    = 7;  // H  "open" | "closed"
const E_PASSWORD = 8;  // I  password accesso (solo exam; vuota = nessuna)
const E_SHUFFLE  = 9;  // J  "no" = shuffle disabilitato; vuoto/"si" = abilitato (default)

// Colonne foglio "Esami" nel foglio risultati (specchio di esami) — 0-based
const META_COLS = {
  exam_id:    0,  // A
  traccia_id: 1,  // B
  // col 2 (C) riservata (era exam_name, non più usata)
  exam_date:  3,  // D
  duration:   4,  // E
  corso:      5,  // F
  mode:       6,  // G
  status:     7,  // H
  created:    8   // I
};

// ------------------------------------------------------------
// Utilità
// ------------------------------------------------------------

// QIDs colonna 9: formato "q1:2,q2:1,q3:3;seed=12345"
// Il suffisso ":punti" è opzionale — assente nei dati precedenti alla v2.24.
// Il seed è opzionale — assente nei dati precedenti alla v2.23.
function parseQIds(raw) {
  return String(raw || "").split(";")[0].split(",").map(s => s.trim().split(":")[0]).filter(Boolean);
}
// Restituisce [{id, punti}] — punti è null se non codificato (usa il default della domanda).
function parseQIdsPunti(raw) {
  return String(raw || "").split(";")[0].split(",").map(s => {
    const parts = s.trim().split(":");
    const id = parts[0];
    const punti = parts.length > 1 ? Number(parts[1]) : null;
    return { id, punti };
  }).filter(p => p.id);
}
function parseQIdsSeed(raw) {
  const seedPart = String(raw || "").split(";").find(p => p.startsWith("seed="));
  return seedPart ? parseInt(seedPart.slice(5), 10) : null;
}

function formatTs(isoStr) {
  if (!isoStr) return "";
  try {
    const d = new Date(isoStr);
    const pad = n => String(n).padStart(2, "0");
    return pad(d.getDate()) + "/" + pad(d.getMonth()+1) + "/" + d.getFullYear()
      + " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  } catch(e) { return isoStr; }
}

// Inverso di formatTs: "DD/MM/YYYY HH:mm:ss" → Date (o null)
function parseTs(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) { const d = new Date(s); return isNaN(d) ? null : d; }
  return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6]);
}

function corsResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// Genera UUID corto tipo "q_a3f9b2"
function generateQuestionId() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "q_";
  for (let i = 0; i < 6; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// Converte lettera corretta (A, B, C, … Z) in indice 0-based
function letterToIndex(letter) {
  const l = String(letter).toUpperCase().trim();
  const idx = l.charCodeAt(0) - 65; // A=0, B=1, …
  return idx >= 0 && idx < 26 ? idx : 0;
}

// ------------------------------------------------------------
// Repository domande
// ------------------------------------------------------------
function getQuestionsSheet() {
  const ss = SpreadsheetApp.openById(getSheetQuestionsId());
  let sheet = ss.getSheetByName("questions");
  if (!sheet) {
    sheet = ss.insertSheet("questions");
    const headers = ["ID", "Corso", "Categoria", "Sottocategoria", "Tags",
                     "Stato", "Tipo", "Testo", "Opzioni", "Corretta", "Punti", "Placeholder", "Data"];
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function getTracceSheet() {
  const ss = SpreadsheetApp.openById(getSheetQuestionsId());
  let sheet = ss.getSheetByName("tracce");
  if (!sheet) {
    sheet = ss.insertSheet("tracce");
    const headers = ["TracciaID", "Nome", "Items"];
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function getEsamiSheet() {
  const ss = SpreadsheetApp.openById(getSheetQuestionsId());
  let sheet = ss.getSheetByName("esami");
  if (!sheet) {
    sheet = ss.insertSheet("esami");
    const headers = ["EsameID", "TracciaID", "Nome", "Data", "Durata (min)", "Corso", "Modalità", "Stato", "Password", "Shuffle"];
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// Legge tutte le domande come mappa id → oggetto
function loadAllQuestions() {
  const sheet = getQuestionsSheet();
  const values = sheet.getDataRange().getValues();
  const map = {};
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const id = String(row[Q_ID]).trim();
    if (!id) continue;
    map[id] = {
      id,
      corso:        String(row[Q_CORSO]),
      categoria:    String(row[Q_CATEGORIA]),
      sottocateg:   String(row[Q_SOTTOCATEG]),
      tipo:         String(row[Q_TIPO]).trim() || "mc",
      testo:        String(row[Q_TESTO]),
      options:      (() => { try { const v = String(row[Q_OPTIONS] || ""); return v.trim() ? JSON.parse(v) : []; } catch(e) { return []; } })(),
      corretta:     String(row[Q_CORRETTA]).trim(),
      punti:        Number(row[Q_PUNTI]) || 1,
      placeholder:  String(row[Q_PLACEHOLDER]).trim(),
      tags:         String(row[Q_TAGS] || "").trim(),
      data:         String(row[Q_DATA] || "").trim(),
      stato:        String(row[Q_STATO] || "verificato").trim() || "verificato"
    };
  }
  return map;
}

// Legge la traccia (template domande) — solo id, nome, items
function readTraccia(tracciaId) {
  const sheet = getTracceSheet();
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (String(row[T_ID]).trim() !== tracciaId) continue;
    return {
      id:    String(row[T_ID]).trim(),
      nome:  String(row[T_NOME]),
      items: (function() {
        try { return JSON.parse(String(row[T_ITEMS] || "") || "[]"); } catch(e) { return []; }
      })()
    };
  }
  return null;
}

// Legge l'esame (sessione contestualizzata) dal foglio esami
function readEsame(examId) {
  const sheet  = getEsamiSheet();
  const tz     = Session.getScriptTimeZone();
  const values = sheet.getDataRange().getValues();
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    if (String(row[E_ID]).trim() !== examId) continue;
    const rawDate = row[E_DATA];
    const dataStr = rawDate instanceof Date && !isNaN(rawDate)
      ? Utilities.formatDate(rawDate, tz, "yyyy-MM-dd") : String(rawDate);
    return {
      exam_id:    String(row[E_ID]).trim(),
      traccia_id: String(row[E_TRACCIA]).trim(),
      data:       dataStr,
      durata:     String(row[E_DURATA]),
      corso:      String(row[E_CORSO]),
      modalita:   String(row[E_MODALITA]) || "exam",
      stato:      String(row[E_STATO])    || "closed",
      password:   String(row[E_PASSWORD] || "").trim(),
      shuffle:    String(row[E_SHUFFLE] || "").trim().toLowerCase() !== "no",
      rowIndex:   i + 1
    };
  }
  return null;
}

// Costruisce l'oggetto domanda pronto per il client.
// withCorrect=false (default): omette le risposte corrette — usato per getTrack (studenti).
// withCorrect=true: include le risposte corrette — usato solo internamente per scoring o admin.
function buildQuestionObj(q, pos, withCorrect) {
  const obj = {
    id:   q.id,
    pos:  pos,
    pts:  q.punti,
    type: q.tipo,
    text: q.testo
  };
  if (q.tipo === "mc") {
    obj.options = q.options;
    if (withCorrect) obj.correct = letterToIndex(q.corretta);
  } else if (q.tipo === "fitb") {
    if (q.placeholder) obj.placeholder = q.placeholder;
    if (withCorrect) obj.correct = q.corretta;
  } else if (q.tipo === "match") {
    obj.left = q.options;
    try { obj.right = JSON.parse(q.corretta); } catch(e) { obj.right = []; }
    // obj.right (item della colonna destra) va sempre inviato: lo studente ne ha bisogno
    // per visualizzare la domanda. La risposta corretta sono gli INDICI in obj.correct,
    // che viene inviato solo con withCorrect=true.
    if (withCorrect) obj.correct = obj.right.slice();
  } else if (q.tipo === "free") {
    if (q.placeholder) obj.placeholder = q.placeholder;
    obj.correct = null; // free è sempre null, non rivela nulla
  } else if (q.tipo === "multi-fitb") {
    try {
      const d = JSON.parse(q.data || "{}");
      // Invia boxes senza il campo "correct" interno se non autorizzato
      obj.boxes = (d.boxes || []).map(b => withCorrect ? b : { label: b.label, cols: b.cols, pts: b.pts });
      obj.cols  = d.cols || 1;
    } catch(e) { obj.boxes = []; obj.cols = 1; }
    if (withCorrect) obj.correct = obj.boxes.map(b => String(b.correct || "").trim());
  } else if (q.tipo === "cloze") {
    try {
      const d = JSON.parse(q.data || "{}");
      // Invia dropdowns senza il campo "correct" interno se non autorizzato
      obj.dropdowns = (d.dropdowns || []).map(dd =>
        withCorrect ? dd : { options: dd.options }
      );
    } catch(e) { obj.dropdowns = []; }
    if (withCorrect) obj.correct = obj.dropdowns.map(dd => dd.correct ?? 0);
  }
  return obj;
}

// Calcola il punteggio server-side per una singola risposta
// Normalizza una risposta testuale — IDENTICO a normalizeAnswer() in quiz_v2.html
// (rimuove TUTTI gli spazi e abbassa a minuscolo) per coerenza di scoring.
function normalizeText(s) {
  if (s === null || s === undefined) return "";
  return String(s).replace(/\s/g, "").toLowerCase();
}

// Calcola il punteggio server-side per una singola risposta.
// q è l'oggetto domanda grezzo dal repository (allQ[id]); ans è la risposta grezza dello studente.
function scoreAnswer(q, ans) {
  if (!q) return 0; // domanda inesistente → 0 (protezione contro ID iniettati)
  if (q.tipo === "mc") {
    const correct = letterToIndex(q.corretta);
    return (parseInt(ans, 10) === correct) ? q.punti : 0;
  }
  if (q.tipo === "fitb") {
    return (normalizeText(ans) === normalizeText(q.corretta)) ? q.punti : 0;
  }
  if (q.tipo === "match") {
    // Il client salva un array di INDICI: given[i] = indice (in q.right) scelto per il termine sinistro i.
    // La risposta è corretta per la posizione i se right[given[i]] === right[i] (ovvero given[i] === i,
    // confrontando per valore per gestire eventuali stringhe duplicate).
    try {
      const right = JSON.parse(q.corretta);
      const given = typeof ans === "string" ? JSON.parse(ans) : ans;
      if (!Array.isArray(given)) return 0;
      let ok = 0;
      right.forEach((r, i) => {
        const chosenIdx = parseInt(given[i], 10);
        if (!isNaN(chosenIdx) && String(right[chosenIdx] ?? "").trim() === String(r).trim()) ok++;
      });
      return right.length ? Math.round((ok / right.length) * q.punti) : 0;
    } catch(e) { return 0; }
  }
  if (q.tipo === "multi-fitb") {
    try {
      const d = JSON.parse(q.data || "{}");
      const boxes = d.boxes || [];
      const given = typeof ans === "string" ? JSON.parse(ans) : (ans || []);
      let pts = 0;
      boxes.forEach((b, i) => {
        if (normalizeText(given[i]) === normalizeText(b.correct)) pts += (b.pts || 0);
      });
      return pts;
    } catch(e) { return 0; }
  }
  if (q.tipo === "cloze") {
    try {
      const d = JSON.parse(q.data || "{}");
      const dropdowns = d.dropdowns || [];
      const given = typeof ans === "string" ? JSON.parse(ans) : (ans || []);
      let ok = 0;
      dropdowns.forEach((dd, i) => { if (parseInt(given[i], 10) === (dd.correct ?? 0)) ok++; });
      return dropdowns.length ? Math.round((ok / dropdowns.length) * q.punti) : 0;
    } catch(e) { return 0; }
  }
  if (q.tipo === "free") return 0; // valutazione manuale
  return 0;
}

// Fisher-Yates shuffle su array (in-place)
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Risolve le domande di una traccia.
// withCorrect=false (default, per studenti): omette risposte corrette.
// withCorrect=true (solo interno, per scoring server-side): include risposte corrette.
// Restituisce { questions, effectivePuntiMap } dove effectivePuntiMap mappa qId → punti effettivi.
// Per slot fixed: item.punti ?? q.punti.
// Per slot random con item.punti: usa come filtro E come punteggio.
// Per slot random senza item.punti: inferisce dal pool (tutti uguali → quel valore; misti → massimo).
function _resolveItems(items, withCorrect) {
  const allQ            = loadAllQuestions();
  const questions       = [];
  const effectivePuntiMap = {};
  const usedIds         = new Set();
  (items || []).forEach(item => {
    if (item.type === "fixed") {
      usedIds.add(item.id);
      const q = allQ[item.id];
      if (!q) {
        questions.push({ id: item.id, error: "Domanda non trovata: " + item.id, pts: 0, type: "mc", text: "", pos: questions.length + 1 });
        return;
      }
      const ep = (item.punti !== undefined && item.punti !== null) ? item.punti : q.punti;
      effectivePuntiMap[item.id] = ep;
      const qObj = buildQuestionObj(q, questions.length + 1, withCorrect);
      qObj.pts = ep;
      questions.push(qObj);
    } else if (item.type === "random") {
      const candidates = Object.values(allQ).filter(q => {
        if (usedIds.has(q.id)) return false;
        if ((q.stato || "verificato") === "bozza") return false;
        if (item.categoria && q.categoria !== item.categoria) return false;
        if (item.sottocateg && q.sottocateg !== item.sottocateg) return false;
        if (item.tag) {
          const qTags = String(q.tags || "").split(",").map(t => t.trim());
          if (!qTags.includes(item.tag)) return false;
        }
        if (item.punti !== undefined && item.punti !== null && q.punti !== item.punti) return false;
        return true;
      });
      const picked = shuffleArray(candidates)[0];
      if (picked) {
        usedIds.add(picked.id);
        let ep;
        if (item.punti !== undefined && item.punti !== null) {
          ep = item.punti;
        } else {
          const poolPunti = candidates.map(c => Number(c.punti) || 1);
          const allSame   = poolPunti.length > 0 && poolPunti.every(p => p === poolPunti[0]);
          ep = allSame ? poolPunti[0] : Math.max(...poolPunti);
        }
        effectivePuntiMap[picked.id] = ep;
        const qObj = buildQuestionObj(picked, questions.length + 1, withCorrect);
        qObj.pts = ep;
        questions.push(qObj);
      }
    }
  });
  return { questions, effectivePuntiMap };
}

// Risolve un esame (legge esame → trova traccia → risolve domande)
function resolveEsame(examId) {
  const esame = readEsame(examId);
  if (!esame) return null;
  const traccia = readTraccia(esame.traccia_id);
  if (!traccia) return null;
  const { questions, effectivePuntiMap } = _resolveItems(traccia.items);
  return {
    track: {
      exam_id:         esame.exam_id,
      exam_date:       esame.data,
      duration:        esame.durata,
      mode:            esame.modalita,
      status:          esame.stato,
      corso:           esame.corso,
      track_name:      traccia.nome,      // nome traccia (per esercitazioni)
      traccia_id:      esame.traccia_id,  // usato internamente da ensureMetaTrack
      _password:       esame.password,    // rimosso dal doPost prima di inviare al client
      shuffle_options: esame.shuffle      // true (default) | false
    },
    questions,
    effectivePuntiMap,
    n_questions: questions.length,
    total_pts:   questions.reduce((s, q) => s + (q.pts || 0), 0)
  };
}

// Alias per compatibilità interna — usa resolveEsame
function resolveTraccia(examId) { return resolveEsame(examId); }

// ------------------------------------------------------------
// Foglio risultati (identico a v1, ma usa SHEET_RESULTS_ID)
// ------------------------------------------------------------
function getConfigSheet() {
  const ss = SpreadsheetApp.openById(getSheetResultsId());
  let cfg = ss.getSheetByName("_config");
  if (!cfg) {
    cfg = ss.insertSheet("_config");
    cfg.appendRow(["Chiave", "Valore"]);
    cfg.appendRow(["admin_password", "cambiami"]);
    cfg.getRange(1, 1, 1, 2).setFontWeight("bold");
    cfg.setFrozenRows(1);
  }
  return cfg;
}

function getAdminPassword() {
  const values = getConfigSheet().getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) === "admin_password") return String(values[i][1]);
  }
  return "";
}

// Legge extra minuti globali per un esame (scope "all")
function getExtraMinutesAll(examId) {
  const key = "extra_time:" + examId + ":all";
  const vals = getConfigSheet().getDataRange().getValues();
  for (let i = 1; i < vals.length; i++) {
    if (String(vals[i][0]) === key) return Number(vals[i][1]) || 0;
  }
  return 0;
}

// Legge extra minuti individuali per uno studente (NON include "all")
function getExtraMinutesIndividual(examId, matricola) {
  const key = "extra_time:" + examId + ":" + String(matricola);
  const vals = getConfigSheet().getDataRange().getValues();
  for (let i = 1; i < vals.length; i++) {
    if (String(vals[i][0]) === key) return Number(vals[i][1]) || 0;
  }
  return 0;
}

// Aggiunge (o sottrae) deltaMinutes per uno scope ("all" o matricola). Restituisce nuovo totale.
function addExtraMinutes(examId, scope, deltaMinutes) {
  const key = "extra_time:" + examId + ":" + scope;
  const cfg  = getConfigSheet();
  const vals = cfg.getDataRange().getValues();
  for (let i = 1; i < vals.length; i++) {
    if (String(vals[i][0]) === key) {
      const newVal = (Number(vals[i][1]) || 0) + deltaMinutes;
      cfg.getRange(i + 1, 2).setValue(newVal);
      return newVal;
    }
  }
  cfg.appendRow([key, deltaMinutes]);
  return deltaMinutes;
}

// Ripresa d'emergenza (es. blackout): interruttore globale per esame.
// Quando ON, uno studente con una riga NON consegnata può recuperare la sessione
// dal server da qualsiasi dispositivo. Va acceso/spento manualmente dal docente.
function getResumeAll(examId) {
  const key  = "resume_allowed:" + examId + ":all";
  const vals = getConfigSheet().getDataRange().getValues();
  for (let i = 1; i < vals.length; i++) {
    if (String(vals[i][0]) === key) return String(vals[i][1]).trim() === "1";
  }
  return false;
}

function setResumeAll(examId, enabled) {
  const key  = "resume_allowed:" + examId + ":all";
  const cfg  = getConfigSheet();
  const vals = cfg.getDataRange().getValues();
  for (let i = 1; i < vals.length; i++) {
    if (String(vals[i][0]) === key) {
      cfg.getRange(i + 1, 2).setValue(enabled ? "1" : "");
      return enabled;
    }
  }
  cfg.appendRow([key, enabled ? "1" : ""]);
  return enabled;
}

function getMetaSheet() {
  const ss = SpreadsheetApp.openById(getSheetResultsId());
  let meta = ss.getSheetByName("Esami");
  if (!meta) {
    // retrocompatibilità: rinomina _meta se esiste ancora
    const old = ss.getSheetByName("_meta");
    if (old) { old.setName("Esami"); meta = old; }
  }
  if (!meta) {
    meta = ss.insertSheet("Esami");
    meta.appendRow(["TracciaID", "Nome", "Data", "Durata (min)", "Modalità", "Stato", "Creata", "Foglio"]);
    meta.getRange(1, 1, 1, 8).setFontWeight("bold");
    meta.setFrozenRows(1);
  }
  return meta;
}

function readMetaTrack(examId) {
  const meta   = getMetaSheet();
  const tz     = Session.getScriptTimeZone();
  const values = meta.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][META_COLS.exam_id]) !== examId) continue;
    const rawDate = values[i][META_COLS.exam_date];
    const examDate = rawDate instanceof Date && !isNaN(rawDate)
      ? Utilities.formatDate(rawDate, tz, "yyyy-MM-dd") : String(rawDate);
    return {
      exam_id:    examId,
      traccia_id: String(values[i][META_COLS.traccia_id] || ""),
      exam_date:  examDate,
      duration:   String(values[i][META_COLS.duration]),
      corso:      String(values[i][META_COLS.corso] || ""),
      mode:       String(values[i][META_COLS.mode])   || "exam",
      status:     String(values[i][META_COLS.status])  || "closed",
      rowIndex:   i + 1
    };
  }
  return null;
}

function ensureMetaTrack(track) {
  if (readMetaTrack(track.exam_id)) return readMetaTrack(track.exam_id);
  // Double-check con lock per evitare righe duplicate da chiamate concorrenti
  const lock = LockService.getScriptLock();
  try { lock.waitLock(10000); } catch(e) {}
  try {
    const existing = readMetaTrack(track.exam_id);
    if (existing) return existing;
    const meta = getMetaSheet();
    const now  = formatTs(new Date().toISOString());
    meta.appendRow([
      track.exam_id,
      track.traccia_id  || "",
      "",               // col C riservata (era exam_name)
      track.exam_date,
      track.duration,
      track.corso       || "",
      track.mode        || "exam",
      track.status      || "closed",
      now
    ]);
    return readMetaTrack(track.exam_id);
  } finally {
    try { lock.releaseLock(); } catch(e) {}
  }
}

function getResultSheet(examId, nQuestions) {
  const ss = SpreadsheetApp.openById(getSheetResultsId());
  let sheet = ss.getSheetByName(examId);
  if (!sheet) {
    sheet = ss.insertSheet(examId);
    const headers = ["Matricola", "Nominativo", "Email", "Score", "Totale", "Inizio", "Fine", "Durata", "QIDs"];
    const n = nQuestions || 20;
    for (let i = 1; i <= n; i++) {
      headers.push("Ans" + i);
      headers.push("Pt" + i);
    }
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold");
    sheet.setFrozenRows(1);
    sheet.getRange(1, COL_MATRICOLA, sheet.getMaxRows(), 1).setNumberFormat("@");
  }
  return sheet;
}

function findRow(sheet, matricola) {
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][COL_MATRICOLA - 1]) === String(matricola)) return i + 1;
  }
  return -1;
}

// ------------------------------------------------------------
// doGet / doPost
// ------------------------------------------------------------
function doGet(e) {
  return corsResponse({ status: "ok", message: "QuizForge Apps Script v2 attivo", version: VERSION });
}

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);

    // ----------------------------------------------------------------
    // addExtraTime — aggiunge (o sottrae) minuti a tutti o a uno studente
    // ----------------------------------------------------------------
    if (data.action === "addExtraTime") {
      if (data.password !== getAdminPassword()) return corsResponse({ status: "error", message: "Password errata" });
      const minutes = Number(data.minutes) || 0;
      const scope   = String(data.scope || "all");   // "all" o matricola specifica
      const examId  = String(data.exam_id || "");
      if (!examId)  return corsResponse({ status: "error", message: "exam_id mancante" });
      if (minutes === 0) return corsResponse({ status: "ok", total: getExtraMinutesAll(examId), scope });
      const newTotal = addExtraMinutes(examId, scope, minutes);
      return corsResponse({ status: "ok", total: newTotal, scope, exam_id: examId });
    }

    // ----------------------------------------------------------------
    // setResumeAll — accende/spegne la ripresa d'emergenza per tutto l'esame
    // ----------------------------------------------------------------
    if (data.action === "setResumeAll") {
      if (data.password !== getAdminPassword()) return corsResponse({ status: "error", message: "Password errata" });
      const examId = String(data.exam_id || "");
      if (!examId) return corsResponse({ status: "error", message: "exam_id mancante" });
      const enabled = setResumeAll(examId, !!data.enabled);
      return corsResponse({ status: "ok", resume_all: enabled, exam_id: examId });
    }

    // ----------------------------------------------------------------
    // getConfig — legge gli ID dei fogli attivi (admin)
    // ----------------------------------------------------------------
    if (data.action === "getConfig") {
      if (data.password !== getAdminPassword()) {
        return corsResponse({ status: "error", message: "Password errata" });
      }
      const qId  = getSheetQuestionsId();
      const rId  = getSheetResultsId();
      const fId  = getDriveFolderId();
      const scriptEditorUrl = "https://script.google.com/d/" + ScriptApp.getScriptId() + "/edit";
      // Legge solo il nome (metadato) — non apre il foglio intero
      let qName = ""; try { qName = DriveApp.getFileById(qId).getName(); } catch(e) {}
      let rName = ""; try { rName = DriveApp.getFileById(rId).getName(); } catch(e) {}
      return corsResponse({
        status: "ok",
        questions_id:      qId,
        questions_name:    qName,
        results_id:        rId,
        results_name:      rName,
        folder_id:         fId,
        questions_url:     "https://docs.google.com/spreadsheets/d/" + qId + "/edit",
        results_url:       "https://docs.google.com/spreadsheets/d/" + rId + "/edit",
        folder_url:        "https://drive.google.com/drive/folders/" + fId,
        script_editor_url: scriptEditorUrl
      });
    }

    // ----------------------------------------------------------------
    // setConfig — aggiorna gli ID dei fogli in ScriptProperties (admin)
    // ----------------------------------------------------------------
    if (data.action === "setConfig") {
      if (data.password !== getAdminPassword()) {
        return corsResponse({ status: "error", message: "Password errata" });
      }
      const props = PropertiesService.getScriptProperties();
      // Stringa vuota = ripristina il default hardcoded
      if (data.questions_id !== undefined) {
        data.questions_id ? props.setProperty("SHEET_QUESTIONS_ID", data.questions_id)
                          : props.deleteProperty("SHEET_QUESTIONS_ID");
      }
      if (data.results_id !== undefined) {
        data.results_id ? props.setProperty("SHEET_RESULTS_ID", data.results_id)
                        : props.deleteProperty("SHEET_RESULTS_ID");
      }
      if (data.folder_id !== undefined) {
        data.folder_id ? props.setProperty("DRIVE_FOLDER_ID", data.folder_id)
                       : props.deleteProperty("DRIVE_FOLDER_ID");
      }
      if (data.script_editor_url !== undefined) {
        data.script_editor_url ? props.setProperty("SCRIPT_EDITOR_URL", data.script_editor_url)
                               : props.deleteProperty("SCRIPT_EDITOR_URL");
      }
      return corsResponse({ status: "ok" });
    }

    // ----------------------------------------------------------------
    // listDriveFolder — elenco spreadsheet nella cartella Drive configurata
    // ----------------------------------------------------------------
    if (data.action === "listDriveFolder") {
      if (data.password !== getAdminPassword()) {
        return corsResponse({ status: "error", message: "Password errata" });
      }
      const folderId = data.folder_id || getDriveFolderId();
      try {
        const folder = DriveApp.getFolderById(folderId);
        const iter   = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
        const list   = [];
        while (iter.hasNext()) {
          const f = iter.next();
          list.push({
            id:   f.getId(),
            name: f.getName(),
            url:  "https://docs.google.com/spreadsheets/d/" + f.getId() + "/edit"
          });
        }
        list.sort((a, b) => a.name.localeCompare(b.name));
        return corsResponse({ status: "ok", files: list });
      } catch(e) {
        return corsResponse({ status: "error", message: "Cartella non accessibile: " + e.message });
      }
    }

    // ----------------------------------------------------------------
    // createSheet — crea un nuovo foglio nella cartella Drive e lo inizializza
    // sheet_type: "questions" | "results"
    // ----------------------------------------------------------------
    if (data.action === "createSheet") {
      if (data.password !== getAdminPassword()) {
        return corsResponse({ status: "error", message: "Password errata" });
      }
      const folderId  = data.folder_id || getDriveFolderId();
      const sheetName = String(data.name || "Nuovo foglio").trim();
      const type      = data.sheet_type; // "questions" | "results"
      try {
        const folder = DriveApp.getFolderById(folderId);
        const ss     = SpreadsheetApp.create(sheetName);
        const file   = DriveApp.getFileById(ss.getId());
        // Sposta nella cartella e rimuovi da My Drive
        folder.addFile(file);
        DriveApp.getRootFolder().removeFile(file);

        if (type === "questions") {
          const qs = ss.getSheets()[0];
          qs.setName("questions");
          qs.appendRow(["ID","Corso","Categoria","Sottocategoria","Tags","Stato","Tipo","Testo","Opzioni","Corretta","Punti","Placeholder","Data"]);
          const tr = ss.insertSheet("tracce");
          tr.appendRow(["TracciaID","Nome","Items"]);
          const es = ss.insertSheet("esami");
          es.appendRow(["EsameID","TracciaID","Nome","Data","Durata (min)","Corso","Modalità","Stato","Password"]);
        } else if (type === "results") {
          const cfg = ss.getSheets()[0];
          cfg.setName("_config");
          cfg.appendRow(["Chiave", "Valore"]);               // riga header (getAdminPassword parte da i=1)
          cfg.appendRow(["admin_password", getAdminPassword()]);
          cfg.getRange(1, 1, 1, 2).setFontWeight("bold");
          cfg.setFrozenRows(1);
          const esTab = ss.insertSheet("Esami");
          esTab.appendRow(["EsameID","TracciaID","Nome","Data","Durata (min)","Corso","Modalità","Stato","Password"]);
        }

        const id = ss.getId();
        return corsResponse({
          status: "ok",
          id:   id,
          name: sheetName,
          url:  "https://docs.google.com/spreadsheets/d/" + id + "/edit"
        });
      } catch(e) {
        return corsResponse({ status: "error", message: "Errore creazione foglio: " + e.message });
      }
    }

    // ----------------------------------------------------------------
    // getPublicExams — elenco pubblico degli esami aperti (no password)
    // ----------------------------------------------------------------
    if (data.action === "getPublicExams") {
      const sheet  = getEsamiSheet();
      const tz     = Session.getScriptTimeZone();
      const values = sheet.getDataRange().getValues();
      const exams  = [];
      for (let i = 0; i < values.length; i++) {
        const row   = values[i];
        const id    = String(row[E_ID]).trim();
        const stato = String(row[E_STATO]).trim();
        if (!id || id === "EsameID") continue;
        if (stato !== "open") continue;
        const rawDate = row[E_DATA];
        const dataStr = rawDate instanceof Date && !isNaN(rawDate)
          ? Utilities.formatDate(rawDate, tz, "yyyy-MM-dd") : String(rawDate);
        const modalita   = String(row[E_MODALITA]).trim() || "exam";
        const traccia_id = String(row[E_TRACCIA]).trim();
        let track_name   = "";
        if (modalita === "practice" && traccia_id) {
          const tr = readTraccia(traccia_id);
          if (tr) track_name = tr.nome || "";
        }
        exams.push({
          exam_id:    id,
          corso:      String(row[E_CORSO]).trim(),
          data:       dataStr,
          durata:     Number(row[E_DURATA]) || 0,
          modalita:   modalita,
          traccia_id: traccia_id,
          track_name: track_name
        });
      }
      exams.sort((a, b) => (b.data || "").localeCompare(a.data || ""));
      return corsResponse({ status: "ok", exams });
    }

    // ----------------------------------------------------------------
    // getTrack — carica esame + domande risolte
    // ----------------------------------------------------------------
    if (data.action === "getTrack") {
      const examId = data.examId;
      if (!examId) return corsResponse({ status: "error", message: "examId mancante" });
      const resolved = resolveEsame(examId);
      if (!resolved) return corsResponse({ status: "error", message: "Esame non trovato: " + examId });
      ensureMetaTrack(resolved.track);
      const pwdRequired = !!(resolved.track._password);
      delete resolved.track._password;
      resolved.track.password_required = pwdRequired;
      // Aggiunge extra tempo globale alla durata (per refreshDuration lato client)
      const extraAll = getExtraMinutesAll(examId);
      if (extraAll !== 0) {
        const base = parseInt(resolved.track.duration, 10) || 0;
        resolved.track.duration = String(base + extraAll);
      }
      // SICUREZZA: getTrack restituisce SOLO metadati e conteggi per la cover.
      // Il contenuto delle domande NON viene mai esposto qui — verrebbe altrimenti
      // raccolto in anticipo (anche a esame chiuso) da chiunque conosca l'URL.
      // Le domande effettive sono assegnate server-side da init/resetPractice.
      return corsResponse({
        status:      "ok",
        track:       resolved.track,
        n_questions: resolved.n_questions,
        total_pts:   resolved.total_pts
      });
    }

    // ----------------------------------------------------------------
    // verifyTrackPassword — verifica password d'accesso esame
    // ----------------------------------------------------------------
    if (data.action === "verifyTrackPassword") {
      const examId = data.examId;
      if (!examId) return corsResponse({ status: "error", message: "examId mancante" });
      const esame = readEsame(examId);
      if (!esame) return corsResponse({ status: "error", message: "Esame non trovato" });
      if (!esame.password || esame.modalita === "practice") return corsResponse({ status: "ok" });
      if (String(data.password || "").trim() === esame.password) return corsResponse({ status: "ok" });
      return corsResponse({ status: "error", message: "Password errata" });
    }

    // ----------------------------------------------------------------
    // getQuestions — restituisce tutte le domande per l'admin
    // ----------------------------------------------------------------
    if (data.action === "getQuestions") {
      if (data.password !== getAdminPassword()) {
        return corsResponse({ status: "error", message: "Password errata" });
      }
      const allQ = loadAllQuestions();
      return corsResponse({ status: "ok", questions: Object.values(allQ) });
    }

    // ----------------------------------------------------------------
    // createTrack — crea nuova traccia (solo template domande)
    // ----------------------------------------------------------------
    if (data.action === "createTrack") {
      if (data.password !== getAdminPassword()) return corsResponse({ status: "error", message: "Password errata" });
      const sheet = getTracceSheet();
      const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
      let suffix = "";
      for (let i = 0; i < 6; i++) suffix += chars[Math.floor(Math.random() * chars.length)];
      const trackId = "t-" + suffix;
      sheet.appendRow([trackId, data.nome || "Nuova traccia", JSON.stringify(data.items || [])]);
      return corsResponse({ status: "ok", track_id: trackId });
    }

    // ----------------------------------------------------------------
    // getAllTracks — elenco tracce (template domande) per admin
    // ----------------------------------------------------------------
    if (data.action === "getAllTracks") {
      if (data.password !== getAdminPassword()) return corsResponse({ status: "error", message: "Password errata" });
      const sheet  = getTracceSheet();
      const values = sheet.getDataRange().getValues();
      const tracks = [];
      for (let i = 1; i < values.length; i++) {
        const row = values[i];
        const id  = String(row[T_ID]).trim();
        if (!id || id === "TracciaID") continue;
        let items = [];
        try { items = JSON.parse(String(row[T_ITEMS] || "") || "[]"); } catch(e) {}
        tracks.push({ track_id: id, nome: String(row[T_NOME]), items });
      }
      return corsResponse({ status: "ok", tracks, version: VERSION });
    }

    // ----------------------------------------------------------------
    // setTrack — aggiorna nome e/o items di una traccia
    // ----------------------------------------------------------------
    if (data.action === "setTrack") {
      if (data.password !== getAdminPassword()) return corsResponse({ status: "error", message: "Password errata" });
      const sheet  = getTracceSheet();
      const values = sheet.getDataRange().getValues();
      for (let i = 1; i < values.length; i++) {
        if (String(values[i][T_ID]).trim() !== data.track_id) continue;
        const row = i + 1;
        if (data.nome  !== undefined) sheet.getRange(row, T_NOME  + 1).setValue(data.nome);
        if (data.items !== undefined) sheet.getRange(row, T_ITEMS + 1).setValue(JSON.stringify(data.items));
        return corsResponse({ status: "ok" });
      }
      return corsResponse({ status: "error", message: "Traccia non trovata: " + data.track_id });
    }

    // ----------------------------------------------------------------
    // createEsame — crea nuova sessione d'esame
    // ----------------------------------------------------------------
    if (data.action === "createEsame") {
      if (data.password !== getAdminPassword()) return corsResponse({ status: "error", message: "Password errata" });
      const sheet = getEsamiSheet();
      const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
      let suffix = "";
      for (let i = 0; i < 6; i++) suffix += chars[Math.floor(Math.random() * chars.length)];
      const examDate = data.exam_date || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
      const examId   = examDate + "-" + suffix;
      sheet.appendRow([
        examId,
        data.traccia_id     || "",
        "",               // col C riservata (era exam_name)
        examDate,
        data.duration       || 90,
        data.corso          || "",
        data.mode           || "exam",
        "closed",
        data.track_password || "",
        data.shuffle === false || data.shuffle === "no" ? "no" : ""
      ]);
      return corsResponse({ status: "ok", exam_id: examId });
    }

    // ----------------------------------------------------------------
    // getAllEsami — elenco sessioni d'esame per admin
    // ----------------------------------------------------------------
    if (data.action === "getAllEsami") {
      if (data.password !== getAdminPassword()) return corsResponse({ status: "error", message: "Password errata" });
      const sheet  = getEsamiSheet();
      const tz     = Session.getScriptTimeZone();
      const values = sheet.getDataRange().getValues();
      const esami  = [];
      for (let i = 0; i < values.length; i++) {
        const row = values[i];
        const id  = String(row[E_ID]).trim();
        if (!id || id === "EsameID") continue;
        const rawDate = row[E_DATA];
        const dataStr = rawDate instanceof Date && !isNaN(rawDate)
          ? Utilities.formatDate(rawDate, tz, "yyyy-MM-dd") : String(rawDate);
        esami.push({
          exam_id:    id,
          traccia_id: String(row[E_TRACCIA]).trim(),
          data:       dataStr,
          durata:     String(row[E_DURATA]),
          corso:      String(row[E_CORSO]),
          modalita:   String(row[E_MODALITA]) || "exam",
          stato:      String(row[E_STATO])    || "closed",
          password:   String(row[E_PASSWORD] || "").trim(),
          shuffle:    String(row[E_SHUFFLE] || "").trim().toLowerCase() !== "no"
        });
      }
      return corsResponse({ status: "ok", esami, version: VERSION });
    }

    // ----------------------------------------------------------------
    // setEsame — aggiorna attributi di una sessione d'esame
    // ----------------------------------------------------------------
    if (data.action === "setEsame") {
      if (data.password !== getAdminPassword()) return corsResponse({ status: "error", message: "Password errata" });
      const sheet  = getEsamiSheet();
      const values = sheet.getDataRange().getValues();
      for (let i = 0; i < values.length; i++) {
        if (String(values[i][E_ID]).trim() !== data.exam_id) continue;
        const row = i + 1;
        if (data.traccia_id     !== undefined) sheet.getRange(row, E_TRACCIA  + 1).setValue(data.traccia_id);
        if (data.exam_date      !== undefined) sheet.getRange(row, E_DATA     + 1).setValue(data.exam_date);
        if (data.duration       !== undefined) sheet.getRange(row, E_DURATA   + 1).setValue(data.duration);
        if (data.corso          !== undefined) sheet.getRange(row, E_CORSO    + 1).setValue(data.corso);
        if (data.mode           !== undefined) sheet.getRange(row, E_MODALITA + 1).setValue(data.mode);
        if (data.status         !== undefined) sheet.getRange(row, E_STATO    + 1).setValue(data.status);
        if (data.track_password !== undefined) sheet.getRange(row, E_PASSWORD + 1).setValue(data.track_password);
        if (data.shuffle        !== undefined) sheet.getRange(row, E_SHUFFLE  + 1).setValue(data.shuffle === false || data.shuffle === "no" ? "no" : "");
        // Sincronizza foglio Esami nel foglio risultati
        const meta  = getMetaSheet();
        const mvals = meta.getDataRange().getValues();
        for (let j = 1; j < mvals.length; j++) {
          if (String(mvals[j][META_COLS.exam_id]) !== data.exam_id) continue;
          const mrow = j + 1;
          if (data.exam_date !== undefined) meta.getRange(mrow, META_COLS.exam_date + 1).setValue(data.exam_date);
          if (data.duration  !== undefined) meta.getRange(mrow, META_COLS.duration  + 1).setValue(data.duration);
          if (data.corso     !== undefined) meta.getRange(mrow, META_COLS.corso     + 1).setValue(data.corso);
          if (data.mode      !== undefined) meta.getRange(mrow, META_COLS.mode      + 1).setValue(data.mode);
          if (data.status    !== undefined) meta.getRange(mrow, META_COLS.status    + 1).setValue(data.status);
          break;
        }
        return corsResponse({ status: "ok" });
      }
      return corsResponse({ status: "error", message: "Esame non trovato: " + data.exam_id });
    }

    // ----------------------------------------------------------------
    // getMonitor — studenti di un esame (admin)
    // ----------------------------------------------------------------
    if (data.action === "getMonitor") {
      if (data.password !== getAdminPassword()) {
        return corsResponse({ status: "error", message: "Password errata" });
      }
      const examId  = data.examId;
      const esame   = readEsame(examId);
      const traccia = esame ? readTraccia(esame.traccia_id) : null;
      const nQ      = traccia ? traccia.items.length : 20;
      const resumeAll = getResumeAll(examId);
      const ss      = SpreadsheetApp.openById(getSheetResultsId());
      const sheet   = ss.getSheetByName(examId);
      if (!sheet) return corsResponse({ status: "ok", rows: [], track: readMetaTrack(examId), resume_all: resumeAll });

      const values = sheet.getDataRange().getValues();
      const rows   = [];
      for (let i = 1; i < values.length; i++) {
        const row = values[i];
        const qids = parseQIds(row[COL_QIDS - 1]);
        const rowNQ = qids.length || nQ;
        let answered = 0;
        for (let q = 0; q < rowNQ; q++) {
          if (row[COL_ANS_FIRST - 1 + q * 2] !== "") answered++;
        }
        rows.push({
          matricola:  row[COL_MATRICOLA - 1],
          nominativo: row[COL_NOMINATIVO - 1],
          email:      row[COL_EMAIL - 1],
          score:      row[COL_SCORE - 1],
          tsStart:    formatTs(row[COL_TS_START - 1]),
          tsEnd:      formatTs(row[COL_TS_END - 1]),
          elapsed:    String(row[COL_ELAPSED - 1] || ""),
          answered,
          finalized:  row[COL_TS_END - 1] !== ""
        });
      }
      return corsResponse({ status: "ok", rows, track: readMetaTrack(examId), resume_all: resumeAll });
    }

    // ----------------------------------------------------------------
    // getResults — punteggi per domanda (admin)
    // ----------------------------------------------------------------
    if (data.action === "getResults") {
      if (data.password !== getAdminPassword()) {
        return corsResponse({ status: "error", message: "Password errata" });
      }
      const examId  = data.examId;
      const esame2  = readEsame(examId);
      const traccia2 = esame2 ? readTraccia(esame2.traccia_id) : null;
      const nQ      = traccia2 ? traccia2.items.length : 20;
      const ss      = SpreadsheetApp.openById(getSheetResultsId());
      const sheet   = ss.getSheetByName(examId);
      if (!sheet) return corsResponse({ status: "ok", rows: [], track: readMetaTrack(examId) });

      const values = sheet.getDataRange().getValues();
      const rows   = [];
      for (let i = 1; i < values.length; i++) {
        const row = values[i];
        if (row[COL_TS_END - 1] === "") continue;
        const qidsPuntiRow = parseQIdsPunti(row[COL_QIDS - 1]);
        const qids   = qidsPuntiRow.map(x => x.id);
        const qpunti = qidsPuntiRow.map(x => x.punti);
        const rowNQ  = qids.length || nQ;
        const pts = [], answers = [];
        for (let q = 0; q < rowNQ; q++) {
          answers.push(String(row[COL_ANS_FIRST - 1 + q * 2] ?? ""));
          pts.push(Number(row[COL_ANS_FIRST - 1 + q * 2 + 1]) || 0);
        }
        rows.push({
          matricola:  row[COL_MATRICOLA - 1],
          nominativo: row[COL_NOMINATIVO - 1],
          score:      row[COL_SCORE - 1],
          tsStart:    formatTs(row[COL_TS_START - 1]),
          tsEnd:      formatTs(row[COL_TS_END - 1]),
          elapsed:    String(row[COL_ELAPSED - 1] || ""),
          pts,
          answers,
          qids,
          qpunti
        });
      }
      return corsResponse({ status: "ok", rows, track: readMetaTrack(examId) });
    }

    // ----------------------------------------------------------------
    // getQuestionStats — statistiche per domanda (admin)
    // Legge tutti i tab del foglio Risultati e aggrega correct/wrong/skipped per domanda.
    // ----------------------------------------------------------------
    if (data.action === "getQuestionStats") {
      if (data.password !== getAdminPassword()) {
        return corsResponse({ status: "error", message: "Password errata" });
      }
      const ss     = SpreadsheetApp.openById(getSheetResultsId());
      const sheets = ss.getSheets();
      const SKIP   = new Set(["_config", "Esami"]);
      const stats  = {}; // qId → { asked, correct, wrong, skipped }
      for (const sheet of sheets) {
        if (SKIP.has(sheet.getName())) continue;
        const values = sheet.getDataRange().getValues();
        for (let i = 1; i < values.length; i++) {
          const row = values[i];
          if (row[COL_TS_END - 1] === "" || row[COL_TS_END - 1] === null) continue;
          const qpRow = parseQIdsPunti(row[COL_QIDS - 1]);
          qpRow.forEach(({ id }, qi) => {
            if (!id) return;
            if (!stats[id]) stats[id] = { asked: 0, correct: 0, wrong: 0, skipped: 0 };
            const ans = String(row[COL_ANS_FIRST - 1 + qi * 2] ?? "");
            const pts = Number(row[COL_ANS_FIRST - 1 + qi * 2 + 1]) || 0;
            stats[id].asked++;
            if (pts > 0)      stats[id].correct++;
            else if (ans !== "") stats[id].wrong++;
            else                stats[id].skipped++;
          });
        }
      }
      return corsResponse({ status: "ok", stats });
    }

    // ----------------------------------------------------------------
    // addQuestion — aggiunge domanda al repository con UUID generato
    // ----------------------------------------------------------------
    if (data.action === "addQuestion") {
      if (data.password !== getAdminPassword()) {
        return corsResponse({ status: "error", message: "Password errata" });
      }
      const sheet  = getQuestionsSheet();
      const allQ   = loadAllQuestions();

      // Genera UUID unico
      let newId;
      do { newId = generateQuestionId(); } while (allQ[newId]);

      sheet.appendRow([
        newId,                   // A  ID
        data.corso       || "",  // B  Corso
        data.categoria   || "",  // C  Categoria
        data.sottocateg  || "",  // D  Sottocategoria
        data.tags        || "",       // E  Tags
        data.stato       || "bozza", // F  Stato
        data.tipo        || "mc",    // G  Tipo
        data.testo       || "",  // H  Testo
        JSON.stringify(data.options || []), // I  Opzioni (JSON array)
        data.corretta    || "A",            // J  Corretta
        data.punti       || 1,              // K  Punti
        data.placeholder || "",            // L  Placeholder
        data.data        || ""             // M  Data JSON
      ]);
      return corsResponse({ status: "ok", id: newId });
    }

    // ----------------------------------------------------------------
    // setQuestionStato — aggiorna solo lo stato bozza/verificato
    // ----------------------------------------------------------------
    if (data.action === "setQuestionStato") {
      if (data.password !== getAdminPassword()) {
        return corsResponse({ status: "error", message: "Password errata" });
      }
      const qId    = data.id;
      const stato  = data.stato === "bozza" ? "bozza" : "verificato";
      const sheet  = getQuestionsSheet();
      const values = sheet.getDataRange().getValues();
      for (let i = 1; i < values.length; i++) {
        if (String(values[i][Q_ID]).trim() === qId) {
          sheet.getRange(i + 1, Q_STATO + 1).setValue(stato);
          return corsResponse({ status: "ok", id: qId, stato });
        }
      }
      return corsResponse({ status: "error", message: "Domanda non trovata: " + qId });
    }

    // ----------------------------------------------------------------
    // abandon — cancella la riga dello studente dal foglio risultati
    // ----------------------------------------------------------------
    if (data.action === "abandon") {
      const examId = data.examId;
      if (!examId || !data.matricola) return corsResponse({ status: "error", message: "Parametri mancanti" });
      const ss    = SpreadsheetApp.openById(getSheetResultsId());
      const sheet = ss.getSheetByName(examId);
      if (sheet) {
        const rowIndex = findRow(sheet, data.matricola);
        if (rowIndex !== -1) sheet.deleteRow(rowIndex);
      }
      return corsResponse({ status: "ok" });
    }

    // ----------------------------------------------------------------
    // Quiz actions: init, update, finalize
    // ----------------------------------------------------------------
    const examId = data.examId;
    if (!examId) return corsResponse({ status: "error", message: "examId mancante" });

    const resolved = resolveEsame(examId);
    if (!resolved) return corsResponse({ status: "error", message: "Esame non trovato: " + examId });

    const track    = resolved.track;
    const nQ       = resolved.n_questions;
    const totalPts = resolved.total_pts;

    if (track.mode !== "practice" && track.status === "closed" && data.action === "init") {
      return corsResponse({ status: "error", message: "Esame non disponibile" });
    }

    const sheet = getResultSheet(examId, nQ);

    // ---- RESET PRACTICE ----
    if (data.action === "resetPractice") {
      if (track.mode !== "practice") {
        return corsResponse({ status: "error", message: "Azione disponibile solo in modalità esercitazione" });
      }
      const rowIndex = findRow(sheet, data.matricola);
      if (rowIndex !== -1) sheet.deleteRow(rowIndex);
      // Le domande sono assegnate dal SERVER (resolved.questions), mai dal client
      const assigned          = resolved.questions;
      const epMap             = resolved.effectivePuntiMap || {};
      const qIds              = assigned.map(q => q.id);
      const seed              = track.shuffle_options !== false ? Math.floor(Math.random() * 2147483647) : null;
      const qidsCellParts     = qIds.map(id => epMap[id] !== undefined ? id + ":" + epMap[id] : id);
      const qidsCell          = qidsCellParts.join(",") + (seed !== null ? ";seed=" + seed : "");
      const row = [String(data.matricola), data.nominativo || "", data.email || "",
                   "", totalPts, new Date(), "", "",
                   qidsCell];
      for (let i = 0; i < assigned.length; i++) { row.push(""); row.push(""); }
      sheet.appendRow(row);
      sheet.getRange(sheet.getLastRow(), COL_MATRICOLA).setNumberFormat("@");
      return corsResponse({ status: "ok", questions: assigned, total_pts: totalPts, seed });
    }

    // ---- INIT ----
    if (data.action === "init") {
      const lock = LockService.getScriptLock();
      try { lock.waitLock(15000); } catch(e) {}
      try {
        const values = sheet.getDataRange().getValues();
        for (let i = 1; i < values.length; i++) {
          if (String(values[i][COL_MATRICOLA - 1]) === String(data.matricola)) {
            return corsResponse({ status: "duplicate", finalized: values[i][COL_TS_END - 1] !== "" });
          }
        }
        // SICUREZZA: le domande sono assegnate dal SERVER, mai accettate dal client.
        // resolved.questions è la risoluzione server-side (senza risposte corrette).
        const assigned      = resolved.questions;
        const epMap         = resolved.effectivePuntiMap || {};
        const qIds          = assigned.map(q => q.id);
        const seed          = track.shuffle_options !== false ? Math.floor(Math.random() * 2147483647) : null;
        const qidsCellParts = qIds.map(id => epMap[id] !== undefined ? id + ":" + epMap[id] : id);
        const qidsCell      = qidsCellParts.join(",") + (seed !== null ? ";seed=" + seed : "");
        // Colonne fisse: Matricola, Nominativo, Email, Score, Totale, Inizio, Fine, Durata, QIDs
        const row = [String(data.matricola), data.nominativo || "", data.email || "",
                     "", totalPts, new Date(), "", "",
                     qidsCell];
        for (let i = 0; i < assigned.length; i++) { row.push(""); row.push(""); }
        sheet.appendRow(row);
        sheet.getRange(sheet.getLastRow(), COL_MATRICOLA).setNumberFormat("@");
        // Restituisce le domande autoritative: il client DEVE renderizzare esattamente queste
        return corsResponse({ status: "ok", questions: assigned, total_pts: totalPts, seed });
      } finally {
        try { lock.releaseLock(); } catch(e) {}
      }
    }

    // ---- UPDATE ----
    if (data.action === "update") {
      const rowIndex = findRow(sheet, data.matricola);
      if (rowIndex === -1) return corsResponse({ status: "error", message: "Matricola non trovata" });
      // Blocca modifiche dopo la consegna definitiva (anti-manomissione, exam mode)
      if (track.mode !== "practice") {
        const ended = sheet.getRange(rowIndex, COL_TS_END).getValue();
        if (ended !== "" && ended !== null) {
          return corsResponse({ status: "error", message: "Esame già consegnato" });
        }
      }
      const qIdx = parseInt(data.qIndex, 10);
      // Protezione: qIndex valido (>=1) per non scrivere mai nelle colonne di metadati
      // (Score, Totale, Durata...) che precedono la prima colonna risposta.
      if (!Number.isInteger(qIdx) || qIdx < 1) {
        return corsResponse({ status: "error", message: "qIndex non valido" });
      }
      const col  = COL_ANS_FIRST + (qIdx - 1) * 2;
      // Salva solo la risposta grezza — il punteggio è calcolato server-side in finalize
      sheet.getRange(rowIndex, col).setValue(data.ans !== undefined ? data.ans : "");
      // Restituisce extra tempo individuale (NON include "all", già gestito via getTrack)
      const extraInd = getExtraMinutesIndividual(track.exam_id, data.matricola);
      return corsResponse({ status: "ok", extra_minutes_individual: extraInd });
    }

    // ---- RESUME (ripresa d'emergenza, es. blackout) ----
    // Consente di recuperare una sessione NON consegnata da qualsiasi dispositivo,
    // SOLO se il docente ha acceso l'interruttore globale per questo esame.
    // Non rivela mai le risposte corrette; rifiuta sessioni già finalizzate.
    if (data.action === "resume") {
      if (!getResumeAll(track.exam_id)) {
        return corsResponse({ status: "error", message: "Ripresa non consentita" });
      }
      const rowIndex = findRow(sheet, data.matricola);
      if (rowIndex === -1) return corsResponse({ status: "error", message: "Nessuna sessione da riprendere" });
      const existingRow = sheet.getRange(rowIndex, 1, 1, sheet.getLastColumn()).getValues()[0];
      // Mai riaprire un esame già consegnato (vale anche durante la finestra globale)
      if (track.mode !== "practice" && existingRow[COL_TS_END - 1] !== "" && existingRow[COL_TS_END - 1] !== null) {
        return corsResponse({ status: "error", message: "Esame già consegnato" });
      }
      const allQ        = loadAllQuestions();
      const assignedIds = parseQIds(existingRow[COL_QIDS - 1]);
      const seed        = parseQIdsSeed(existingRow[COL_QIDS - 1]);
      // Ricostruisce ESATTAMENTE le domande memorizzate (mai una nuova risoluzione: le random
      // differirebbero), senza risposte corrette — come init.
      const rQuestions = assignedIds.map((qId, i) => {
        const q = allQ[qId];
        if (!q) return { id: qId, error: "Domanda non trovata: " + qId, pts: 0, type: "mc", text: "", pos: i + 1 };
        return buildQuestionObj(q, i + 1, false);
      });
      // Risposte già salvate (via update), riconvertite nel formato in-memory del client
      const rAnswers = assignedIds.map((qId, i) => {
        const raw  = existingRow[COL_ANS_FIRST - 1 + i * 2];
        const type = allQ[qId] ? allQ[qId].tipo : "mc";
        if (raw === "" || raw === null || raw === undefined) return null;
        if (type === "mc") { const n = parseInt(raw, 10); return isNaN(n) ? null : n; }
        if (type === "match" || type === "multi-fitb" || type === "cloze") {
          try { return JSON.parse(raw); } catch(e) { return null; }
        }
        return String(raw); // fitb / free
      });
      const totalPtsResume = Number(existingRow[COL_TOTALE - 1])
        || assignedIds.reduce((s, id) => s + (allQ[id] ? (Number(allQ[id].punti) || 1) : 0), 0)
        || totalPts;
      const tsStart = parseTs(existingRow[COL_TS_START - 1]);
      return corsResponse({
        status:       "ok",
        questions:    rQuestions,
        answers:      rAnswers,
        seed:         seed,
        total_pts:    totalPtsResume,
        ts_start_iso: tsStart ? tsStart.toISOString() : null
      });
    }

    // ---- FINALIZE ----
    if (data.action === "finalize") {
      const lock = LockService.getScriptLock();
      try { lock.waitLock(15000); } catch(e) {}
      try {
        const rowIndex = findRow(sheet, data.matricola);
        if (rowIndex === -1) return corsResponse({ status: "error", message: "Matricola non trovata" });

        const existingRow = sheet.getRange(rowIndex, 1, 1, sheet.getLastColumn()).getValues()[0];

        // ANTI-ORACLE: in exam mode, una volta consegnato il punteggio è CONGELATO.
        // Una ri-finalizzazione NON ricalcola e restituisce sempre lo score memorizzato,
        // ignorando eventuali nuove risposte. Questo impedisce di sottomettere set di
        // risposte diversi leggendo lo score per dedurre le risposte corrette per tentativi.
        // È idempotente: i retry di rete legittimi ricevono comunque il loro punteggio.
        if (track.mode !== "practice" && existingRow[COL_TS_END - 1] !== "" && existingRow[COL_TS_END - 1] !== null) {
          return corsResponse({
            status: "ok", already: true,
            score: existingRow[COL_SCORE - 1],
            total_pts: Number(existingRow[COL_TOTALE - 1]) || totalPts
          });
        }

        // Punteggio ricalcolato SERVER-SIDE usando gli ID assegnati (COL_QIDS), mai score/pts dal client
        const allQ      = loadAllQuestions();
        const qidsPunti = parseQIdsPunti(existingRow[COL_QIDS - 1]);
        const assignedIds = qidsPunti.map(x => x.id);

        // Denominatore (totale punti) coerente con le domande EFFETTIVAMENTE assegnate.
        // Per tracce random, resolveEsame() ridisegna domande diverse ad ogni chiamata: usare
        // resolved.total_pts qui darebbe un denominatore (e una conversione in /30) sbagliato.
        // Priorità: COL_TOTALE salvato all'init (ciò che lo studente ha visto) → ricalcolo dagli ID → fallback.
        const totalPtsResp = Number(existingRow[COL_TOTALE - 1])
          || qidsPunti.reduce((s, { id, punti }) => {
               const q = allQ[id];
               return s + (q ? (punti !== null ? punti : (Number(q.punti) || 1)) : 0);
             }, 0)
          || totalPts;

        let serverScore = 0;
        const scoredAnswers = [];
        qidsPunti.forEach(({ id: qId, punti: ep }, i) => {
          // Usa la risposta inviata se presente, altrimenti quella già salvata da update
          let ans;
          if (data.answers && data.answers[i] !== undefined) {
            ans = data.answers[i].ans !== undefined ? data.answers[i].ans : String(data.answers[i]);
          } else {
            ans = existingRow[COL_ANS_FIRST - 1 + i * 2] ?? "";
          }
          // Applica i punti effettivi della traccia sovrascrivendo il default della domanda
          const qRaw = allQ[qId];
          const q    = (qRaw && ep !== null) ? Object.assign({}, qRaw, { punti: ep }) : qRaw;
          const pts  = scoreAnswer(q, ans);
          serverScore += pts;
          scoredAnswers.push({ ans, pts });
        });

        const nScored  = assignedIds.filter(qId => allQ[qId] && allQ[qId].tipo !== "free").length;
        const nCorrect = scoredAnswers.filter((sa, i) => {
          const { id: qId, punti: ep } = qidsPunti[i];
          const qRaw = allQ[qId];
          if (!qRaw || qRaw.tipo === "free") return false;
          const maxPts = ep !== null ? ep : (Number(qRaw.punti) || 1);
          return sa.pts >= maxPts;
        }).length;

        // Tempo calcolato SERVER-SIDE: inizio dal foglio (scritto all'init), fine = adesso.
        // Ignora tsStart/tsEnd/elapsed inviati dal client (manomissibili).
        const serverStart = parseTs(existingRow[COL_TS_START - 1]);
        const serverEnd   = new Date();
        let elapsedStr = data.elapsed || "";
        let overtime = false;
        if (serverStart) {
          const secs = Math.round((serverEnd - serverStart) / 1000);
          elapsedStr = Math.floor(secs / 60) + "m " + (secs % 60) + "s";
          const extraAll = getExtraMinutesAll(track.exam_id);
          const extraInd = getExtraMinutesIndividual(track.exam_id, data.matricola);
          const durMin = parseInt(track.duration, 10) + extraAll + extraInd;
          if (durMin > 0 && secs > durMin * 60 + 60) { // 60s di tolleranza
            overtime = true;
            elapsedStr += " ⚠ oltre tempo";
          }
        }

        sheet.getRange(rowIndex, COL_NOMINATIVO).setValue(data.nominativo || existingRow[COL_NOMINATIVO - 1] || "");
        sheet.getRange(rowIndex, COL_EMAIL).setValue(data.email || existingRow[COL_EMAIL - 1] || "");
        sheet.getRange(rowIndex, COL_SCORE).setValue(serverScore);            // score server-side
        sheet.getRange(rowIndex, COL_TS_END).setValue(serverEnd); // fine server-side
        sheet.getRange(rowIndex, COL_ELAPSED).setValue(elapsedStr);
        scoredAnswers.forEach((item, i) => {
          const col = COL_ANS_FIRST + i * 2;
          sheet.getRange(rowIndex, col).setValue(item.ans !== undefined ? item.ans : "");
          sheet.getRange(rowIndex, col + 1).setValue(item.pts);
        });

        const response = { status: "ok", score: serverScore, total_pts: totalPtsResp, overtime: overtime, n_correct: nCorrect, n_scored: nScored };
        // Le risposte corrette si rivelano SOLO in practice e SOLO dopo la consegna
        if (track.mode === "practice") {
          const qForFeedback = assignedIds.map(qId => buildQuestionObj(allQ[qId], 0, true));
          response.correct_answers = qForFeedback.map((q, idx) => ({
            id: q.id, correct: q.correct, type: q.type,
            options: q.options, right: q.right, boxes: q.boxes, dropdowns: q.dropdowns,
            scored_pts: scoredAnswers[idx].pts,
            max_pts: (qidsPunti[idx]?.punti !== null ? qidsPunti[idx]?.punti : null)
                     ?? (Number(allQ[assignedIds[idx]]?.punti) || 1)
          }));
        }
        return corsResponse(response);
      } finally {
        try { lock.releaseLock(); } catch(e) {}
      }
    }

    return corsResponse({ status: "error", message: "Azione non riconosciuta: " + data.action });

  } catch (err) {
    return corsResponse({ status: "error", message: err.toString() });
  }
}
