/* ===== SETTINGS: your Supabase URL and anon key (edit these two lines) ===== */
// settings.js - the only file you edit to connect to Supabase.
// Supabase Dashboard -> Project Settings -> API. Use the "anon / public" key.
// NEVER put the service_role key in browser code.
const SUPABASE_URL = 'https://ynsiqvypmmonofhqvmhq.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_29R-PNdxnYVNYvjCEEjZhg_Sk-MANeL';

/* ===== DATABASE: the only calls the page makes to Supabase ===== */
// database.js - the only functions the browser may call (all go through the functions in sql/schema.sql).
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });

const Api = {
  async rpc(fn, args = {}) {
    const { data, error } = await sb.rpc(fn, args);
    if (error) throw new Error(error.message);
    return data;
  },

  // session token (sessionStorage: cleared when the tab closes)
  token: () => sessionStorage.getItem('iv_token'),
  setToken(t) { t ? sessionStorage.setItem('iv_token', t) : sessionStorage.removeItem('iv_token'); },

  roles:         () => Api.rpc('iv_list_roles'),
  signup:        (email, pin, consent) => Api.rpc('iv_signup', { p_email: email, p_pin: pin, p_role: 'receptionist', p_consent: consent }),
  cancelSignup:  () => Api.rpc('iv_cancel_signup', { p_token: Api.token() }),
  pinLogin:      (email, pin) => Api.rpc('iv_pin_login', { p_email: email, p_pin: pin }),
  faceLogin:     descriptor => Api.rpc('iv_face_login', { p_descriptor: descriptor }),
  me:            () => Api.rpc('iv_me', { p_token: Api.token() }),
  reportFailure: kind => Api.rpc('iv_report_failure', { p_token: Api.token(), p_kind: kind }),
  saveId:        (type, fields, confidence, descriptor) =>
                   Api.rpc('iv_save_id', { p_token: Api.token(), p_id_type: type, p_fields: fields, p_confidence: confidence, p_descriptor: descriptor }),
  saveFace:      frames => Api.rpc('iv_save_face', { p_token: Api.token(), p_frames: frames }),
  getRecord:     () => Api.rpc('iv_get_record', { p_token: Api.token() }),
  saveInfo:      fields => Api.rpc('iv_save_info', { p_token: Api.token(), p_fields: fields }),
  listPending:   () => Api.rpc('iv_list_pending', { p_token: Api.token() }),
  decide:        (userId, action, role, reason) =>
                   Api.rpc('iv_decide', { p_token: Api.token(), p_user_id: userId, p_action: action, p_role: role || null, p_reason: reason || '' }),
  async logout() { try { await Api.rpc('iv_logout', { p_token: Api.token() }); } finally { Api.setToken(null); } }
};
window.Api = Api;

/* ===== RULES: ID text parsing, pose check, age, blur check ===== */
// rules.js - pure functions (no DOM, no network). Safe to unit test in Node.
(function (root) {
  'use strict';

  const CONFIG = {
    // Face models are downloaded once from this CDN (needs internet on first load)
    MODEL_URL: 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.13/model/',
    MIN_OCR_CONF: 0.30,        // Tesseract average confidence (0-1)
    MIN_SHARPNESS: 40,         // blur check on the ID photo
    CLOSER_FACTOR: 1.12,       // face must be at least 12% wider than the straight capture
    FARTHER_FACTOR: 0.90,      // face must be at least 10% narrower than the straight capture
    EYE_OPEN_MIN: 0.18,
    EYE_BLINK_CLOSED_RATIO: 0.84,
    EYE_BLINK_REOPEN_RATIO: 0.92,
    SAME_PERSON_DIST: 0.8,     // client-side sanity check between two frames
    REQUIRED: ['full_name', 'dob', 'id_number'],
    ID_TYPES: {
      philid: 'Philippine National ID (PhilSys)',
      drivers: "Driver's License",
      passport: 'Passport',
      umid: 'UMID'
    },
    POSES: [
      { key: 'straight', text: 'Look straight at the camera' },
      { key: 'blink',    text: 'Blink once' },
      { key: 'farther',  text: 'Move slightly farther away' },
      { key: 'closer',   text: 'Move closer to the camera' }
    ]
  };

  /* ---------------------------------------------------------- dates */
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

  function iso(y, m, d) {
    y = +y; m = +m; d = +d;
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
    return String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }

  function findDates(text) {
    const out = [];
    for (const m of text.matchAll(/\b(\d{4})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})\b/g)) out.push(iso(m[1], m[2], m[3]));
    for (const m of text.matchAll(/\b(\d{1,2})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{4})\b/g)) {
      const a = +m[1], b = +m[2];
      out.push(a <= 12 ? iso(m[3], a, b) : iso(m[3], b, a));         // MM-DD-YYYY unless the first part is > 12
    }
    for (const m of text.matchAll(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/g)) {
      const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
      if (mon) out.push(iso(m[3], mon, m[2]));
    }
    for (const m of text.matchAll(/\b(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})\b/g)) {
      const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
      if (mon) out.push(iso(m[3], mon, m[1]));
    }
    return out.filter(Boolean);
  }

  /* ---------------------------------------------------------- ID text parsing */
  const ID_PATTERNS = {
    philid:   /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/,
    drivers:  /\b[A-Z]\d{2}[- ]?\d{2}[- ]?\d{6}\b/,
    umid:     /\b\d{4}[- ]?\d{7}[- ]?\d\b/,
    passport: /\b[A-Z]\d{7}[A-Z]\b/
  };
  const ID_TYPE_MARKERS = {
    philid: /\b(?:PHILSYS|PHIL\s*ID|PHILIPPINE\s+(?:NATIONAL\s+)?IDENTIFICATION(?:\s+SYSTEM)?|NATIONAL\s+ID|PSN|PCN|CRN)\b/i,
    drivers: /\b(?:DRIVER'?S?\s+LICEN[CS]E|DRIVING\s+LICEN[CS]E|LAND\s+TRANSPORTATION\s+OFFICE|LTO|DLN)\b/i,
    passport: /\bPASSPORT\b/i,
    umid: /\b(?:UMID|UNIFIED\s+MULTI[- ]PURPOSE(?:\s+ID)?|SSS)\b/i
  };
  const looksLikeIdNumber = line => Object.values(ID_PATTERNS).some(pattern => pattern.test(line.toUpperCase()));
  const FIELD_LABELS = [
    'date of birth', 'birth date', 'birthdate', 'date birth', 'd.o.b', 'dob', 'date of expiry', 'valid until',
    'residential address', 'current address', 'permanent address', 'place of residence', 'residence',
    'given names', 'given name',
    'first names', 'first name', 'last name', 'family name', 'middle names', 'middle name', 'middle initial',
    'middlename', 'gitnang apelyido', 'mga pangalan', 'full name',
    'postal code', 'surname', 'nationality', 'signature', 'address', 'tirahan', 'kapanganakan',
    'apelyido', 'pangalan', 'id number', 'id no', 'crn', 'birth', 'expiry', 'expiration',
    'license', 'sex', 'name', 'date', 'blood', 'agency'
  ];
  const fieldLabelRegex = label => new RegExp(
    '\\b' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*') + '\\b',
    'i'
  );
  const looksLikeLabel = s => FIELD_LABELS.some(label => fieldLabelRegex(label).test(s));
  const trimJunk = s => s.replace(/^[\s:/-]+|[\s:/-]+$/g, '');
  const titleCase = s => s.toLowerCase().replace(/(^|[\s.'-])\p{L}/gu, c => c.toUpperCase());
  function cleanName(s) {
    let value = String(s || '').trim();
    if (/\b(?:given\s*names?|first\s*names?|middle\s*names?|last\s*name|family\s*name|surname|full\s*name|apelyido|mga\s*pangalan|gitnang\s*apelyido)\b/i.test(value)) return '';
    value = value.replace(/\bmidd\s+e\s+[il1]\b/gi, ' ')
      .replace(/[^\p{L}.' -]/gu, ' ').replace(/\s+/g, ' ').trim();
    const words = value.split(' ').filter(Boolean);
    if (words.length >= 3 && /^\p{L}$/u.test(words[0])) words.shift();
    return titleCase(words.join(' '));
  }

  function trimFollowingFields(value) {
    const stop = /\b(?:date of birth|date of expiry|valid until|postal code|id number|id no|crn|birth|address|tirahan|kapanganakan|nationality|signature|expiry|expiration|license|sex)\b/i;
    const match = stop.exec(value);
    return trimJunk(match ? value.slice(0, match.index) : value);
  }

  function trimAtFieldLabel(value, currentLabels) {
    let remaining = value;
    const currentPattern = new RegExp(
      '^(?:\\s*[:/,-]\\s*)?(?:' + currentLabels
        .slice()
        .sort((a, b) => b.length - a.length)
        .map(label => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*'))
        .join('|') + ')\\b\\s*[:/,-]?\\s*',
      'i'
    );
    let previous;
    do {
      previous = remaining;
      remaining = remaining.replace(currentPattern, '');
    } while (remaining !== previous);
    const alternatives = FIELD_LABELS.slice()
      .sort((a, b) => b.length - a.length)
      .map(label => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*'));
    const match = new RegExp('\\b(?:' + alternatives.join('|') + ')\\b', 'i').exec(remaining);
    return trimFollowingFields(match ? remaining.slice(0, match.index) : remaining);
  }

  function valueAfter(lines, labels, take = 1) {
    const ordered = labels.slice().sort((a, b) => b.length - a.length);
    for (let i = 0; i < lines.length; i++) {
      for (const lab of ordered) {
        const label = fieldLabelRegex(lab).exec(lines[i]);
        if (!label) continue;
        if (lab === 'name' && /\b(?:first|last|middle|given)\s$/i.test(lines[i].slice(0, label.index))) continue;
        const rest = trimAtFieldLabel(lines[i].slice(label.index + label[0].length), labels);
        if (rest.length >= 2 && !looksLikeLabel(rest)) return rest;

        const next = [];
        for (const line of lines.slice(i + 1)) {
          if (looksLikeLabel(line) || looksLikeIdNumber(line) || findDates(line).length) break;
          if (line.length >= 2) next.push(line);
          if (next.length >= take) break;
        }
        if (next.length) return next.join(' ');
      }
    }
    return '';
  }

  function nameFromCommaLine(raw, header) {
    const parts = raw.split(',').map(part => part.trim()).filter(Boolean);
    if (parts.length < 2) return cleanName(raw);
    const suffix = /^(?:jr\.?|sr\.?|ii|iii|iv|v)$/i.test(parts[parts.length - 1]) ? parts.pop() : '';
    if (parts.length === 1) return cleanName(parts[0] + ' ' + suffix);
    if (header && /last name/.test(header) && /first name/.test(header)) {
      return cleanName(parts.slice(1).join(' ') + ' ' + parts[0] + ' ' + suffix);
    }
    return cleanName(parts.slice(1).join(' ') + ' ' + parts[0] + ' ' + suffix);
  }

  function nameFromColumns(header, values) {
    const fields = [
      { key: 'last', pattern: /\b(?:last\s*name|family\s*name|surname|apelyido)\b/i },
      { key: 'given', pattern: /\b(?:first\s*names?|given\s*names?|mga\s*pangalan)\b/i },
      { key: 'middle', pattern: /\b(?:middle\s*names?|middle\s*initial|middlename|gitnang\s*apelyido)\b/i }
    ];
    const columns = fields.map(field => {
      const match = field.pattern.exec(header);
      return match ? { key: field.key, start: match.index } : null;
    }).filter(Boolean).sort((a, b) => a.start - b.start);
    if (!columns.some(column => column.key === 'last') || !columns.some(column => column.key === 'given')) return '';

    const valueColumns = values.trim().split(/\s{2,}/).filter(Boolean);
    if (valueColumns.length !== columns.length) return '';
    const extracted = {};
    columns.forEach((column, index) => {
      extracted[column.key] = trimFollowingFields(valueColumns[index]);
    });
    if (!extracted.last || !extracted.given) return '';
    return cleanName(extracted.given + ' ' + (extracted.middle || '') + ' ' + extracted.last);
  }

  function parseName(lines) {
    for (let i = 0; i < lines.length; i++) {
      const low = lines[i].toLowerCase();
      const hasLast = /\b(?:last\s*name|family\s*name|surname|apelyido)\b/.test(low);
      const hasGiven = /\b(?:first\s*names?|given\s*names?|mga\s*pangalan)\b/.test(low);
      if (hasLast && hasGiven) {
        if (lines[i].includes(':')) {
          const lastInline = valueAfter([lines[i]], ['last name', 'family name', 'surname', 'apelyido']);
          const givenInline = valueAfter([lines[i]], ['first names', 'first name', 'given names', 'given name', 'mga pangalan']);
          const middleInline = valueAfter([lines[i]], ['middle names', 'middle name', 'middle initial', 'middlename', 'gitnang apelyido']);
          if (lastInline && givenInline) {
            if (lastInline.toLowerCase() === givenInline.toLowerCase()) return cleanName(givenInline);
            return cleanName(givenInline + ' ' + middleInline + ' ' + lastInline);
          }
        }
        if (i + 1 < lines.length) {
          const raw = trimFollowingFields(lines[i + 1]);
          if (raw && raw.includes(',')) return nameFromCommaLine(raw, low);
          const columns = nameFromColumns(lines[i], lines[i + 1]);
          if (columns) return columns;
          if (raw && !looksLikeLabel(raw)) return '';
        }
      }
    }
    const last = valueAfter(lines, ['last name', 'family name', 'surname', 'apelyido']);
    const given = valueAfter(lines, ['given names', 'given name', 'mga pangalan', 'first names', 'first name']);
    const middle = valueAfter(lines, ['middle names', 'middle name', 'middle initial', 'middlename', 'gitnang apelyido']);
    if (last && given) {
      const lastLower = last.toLowerCase(), givenLower = given.toLowerCase();
      if (lastLower === givenLower || givenLower.includes(lastLower)) return cleanName(given);
      if (lastLower.includes(givenLower)) return cleanName(last);
      return cleanName(given + ' ' + middle + ' ' + last);
    }
    const full = valueAfter(lines, ['full name', 'pangalan', 'name'], 2);
    if (full) return full.includes(',') ? nameFromCommaLine(full, '') : cleanName(full);
    return '';
  }

  function parseAddress(lines) {
    const labels = ['residential address', 'current address', 'permanent address', 'address', 'tirahan', 'residence'];
    for (let i = 0; i < lines.length; i++) {
      for (const lab of labels) {
        const label = fieldLabelRegex(lab).exec(lines[i]);
        if (!label) continue;
        const parts = [];
        const inline = trimAtFieldLabel(lines[i].slice(label.index + label[0].length), labels);
        if (inline.length >= 2 && !looksLikeLabel(inline)) parts.push(inline);
        for (const line of lines.slice(i + 1)) {
          if (looksLikeLabel(line) || looksLikeIdNumber(line) || parts.length >= 3) break;
          const part = trimAtFieldLabel(line, labels);
          if (part.length >= 2) parts.push(part);
          if (part.length < line.length) break;
        }
        return cleanAddress(parts.join(' '));
      }
    }
    return '';
  }

  function cleanAddress(value) {
    const words = String(value || '').split(/\s+/).filter(Boolean)
      .filter(word => !/[©£|]/u.test(word))
      .map(word => word.replace(/[^\p{L}\p{N},.'#/-]/gu, ''))
      .filter(Boolean);
    let leadingDigits = 0;
    while (leadingDigits < words.length && /^\d$/u.test(words[leadingDigits])) leadingDigits++;
    if (leadingDigits >= 3 && /^\p{L}/u.test(words[leadingDigits] || '')) words.splice(0, leadingDigits);
    if (words.length >= 5 && /^\p{L}$/u.test(words[words.length - 1]) &&
        words[words.length - 1] === words[words.length - 1].toUpperCase()) words.pop();
    return words.join(' ').replace(/\s*,\s*/g, ', ').replace(/\s+/g, ' ').trim();
  }

  function dateNear(lines, keys, span = 1) {
    const ordered = keys.slice().sort((a, b) => b.length - a.length);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].toLowerCase();
      for (const key of ordered) {
        const index = line.indexOf(key);
        if (index < 0) continue;
        const sameLine = findDates(lines[i].slice(index + key.length));
        if (sameLine.length) return sameLine[0];
        for (let offset = 1; offset <= span && i + offset < lines.length; offset++) {
          const next = lines[i + offset];
          if (looksLikeLabel(next) || looksLikeIdNumber(next)) break;
          const found = findDates(next);
          if (found.length) return found[0];
        }
      }
    }
    return '';
  }

  function parseIdText(rawText, idType) {
    const lines = String(rawText || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const joined = lines.join(' ').toUpperCase();
    const pattern = ID_PATTERNS[idType];
    const m = pattern ? joined.match(pattern) : null;
    const dob = dateNear(lines, ['date of birth', 'birth date', 'birthdate', 'date birth', 'birthday', 'birth', 'dob', 'd.o.b', 'kapanganakan'], 2);
    return {
      lines,
      fields: {
        full_name: parseName(lines),
        dob,
        address: parseAddress(lines),
        id_number: m ? m[0].replace(/ /g, '-') : '',
        expiry: dateNear(lines, ['date of expiry', 'valid until', 'expir'])
      }
    };
  }

  function detectIdType(rawText) {
    if (Array.isArray(rawText)) {
      const counts = new Map();
      rawText.map(detectIdType).filter(Boolean).forEach(type => counts.set(type, (counts.get(type) || 0) + 1));
      const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      return ranked.length && (ranked.length === 1 || ranked[0][1] > ranked[1][1]) ? ranked[0][0] : null;
    }
    const text = String(rawText || '').toUpperCase();
    const marked = Object.entries(ID_TYPE_MARKERS).filter(([, pattern]) => pattern.test(text)).map(([type]) => type);
    if (marked.length === 1) return marked[0];
    if (marked.length > 1) return null;
    const numberMatches = Object.entries(ID_PATTERNS).filter(([, pattern]) => pattern.test(text)).map(([type]) => type);
    return numberMatches.length === 1 ? numberMatches[0] : null;
  }

  function checkIdType(rawText, selectedType) {
    if (!CONFIG.ID_TYPES[selectedType]) return { ok: false, detected: null, message: 'Choose a supported ID type.' };
    const detected = detectIdType(rawText);
    if (detected && detected !== selectedType) {
      return {
        ok: false,
        detected,
        message: 'The selected ID type is ' + CONFIG.ID_TYPES[selectedType] + ', but the document appears to be ' +
          CONFIG.ID_TYPES[detected] + '. Select the matching ID type and scan it again.'
      };
    }
    return { ok: true, detected };
  }

  // Readability check: required fields present and OCR confident enough
  function checkOcr(parsed, confidence) {
    const labels = { full_name: 'full name', dob: 'date of birth', id_number: 'ID number', address: 'address' };
    const missing = CONFIG.REQUIRED.filter(k => !parsed.fields[k]);
    if (missing.length || confidence < CONFIG.MIN_OCR_CONF) {
      const why = missing.length ? 'Could not reliably read: ' + missing.map(k => labels[k] || k).join(', ') + '.' : 'The text is not clear enough.';
      return { ok: false, message: why + ' Retake the ID photo flat, in good light, with all text visible.' };
    }
    return { ok: true };
  }

  /* ---------------------------------------------------------- face pose */
  function eyeAspectRatio(eye) {
    const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    return (distance(eye[1], eye[5]) + distance(eye[2], eye[4])) / (2 * Math.max(distance(eye[0], eye[3]), 1));
  }

  // points = 68 landmarks [{x,y}].
  function poseFromLandmarks(points, boxWidth, imageWidth) {
    const leftEye = eyeAspectRatio(points.slice(36, 42));
    const rightEye = eyeAspectRatio(points.slice(42, 48));
    const eyeRatio = (leftEye + rightEye) / 2;
    return { label: 'straight', ratio: boxWidth / imageWidth, eyeRatio };
  }

  // infos: { straight, blink, farther, closer } -> { label, ratio } or null when no face was found
  function checkPoses(infos) {
    const s = infos.straight;
    if (!s || s.label !== 'straight') return { ok: false, passed: [], failed: ['straight'] };
    const passed = [], failed = [];
    for (const p of CONFIG.POSES.map(x => x.key)) {
      const i = infos[p];
      (poseMatches(p, i, s) ? passed : failed).push(p);
    }
    return { ok: passed.length >= 4, passed, failed };
  }

  function poseMatches(pose, info, straight) {
    if (!info) return false;
    if (pose === 'blink') return info.label === 'straight' && info.blinked === true;
    if (pose === 'straight') return info.label === 'straight';
    if (!straight || straight.label !== 'straight' || info.label !== 'straight') return false;
    if (pose === 'closer') return info.ratio >= straight.ratio * CONFIG.CLOSER_FACTOR;
    if (pose === 'farther') return info.ratio <= straight.ratio * CONFIG.FARTHER_FACTOR;
    return false;
  }

  function recordBlink(eyeRatio, baseline, state) {
    const reference = Number.isFinite(baseline) && baseline >= CONFIG.EYE_OPEN_MIN ? baseline : CONFIG.EYE_OPEN_MIN;
    if (eyeRatio >= reference * CONFIG.EYE_BLINK_REOPEN_RATIO) {
      const blinked = state.closed;
      state.opened = true;
      state.closed = false;
      return blinked;
    }
    if (state.opened && eyeRatio <= reference * CONFIG.EYE_BLINK_CLOSED_RATIO) state.closed = true;
    return false;
  }

  /* ---------------------------------------------------------- misc */
  function calcAge(dobIso, today = new Date()) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dobIso || '');
    if (!m || !iso(m[1], m[2], m[3])) return null;
    let age = today.getFullYear() - +m[1];
    const md = today.getMonth() + 1 - +m[2];
    if (md < 0 || (md === 0 && today.getDate() < +m[3])) age--;
    return age >= 0 && age <= 110 ? age : null;
  }

  function validateInfo(f) {
    if (!String(f.full_name || '').trim() || !String(f.id_number || '').trim()) return 'Full name and ID number are required.';
    if (calcAge(f.dob) === null) return 'Enter a valid date of birth.';
    return '';
  }

  // Blur check: variance of the Laplacian on a grayscale image (low = blurry)
  function laplacianVariance(gray, w, h) {
    let sum = 0, sumSq = 0, n = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const v = gray[i - w] + gray[i + w] + gray[i - 1] + gray[i + 1] - 4 * gray[i];
        sum += v; sumSq += v * v; n++;
      }
    }
    const mean = sum / n;
    return sumSq / n - mean * mean;
  }

  const api = { CONFIG, findDates, parseIdText, detectIdType, checkIdType, checkOcr, poseFromLandmarks, poseMatches, checkPoses, recordBlink, calcAge, validateInfo, laplacianVariance };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BusinessLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);

/* ===== MAIN: screens, camera, OCR, face matching ===== */
// main.js - screens and wiring. Pure rules live in rules.js, database calls in database.js.
(() => {
  'use strict';
  const BL = window.BusinessLogic, Api = window.Api, CFG = BL.CONFIG;
  const $ = id => document.getElementById(id);
  const SCREENS = ['home', 'login', 'signup', 'id', 'face', 'info', 'result', 'dashboard', 'approvals'];
  const STEP_OF = { id: 1, face: 2, info: 3, result: 5 };       // 5 = every step shown as done
  let me = null, roles = [], modelsReady = false, registrationInProgress = false, captureCancelled = false, lockRefreshTimer = null;
  let capturedIdFile = null, idPreviewUrl = null;

  /* ------------------------------------------------------------ helpers */
  function show(name) {
    if (name !== 'face' && name !== 'login') cancelActiveCapture();
    SCREENS.forEach(s => { $('screen-' + s).hidden = s !== name; });
    const step = STEP_OF[name];
    $('stepper').hidden = !step;
    if (step) [...$('stepper').children].forEach((li, i) => { li.className = i + 1 < step ? 'done' : i + 1 === step ? 'now' : ''; });
    const registering = me && me.status === 'unverified';
    $('btn-logout').hidden = !Api.token() || registering;
    $('btn-logout').textContent = 'Log out';
    $('who').hidden = !me || registering; if (me && !registering) $('who').textContent = me.email;
    window.scrollTo(0, 0);
  }
  function say(id, text, kind = 'bad') { const el = $(id); el.textContent = text || ''; el.className = 'alert ' + kind; el.hidden = !text; }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const roleLabel = key => (roles.find(r => r.key === key) || {}).label || key || '';
  function lockText(isoTime) {
    if (!isoTime || new Date(isoTime) <= new Date()) return '';
    return 'Too many failed attempts. Try again after ' + new Date(isoTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + '.';
  }
  function clearLockRefreshTimer() {
    if (lockRefreshTimer) clearTimeout(lockRefreshTimer);
    lockRefreshTimer = null;
  }
  function scheduleLockRefresh() {
    clearLockRefreshTimer();
    const expiresAt = new Date(me && me.locked_until).getTime();
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return;
    lockRefreshTimer = setTimeout(refreshLockState, expiresAt - Date.now() + 300);
  }
  async function refreshLockState() {
    lockRefreshTimer = null;
    try {
      if (!(await refreshMe())) {
        $('btn-scan').disabled = true;
        $('btn-face-start').disabled = true;
        if (!$('screen-id').hidden) say('msg-id', 'Your registration session expired. Please sign up again.');
        else if (!$('screen-face').hidden) say('msg-face', 'Your registration session expired. Please sign up again.');
        return;
      }
      const lock = lockText(me.locked_until);
      $('btn-scan').disabled = !!lock;
      $('btn-face-start').disabled = !!lock;
      if (lock) {
        if (!$('screen-id').hidden) say('msg-id', lock, 'warn');
        else if (!$('screen-face').hidden) say('msg-face', lock, 'warn');
        scheduleLockRefresh();
        return;
      }
      if (!$('screen-id').hidden) say('msg-id', 'ID scan unlocked. You can try again.', 'good');
      else if (!$('screen-face').hidden) say('msg-face', 'Face capture unlocked. You can try again.', 'good');
    } catch (err) {
      const message = 'Could not refresh the verification lock. Check your connection; it will retry shortly.';
      if (!$('screen-id').hidden) say('msg-id', message, 'warn');
      else if (!$('screen-face').hidden) say('msg-face', message, 'warn');
      lockRefreshTimer = setTimeout(refreshLockState, 5000);
    }
  }
  async function refreshMe() {
    const r = await Api.me();
    if (!r.ok) { Api.setToken(null); me = null; return false; }
    me = r; return true;
  }

  /* ------------------------------------------------------------ camera + face models */
  async function startCam(video, facingMode = 'user') {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)
      throw new Error('Camera access is unavailable. Use a supported browser over HTTPS or use your PIN.');
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 960 }, facingMode: { ideal: facingMode } },
      audio: false
    });
    video.srcObject = stream;
    try {
      await video.play();
      if (!video.videoWidth || !video.videoHeight) {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('The camera did not produce a video frame. Check camera permissions and try again.')), 5000);
          video.addEventListener('loadeddata', () => { clearTimeout(timeout); resolve(); }, { once: true });
        });
      }
    } catch (error) {
      stopCam(video);
      throw error;
    }
  }
  function stopCam(video) { if (video.srcObject) video.srcObject.getTracks().forEach(t => t.stop()); video.srcObject = null; }
  function cancelActiveCapture() {
    captureCancelled = true;
    stopCam($('face-video')); stopCam($('login-video'));
  }
  function snap(video) {                                     // raw, un-mirrored frame
    const c = document.createElement('canvas');
    c.width = video.videoWidth; c.height = video.videoHeight;
    c.getContext('2d').drawImage(video, 0, 0);
    return c;
  }
  async function ensureModels(onStatus) {
    if (modelsReady) return;
    onStatus('Loading face models (first time only)...');
    await Promise.all([
      faceapi.nets.ssdMobilenetv1.loadFromUri(CFG.MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(CFG.MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(CFG.MODEL_URL)
    ]);
    modelsReady = true;
  }
  const detectorOptions = () => new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 });

  // One live frame -> pose + 128-number face template, or null when no face is found
  async function describe(canvas) {
    const faces = await faceapi.detectAllFaces(canvas, detectorOptions()).withFaceLandmarks().withFaceDescriptors();
    if (!faces.length) return null;
    faces.sort((a, b) => b.detection.box.area - a.detection.box.area);
    const r = faces[0], second = faces[1];
    if (r.detection.score < 0.5 || r.detection.box.width < canvas.width * 0.1) return null;
    if (second && second.detection.box.area > r.detection.box.area * 0.55) return null;
    return { ...BL.poseFromLandmarks(r.landmarks.positions, r.detection.box.width, canvas.width),
             descriptor: Array.from(r.descriptor, x => +x.toFixed(5)) };
  }

  async function capturePose(video, pose, straight, sayEl) {
    let steadyFrames = 0, captured = null;
    const blinkState = { opened: false, closed: false };
    const eyeBaseline = straight && Number.isFinite(straight.eyeRatio) && straight.eyeRatio >= CFG.EYE_OPEN_MIN
      ? straight.eyeRatio : null;
    sayEl.textContent = pose.text + ' — hold still while the camera checks.';
    while (!captureCancelled) {
      const canvas = snap(video), info = await describe(canvas);
      if (captureCancelled) return null;
      if (pose.key === 'blink') {
        if (info && info.label === 'straight' && BL.recordBlink(info.eyeRatio, eyeBaseline, blinkState)) {
          return { pose: pose.key, info: { ...info, blinked: true } };
        }
        sayEl.textContent = !info ? 'Center one face in the guide and use even lighting.'
          : blinkState.closed ? 'Blink detected — open your eyes.'
          : blinkState.opened ? 'Close and reopen your eyes to blink.'
          : 'Open your eyes, then blink once.';
        await sleep(100);
        continue;
      }
      if (BL.poseMatches(pose.key, info, straight)) {
        steadyFrames++;
        captured = { pose: pose.key, info };
        if (steadyFrames >= 2) return captured;
        sayEl.textContent = 'Pose detected — hold still...';
      } else {
        steadyFrames = 0;
        if (!info) sayEl.textContent = 'Center one face in the guide and use even lighting.';
        else sayEl.textContent = pose.text + ' — hold the pose until it is detected.';
      }
      await sleep(120);
    }
    return null;
  }

  /* ------------------------------------------------------------ routing */
  async function route() {
    if (!Api.token()) { me = null; return show('home'); }
    if (!(await refreshMe())) return show('home');
    registrationInProgress = me.status === 'unverified';
    if (me.status === 'active') return showDashboard();
    if (me.status === 'unverified') return goStep(me.verify_step);
    return showResult();
  }
  function goStep(step) {
    if (step <= 0) enterId(); else if (step === 1) enterFace(); else if (step === 2) enterInfo(); else showResult();
  }

  /* ------------------------------------------------------------ sign up */
  $('signup-form').onsubmit = async e => {
    e.preventDefault(); say('msg-signup', '');
    try {
      const r = await Api.signup($('su-email').value, $('su-pin').value, $('su-consent').checked);
      if (!r.ok) return say('msg-signup', r.message);
      Api.setToken(r.token); registrationInProgress = true; $('signup-form').reset(); await route();
    } catch (err) { say('msg-signup', err.message); }
  };

  /* ------------------------------------------------------------ step 1: ID upload + OCR */
  function enterId() {
    show('id');
    const lock = lockText(me.locked_until);
    say('msg-id', lock, 'warn'); $('btn-scan').disabled = !!lock;
    if (lock) scheduleLockRefresh(); else clearLockRefreshTimer();
  }
  function showIdRetry() {
    $('btn-id-retry').hidden = false;
  }
  function resetIdRetry() {
    capturedIdFile = null;
    $('id-file').value = '';
    showIdPreview(null);
    stopCam($('id-video'));
    $('id-camera-wrap').hidden = true;
    $('btn-scan').textContent = 'Scan ID';
    $('btn-id-retry').hidden = true;
    say('msg-id', 'Choose or capture a clearer image, then scan it again.', 'warn');
  }
  function showIdPreview(file) {
    const img = $('id-preview');
    if (idPreviewUrl) URL.revokeObjectURL(idPreviewUrl);
    if (!file) { img.hidden = true; img.removeAttribute('src'); idPreviewUrl = null; return; }
    idPreviewUrl = URL.createObjectURL(file);
    img.src = idPreviewUrl; img.hidden = false;
  }
  const selectedIdFile = () => capturedIdFile || $('id-file').files[0];
  $('id-file').onchange = () => {
    capturedIdFile = null;
    showIdPreview($('id-file').files[0]);
    $('btn-scan').textContent = 'Scan ID';
    $('btn-id-retry').hidden = true;
    say('msg-id', '');
  };
  $('id-type').onchange = () => {
    $('btn-scan').textContent = 'Scan ID';
    $('btn-id-retry').hidden = true;
    say('msg-id', '');
  };
  $('btn-id-retry').onclick = resetIdRetry;
  $('btn-id-upload').onclick = () => $('id-file').click();
  $('btn-id-camera').onclick = async () => {
    const wrap = $('id-camera-wrap');
    try {
      await startCam($('id-video'), 'environment');
      wrap.hidden = false;
      say('msg-id', '');
    } catch (err) {
      say('msg-id', 'Could not open the camera. Allow camera access or upload an image instead.');
    }
  };
  $('btn-id-camera-close').onclick = () => {
    stopCam($('id-video'));
    $('id-camera-wrap').hidden = true;
  };
  $('btn-id-capture').onclick = () => {
    const canvas = snap($('id-video'));
    canvas.toBlob(blob => {
      if (!blob) return say('msg-id', 'Could not capture the ID image. Try again or upload an image.');
      capturedIdFile = new File([blob], 'captured-id.jpg', { type: 'image/jpeg' });
      $('id-file').value = '';
      showIdPreview(capturedIdFile);
      $('btn-scan').textContent = 'Scan ID';
      $('btn-id-retry').hidden = true;
      stopCam($('id-video'));
      $('id-camera-wrap').hidden = true;
      say('msg-id', '');
    }, 'image/jpeg', 0.94);
  };

  function fileToCanvas(file, maxW) {
    return new Promise((resolve, reject) => {
      const img = new Image(), url = URL.createObjectURL(file);
      img.onload = () => {
        const s = Math.min(1, maxW / img.width), c = document.createElement('canvas');
        c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url); resolve(c);
      };
      img.onerror = () => reject(new Error('The file could not be read as an image.'));
      img.src = url;
    });
  }
  function resizeCanvas(canvas, maxW) {
    if (canvas.width <= maxW) return canvas;
    const scale = maxW / canvas.width, c = document.createElement('canvas');
    c.width = Math.round(canvas.width * scale);
    c.height = Math.round(canvas.height * scale);
    c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
    return c;
  }
  function grayPixels(canvas, width) {                      // downscaled grayscale for the blur check
    const h = Math.round(canvas.height * width / canvas.width), c = document.createElement('canvas');
    c.width = width; c.height = h;
    const ctx = c.getContext('2d'); ctx.drawImage(canvas, 0, 0, width, h);
    const px = ctx.getImageData(0, 0, width, h).data, g = new Float32Array(width * h);
    for (let i = 0; i < g.length; i++) g[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
    return { data: g, w: width, h };
  }
  function forOcr(canvas, threshold = false, enhance = true) { // grayscale + contrast boost helps Tesseract
    const scale = canvas.width < 1200 ? 1.5 : 1;
    const c = document.createElement('canvas');
    c.width = Math.round(canvas.width * scale); c.height = Math.round(canvas.height * scale);
    const ctx = c.getContext('2d'); ctx.drawImage(canvas, 0, 0, c.width, c.height);
    if (!enhance) return c;
    const img = ctx.getImageData(0, 0, c.width, c.height), d = img.data;
    const histogram = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) {
      const boosted = Math.max(0, Math.min(255, (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] - 128) * 1.4 + 128));
      const g = Math.round(boosted);
      d[i] = d[i + 1] = d[i + 2] = g;
      histogram[g]++;
    }
    if (threshold) {
      const total = d.length / 4;
      let sum = 0;
      for (let i = 0; i < histogram.length; i++) sum += i * histogram[i];
      let backgroundWeight = 0, backgroundSum = 0, bestVariance = -1, cutoff = 155;
      for (let i = 0; i < histogram.length; i++) {
        backgroundWeight += histogram[i];
        if (!backgroundWeight) continue;
        const foregroundWeight = total - backgroundWeight;
        if (!foregroundWeight) break;
        backgroundSum += i * histogram[i];
        const meanBackground = backgroundSum / backgroundWeight;
        const meanForeground = (sum - backgroundSum) / foregroundWeight;
        const variance = backgroundWeight * foregroundWeight * (meanBackground - meanForeground) ** 2;
        if (variance > bestVariance) { bestVariance = variance; cutoff = i; }
      }
      for (let i = 0; i < d.length; i += 4) {
        const value = d[i] > cutoff ? 255 : 0;
        d[i] = d[i + 1] = d[i + 2] = value;
      }
    }
    ctx.putImageData(img, 0, 0); return c;
  }

  function requiredFieldCount(parsed) {
    return BL.CONFIG.REQUIRED.filter(key => parsed.fields[key]).length;
  }
  function idReadScore(result) {
    const fields = result.parsed.fields;
    const nameWords = (fields.full_name.match(/\s+/g) || []).length + (fields.full_name ? 1 : 0);
    return requiredFieldCount(result.parsed) * 100 + (nameWords >= 2 ? 2 : 0) +
      (fields.address ? 1 : 0) + result.confidence * 2;
  }
  function fieldReadScore(candidate, key) {
    const value = String(candidate.parsed.fields[key] || '').trim();
    if (!value) return -Infinity;
    const text = candidate.text || '';
    let score = candidate.confidence * 2;
    if (key === 'full_name') {
      const words = value.split(/\s+/).filter(Boolean);
      if (!/\p{L}/u.test(value)) return -Infinity;
      score += Math.min(words.length, 4) + (words.length > 1 ? 1 : 0);
      if (words.length > 7) score -= (words.length - 7) * 2;
      score -= Math.max(0, words.filter(word => /^\p{L}$/u.test(word)).length - 1) * 2;
      if (/\b(?:full\s*name|surname|family\s*name|last\s*name|given\s*names?|first\s*names?|name|apelyido|mga\s*pangalan|gitnang\s*apelyido)\b/i.test(text)) score += 3;
      if (/\b(?:republic|philippines|identification|passport|license|nationality|signature)\b/i.test(value)) score -= 8;
    } else if (key === 'dob' || key === 'expiry') {
      if (BL.calcAge(value) === null && key === 'dob') return -Infinity;
      score += 2;
      if (/\b(?:date\s*of\s*birth|birth\s*date|birthdate|dob|d\.o\.b|kapanganakan)\b/i.test(text)) score += 4;
    } else if (key === 'address') {
      if (value.length < 6 || !/[\p{L}\p{N}]/u.test(value)) return -Infinity;
      score += Math.min(value.split(/\s+/).length, 8) / 2;
      score -= Math.min((value.match(/[^\p{L}\p{N}\s,.'#/-]/gu) || []).length, 4);
      if (/\b(?:address|tirahan|residence)\b/i.test(text)) score += 4;
    } else {
      score += 5;
    }
    return score;
  }
  function agreedFieldCandidate(candidates, key) {
    const groups = new Map();
    for (const candidate of candidates) {
      const value = String(candidate.parsed.fields[key] || '').trim();
      const score = fieldReadScore(candidate, key);
      if (!value || !Number.isFinite(score)) continue;
      const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, '');
      const group = groups.get(normalized) || { count: 0, candidate: null, score: -Infinity };
      group.count++;
      if (score > group.score) { group.candidate = candidate; group.score = score; }
      groups.set(normalized, group);
    }
    const majority = Math.floor(candidates.length / 2) + 1;
    const ranked = [...groups.values()].sort((a, b) => b.count - a.count || b.score - a.score);
    const bestScore = candidates.reduce((score, candidate) =>
      Math.max(score, fieldReadScore(candidate, key)), -Infinity);
    const agreementMargin = key === 'address' ? 0.05 : 1.5;
    if (ranked.length && ranked[0].count >= majority &&
        bestScore - ranked[0].score <= agreementMargin) return ranked[0].candidate;

    const labelPatterns = {
      full_name: /\b(?:full\s*name|surname|family\s*name|last\s*name|given\s*names?|first\s*names?|middle\s*names?|apelyido|mga\s*pangalan|gitnang\s*apelyido)\b/i,
      dob: /\b(?:date\s*of\s*birth|birth\s*date|birthdate|dob|d\.o\.b|kapanganakan)\b/i,
      address: /\b(?:address|tirahan|residence)\b/i,
      expiry: /\b(?:date of expiry|valid until|expir)\b/i
    };
    const pattern = labelPatterns[key];
    const labeled = candidates
      .filter(candidate => Number.isFinite(fieldReadScore(candidate, key)) &&
        (!pattern || pattern.test(candidate.text || '')))
      .sort((a, b) => fieldReadScore(b, key) - fieldReadScore(a, key));
    if (labeled.length) return labeled[0];
    const plausible = candidates
      .filter(candidate => Number.isFinite(fieldReadScore(candidate, key)))
      .sort((a, b) => fieldReadScore(b, key) - fieldReadScore(a, key));
    return plausible.length ? plausible[0] : null;
  }
  const PADDLE_OCR_MODULE_URL = 'https://cdn.jsdelivr.net/npm/@paddleocr/paddleocr-js@0.4.2/+esm';
  const PADDLE_OCR_WASM_PATHS = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0/dist/';
  let paddleOcrPromise = null;

  function cropDobLabelArea(canvas, words) {
    const labelWords = (words || []).filter(word =>
      word.bbox && /birth|kapanganakan|dob|d\.o\.b/i.test(word.text || ''));
    if (!labelWords.length) return null;

    const labelLeft = Math.min(...labelWords.map(word => word.bbox.x0));
    const labelTop = Math.min(...labelWords.map(word => word.bbox.y0));
    const width = Math.min(canvas.width, Math.round(canvas.width * 0.5));
    const left = Math.max(0, Math.min(canvas.width - width, Math.floor(labelLeft - width * 0.2)));
    const top = Math.max(0, Math.floor(labelTop - canvas.height * 0.025));
    const height = Math.min(Math.round(canvas.height * 0.15), canvas.height - top);
    if (width < 1 || height < 1) return null;

    const crop = document.createElement('canvas');
    crop.width = width;
    crop.height = height;
    crop.getContext('2d').drawImage(canvas, left, top, width, height, 0, 0, width, height);
    return crop;
  }

  async function getPaddleOcr() {
    if (!paddleOcrPromise) {
      paddleOcrPromise = import(PADDLE_OCR_MODULE_URL)
        .then(({ PaddleOCR }) => {
          if (!PaddleOCR) throw new Error('PaddleOCR.js did not export PaddleOCR.');
          return PaddleOCR.create({
            textDetectionModelName: 'PP-OCRv5_mobile_det',
            textRecognitionModelName: 'PP-OCRv5_mobile_rec',
            ortOptions: {
              backend: 'wasm',
              wasmPaths: PADDLE_OCR_WASM_PATHS
            }
          });
        })
        .catch(error => {
          paddleOcrPromise = null;
          throw error;
        });
    }
    return paddleOcrPromise;
  }

  async function readPaddleDetails(canvas, type) {
    try {
      const ocr = await getPaddleOcr();
      const [result] = await ocr.predict(canvas);
      const text = (result && result.items ? result.items : [])
        .map(item => String(item.text || '').trim())
        .filter(Boolean)
        .join('\n');
      if (!text) throw new Error('PaddleOCR returned no text lines.');
      const fields = BL.parseIdText(text, type).fields;
      return { full_name: fields.full_name, address: fields.address };
    } catch (error) {
      console.warn('PaddleOCR detail scan failed; keeping Tesseract results.', error);
      return null;
    }
  }
  async function readId(canvas, type, detailCanvas = canvas) {
    const passes = [
      { threshold: false, pageSegMode: 6 },
      { threshold: true, pageSegMode: 11 },
      { threshold: false, pageSegMode: 4 }
    ];
    const candidates = [];
    const detailCandidates = [];
    const texts = [];
    for (const pass of passes) {
      const result = await Tesseract.recognize(forOcr(canvas, pass.threshold), 'eng', {
        tessedit_pageseg_mode: pass.pageSegMode,
        preserve_interword_spaces: '1'
      });
      texts.push(result.data.text);
      const candidate = { parsed: BL.parseIdText(result.data.text, type), confidence: result.data.confidence / 100, text: result.data.text };
      candidates.push(candidate);
    }
    for (const pass of [
      { enhance: false, pageSegMode: 6 },
      { enhance: true, pageSegMode: 11 }
    ]) {
      const processedCanvas = forOcr(detailCanvas, false, pass.enhance);
      const result = await Tesseract.recognize(processedCanvas, 'eng', {
        tessedit_pageseg_mode: pass.pageSegMode,
        preserve_interword_spaces: '1'
      });
      detailCandidates.push({
        parsed: BL.parseIdText(result.data.text, type),
        confidence: result.data.confidence / 100,
        text: result.data.text
      });
      if (pass.enhance === false) {
        const dobArea = cropDobLabelArea(processedCanvas, result.data.words);
        if (dobArea) {
          const preparedDobArea = forOcr(dobArea, false, false);
          const dobResult = await Tesseract.recognize(preparedDobArea, 'eng', {
            tessedit_pageseg_mode: 6,
            preserve_interword_spaces: '1'
          });
          detailCandidates.push({
            parsed: BL.parseIdText(dobResult.data.text, type),
            confidence: dobResult.data.confidence / 100,
            text: dobResult.data.text
          });
        }
      }
    }
    const best = candidates.reduce((current, candidate) =>
      idReadScore(candidate) > idReadScore(current) ? candidate : current);
    const fields = { ...best.parsed.fields };
    for (const key of ['full_name', 'dob', 'address', 'id_number', 'expiry']) {
      const fieldCandidates = key === 'full_name' || key === 'address' || key === 'dob'
        ? candidates.concat(detailCandidates)
        : candidates;
      const fieldCandidate = key === 'id_number'
        ? candidates.reduce((current, candidate) =>
          fieldReadScore(candidate, key) > fieldReadScore(current, key) ? candidate : current)
        : agreedFieldCandidate(fieldCandidates, key);
      if (fieldCandidate && Number.isFinite(fieldReadScore(fieldCandidate, key))) {
        fields[key] = fieldCandidate.parsed.fields[key];
      } else if (key !== 'id_number') fields[key] = '';
    }
    return { ...best, parsed: { ...best.parsed, fields }, texts };
  }

  // Counts a failed attempt on the server (5 failures = 15-minute lock) and shows the message
  async function failStep(kind, msgId, btnId, text) {
    let extra = '';
    try {
      const r = await Api.reportFailure(kind);
      if (r.locked) {
        extra = ' Too many failed attempts. Try again in 15 minutes.';
        $(btnId).disabled = true;
        me.locked_until = new Date(Date.now() + 15 * 60000).toISOString();
        scheduleLockRefresh();
      }
    } catch (e) { /* keep the original message */ }
    if (kind === 'id') showIdRetry();
    say(msgId, text + extra);
  }

  $('btn-scan').onclick = async () => {
    const file = selectedIdFile(), type = $('id-type').value, btn = $('btn-scan'), status = $('id-status');
    const setStatus = t => { status.textContent = t; status.hidden = !t; };
    let scanSucceeded = false;
    say('msg-id', '');
    if (!type) return say('msg-id', 'Choose the type of ID you are uploading.');
    if (!file || !/^image\/(jpeg|png)$/.test(file.type) || file.size > 5 * 1024 * 1024) {
      showIdRetry();
      return say('msg-id', 'Capture or choose a JPG or PNG image up to 5 MB.');
    }
    $('btn-id-retry').hidden = true;
    btn.textContent = 'Scanning ID...';
    btn.disabled = true;
    try {
      const detailCanvas = await fileToCanvas(file, 2200);
      const canvas = resizeCanvas(detailCanvas, 1600);

      setStatus('Checking the photo...');
      const g = grayPixels(canvas, 800);
      if (BL.laplacianVariance(g.data, g.w, g.h) < CFG.MIN_SHARPNESS)
        return await failStep('id', 'msg-id', 'btn-scan', 'The photo is too blurry. Retake it in good light and hold the camera steady.');

      setStatus('Reading the text on the ID (this can take a few seconds)...');
      const result = await readId(canvas, type, detailCanvas);
      const typeCheck = BL.checkIdType(result.texts, type);
      if (!typeCheck.ok) {
        showIdRetry();
        return say('msg-id', typeCheck.message);
      }
      const paddleDetails = await readPaddleDetails(detailCanvas, type);
      const fields = { ...result.parsed.fields };
      if (paddleDetails && paddleDetails.full_name) fields.full_name = paddleDetails.full_name;
      if (paddleDetails && paddleDetails.address) fields.address = paddleDetails.address;
      const parsed = { ...result.parsed, fields }, conf = result.confidence;
      const check = BL.checkOcr(parsed, conf);
      if (!check.ok) return await failStep('id', 'msg-id', 'btn-scan', check.message);

      await ensureModels(setStatus);
      setStatus('Finding the face photo on the ID...');
      const faces = await faceapi.detectAllFaces(canvas, detectorOptions()).withFaceLandmarks().withFaceDescriptors();
      if (!faces.length)
        return await failStep('id', 'msg-id', 'btn-scan', 'No face photo was found on the ID. Make sure the whole front of the ID is visible.');
      const idFace = faces.reduce((a, b) => (b.detection.box.area > a.detection.box.area ? b : a));

      setStatus('Saving...');
      const r = await Api.saveId(type, parsed.fields, +conf.toFixed(3), Array.from(idFace.descriptor, x => +x.toFixed(5)));
      if (!r.ok) return await failStep('id', 'msg-id', 'btn-scan', r.message);
      scanSucceeded = true;
      await refreshMe(); goStep(me.verify_step);
    } catch (err) {
      showIdRetry();
      say('msg-id', err.message);
    } finally {
      setStatus('');
      btn.textContent = scanSucceeded ? 'Scan ID' : 'Retry ID scan';
      if (!lockText(me && me.locked_until)) btn.disabled = false;
    }
  };

  /* ------------------------------------------------------------ step 2: face registration + match */
  function updateFaceProgress(completed) {
    const count = completed ? 1 : 0;
    $('face-progress').setAttribute('aria-valuemax', '1');
    $('face-progress').setAttribute('aria-valuenow', String(count));
    $('face-progress').setAttribute('aria-valuetext', completed ? 'Instruction completed' : 'Waiting for the current instruction');
    const fill = $('face-progress-fill'), length = fill.getTotalLength();
    fill.style.strokeDasharray = length * count + ' ' + length;
    fill.style.strokeDashoffset = '0';
    fill.style.opacity = count ? '1' : '0';
  }
  function enterFace() {
    show('face');
    updateFaceProgress(0);
    const lock = lockText(me.locked_until);
    say('msg-face', lock, 'warn'); $('btn-face-start').disabled = !!lock;
    if (lock) scheduleLockRefresh(); else clearLockRefreshTimer();
    $('btn-face-start').hidden = false; $('btn-face-next').hidden = true;
  }
  $('btn-face-next').onclick = async () => { await refreshMe(); goStep(me.verify_step); };

  $('btn-face-start').onclick = async () => {
    const btn = $('btn-face-start'), video = $('face-video'), sayEl = $('face-say');
    captureCancelled = false; btn.disabled = true; say('msg-face', ''); updateFaceProgress(0);
    try {
      await ensureModels(t => { sayEl.textContent = t; });
      if (captureCancelled) return;
      try { await startCam(video); }
      catch (e) { say('msg-face', 'Camera access is blocked. Allow the camera and try again.'); return; }
      if (captureCancelled) { stopCam(video); return; }

      const shots = [];
      for (const p of CFG.POSES) {
        updateFaceProgress(0);
        const captured = await capturePose(video, p, shots.length ? shots[0].info : null, sayEl);
        if (captureCancelled) return;
        if (!captured) return;
        shots.push(captured);
        updateFaceProgress(1);
        await sleep(400);
        if (captureCancelled) return;
      }
      stopCam(video); sayEl.textContent = 'Checking your captures...';

      const infos = {};
      for (const s of shots) infos[s.pose] = s.info;
      const chk = BL.checkPoses(infos);                       // did the person follow each instruction?
      if (!chk.ok) {
        sayEl.textContent = 'Capture not accepted.';
        return await failStep('face', 'msg-face', 'btn-face-start',
          'These captures did not follow the instruction: ' + chk.failed.join(', ') + '. Face the camera in good light and repeat.');
      }

      if (captureCancelled) return;
      const r = await Api.saveFace(chk.passed.map(p => ({ pose: p, descriptor: infos[p].descriptor })));   // server decides the match
      if (captureCancelled) return;
      if (!r.ok) { sayEl.textContent = 'Face not matched.'; return await failStep('face', 'msg-face', 'btn-face-start', r.message); }
      sayEl.textContent = 'Face matches the ID.';
      say('msg-face', 'Face registered and matched with the ID photo.', 'good');
      btn.hidden = true; $('btn-face-next').hidden = false;
    } catch (err) {
      say('msg-face', err.message);
    } finally {
      stopCam(video);
      updateFaceProgress(0);
      if (!btn.hidden) { btn.textContent = 'Retry face capture'; btn.disabled = !!lockText(me && me.locked_until); }
    }
  };

  /* ------------------------------------------------------------ step 3: personal information */
  async function enterInfo() {
    show('info'); say('msg-info', '');
    try {
      const r = await Api.getRecord();
      if (!r.ok) { await refreshMe(); return goStep(Math.min(me.verify_step, 1)); }   // cannot skip ahead
      $('in-name').value = r.full_name || ''; $('in-dob').value = r.dob || ''; $('in-address').value = r.address || '';
      $('in-number').value = r.id_number || ''; $('in-expiry').value = r.expiry || '';
      updateAge();
    } catch (err) { say('msg-info', err.message); }
  }
  function updateAge() { const a = BL.calcAge($('in-dob').value); $('in-age').value = a === null ? '' : a; }
  $('in-dob').oninput = updateAge;

  $('info-form').onsubmit = async e => {
    e.preventDefault();
    const fields = { full_name: $('in-name').value, dob: $('in-dob').value, address: $('in-address').value,
                     id_number: $('in-number').value, expiry: $('in-expiry').value };
    const problem = BL.validateInfo(fields);
    if (problem) return say('msg-info', problem);
    try {
      const r = await Api.saveInfo(fields);
      if (!r.ok) return say('msg-info', r.message);
      registrationInProgress = false;
      await refreshMe(); showResult();
    } catch (err) { say('msg-info', err.message); }
  };

  /* ------------------------------------------------------------ step 4: result */
  function showResult() {
    show('result');
    const t = {
      pending:  ['Verification successful', 'Your ID was scanned and your face matched the ID photo. Your account now waits for admin approval.', 'good'],
      rejected: ['Registration rejected', 'An admin rejected this registration. Contact the restaurant admin.', 'bad'],
      active:   ['Account active', 'Your account is approved. You can log in with your face.', 'good']
    }[me.status] || ['Verification', '', 'warn'];
    $('result-title').textContent = t[0]; say('result-msg', t[1], t[2]);
    const rows = [['Name', me.full_name], ['ID type', CFG.ID_TYPES[me.id_type] || me.id_type], ['ID number', me.id_number],
                  ['Face match distance', me.face_distance != null ? me.face_distance.toFixed(2) + ' (lower is closer)' : ''],
                  ['Status', me.status]];
    const dl = $('result-details'); dl.replaceChildren();
    rows.forEach(([k, v]) => { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = k; dd.textContent = v || '-'; dl.append(dt, dd); });
  }

  /* ------------------------------------------------------------ face login + PIN login */
  $('btn-login-start').onclick = async () => {
    const btn = $('btn-login-start'), video = $('login-video'), sayEl = $('login-say');
    captureCancelled = false; btn.disabled = true; say('msg-login', '');
    try {
      await ensureModels(t => { sayEl.textContent = t; });
      if (captureCancelled) return;
      try { await startCam(video); }
      catch (e) { say('msg-login', 'Camera access is blocked. Allow camera access, or choose the PIN option below.'); return; }
      if (captureCancelled) { stopCam(video); return; }

      const shots = [];
      for (const pose of CFG.POSES) {
        const shot = await capturePose(video, pose, shots.length ? shots[0].info : null, sayEl);
        if (captureCancelled) return;
        if (!shot) return;
        shots.push(shot);
      }
      stopCam(video); sayEl.textContent = 'Checking your face against the registered ID...';
      if (captureCancelled) return;
      const baseline = shots[0].info;
      if (shots.some(shot => faceapi.euclideanDistance(baseline.descriptor, shot.info.descriptor) > CFG.SAME_PERSON_DIST)) {
        return say('msg-login', 'The captures do not look like the same person. Try again.');
      }
      const r = await Api.faceLogin(baseline.descriptor);
      if (captureCancelled) return;
      if (!r.ok) return say('msg-login', r.message);
      Api.setToken(r.token); await route();
    } catch (err) {
      say('msg-login', err.message);
    } finally {
      stopCam(video); sayEl.textContent = 'Press Start scan when you are ready.'; btn.textContent = 'Try again'; btn.disabled = false;
    }
  };
  $('show-pin').onclick = () => {
    cancelActiveCapture();
    $('face-login').hidden = true;
    $('pin-form').hidden = false;
    $('pin-form').scrollIntoView();
    $('pin-email').focus();
  };
  $('hide-pin').onclick = () => {
    $('pin-form').reset();
    say('msg-pin', '');
    $('pin-form').hidden = true;
    $('face-login').hidden = false;
    say('msg-login', '');
  };
  $('pin-form').onsubmit = async e => {
    e.preventDefault(); say('msg-pin', '');
    try {
      const r = await Api.pinLogin($('pin-email').value, $('pin-code').value);
      if (!r.ok) return say('msg-pin', r.message);
      Api.setToken(r.token); $('pin-form').reset(); await route();
    } catch (err) { say('msg-pin', err.message); }
  };

  /* ------------------------------------------------------------ dashboard + admin approvals */
  function showDashboard() {
    show('dashboard');
    $('dash-name').textContent = me.full_name || me.email;
    $('dash-role').textContent = roleLabel(me.role);
    $('btn-approvals').hidden = me.role !== 'admin';
    // Add your role-based modules here (kitchen -> recipes, inventory -> stock, receptionist -> reservations)
  }
  $('btn-approvals').onclick = loadApprovals;
  $('approvals-back').onclick = showDashboard;

  async function loadApprovals() {
    show('approvals'); say('msg-approvals', '');
    const list = $('approval-list'); list.replaceChildren();
    try {
      const r = await Api.listPending();
      if (!r.ok) return say('msg-approvals', r.message);
      if (!r.items.length) return say('msg-approvals', 'No accounts are waiting for approval.', 'warn');
      r.items.forEach(p => list.append(approvalCard(p)));
    } catch (err) { say('msg-approvals', err.message); }
  }
  function approvalCard(p) {
    const box = document.createElement('section'); box.className = 'req';
    const dl = document.createElement('dl');
    [['Name', p.full_name], ['Email', p.email], ['Date of birth', p.dob],
     ['Age', BL.calcAge(p.dob)], ['Address', p.address || 'Not on ID']]
      .forEach(([k, v]) => { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = k; dd.textContent = v; dl.append(dt, dd); });

    const approveRow = document.createElement('div'); approveRow.className = 'row';
    const sel = document.createElement('select'); sel.add(new Option('Choose a role', ''));
    roles.forEach(r => sel.add(new Option(r.label, r.key)));
    const lblSel = document.createElement('div'), l1 = document.createElement('label'); l1.textContent = 'Assign role'; lblSel.append(l1, sel);
    const ok = document.createElement('button'); ok.className = 'btn'; ok.type = 'button'; ok.textContent = 'Approve';
    approveRow.append(lblSel, ok);

    const rejectRow = document.createElement('div'); rejectRow.className = 'row';
    const reason = document.createElement('input'); reason.maxLength = 250;
    const lblRea = document.createElement('div'), l2 = document.createElement('label'); l2.textContent = 'Reason for rejecting'; lblRea.append(l2, reason);
    const no = document.createElement('button'); no.className = 'btn alt'; no.type = 'button'; no.textContent = 'Reject';
    rejectRow.append(lblRea, no);

    const decide = async (action) => {
      if (action === 'approve' && !sel.value) return say('msg-approvals', 'Choose a role to assign before approving.');
      ok.disabled = no.disabled = true;
      try {
        const r = await Api.decide(p.id, action, sel.value, reason.value);
        if (!r.ok) { say('msg-approvals', r.message); ok.disabled = no.disabled = false; return; }
        box.remove(); say('msg-approvals', action === 'approve' ? 'Account approved.' : 'Account rejected.', 'good');
      } catch (err) { say('msg-approvals', err.message); ok.disabled = no.disabled = false; }
    };
    ok.onclick = () => decide('approve'); no.onclick = () => decide('reject');
    box.append(dl, approveRow, rejectRow); return box;
  }

  /* ------------------------------------------------------------ navigation + start */
  function resetRegistrationUi() {
    cancelActiveCapture(); stopCam($('id-video'));
    clearLockRefreshTimer();
    capturedIdFile = null;
    registrationInProgress = false;
    $('id-file').value = '';
    $('id-camera-wrap').hidden = true;
    showIdPreview(null);
    $('id-type').selectedIndex = 0;
    $('btn-scan').textContent = 'Scan ID'; $('btn-id-retry').hidden = true;
    $('id-status').textContent = ''; $('id-status').hidden = true;
    $('signup-form').reset(); $('info-form').reset(); $('pin-form').reset();
    $('pin-form').hidden = true; $('face-login').hidden = false;
    ['msg-signup', 'msg-id', 'msg-face', 'msg-info', 'msg-pin', 'msg-login'].forEach(id => say(id, ''));
    $('btn-scan').disabled = false; $('btn-face-start').disabled = false;
    $('btn-face-start').hidden = false; $('btn-face-next').hidden = true;
  }
  async function cancelRegistration() {
    if (!Api.token()) { me = null; resetRegistrationUi(); show('home'); return; }
    if (!window.confirm('Leave registration? Your unsubmitted information will be deleted.')) return;
    cancelActiveCapture();
    try {
      const r = await Api.cancelSignup();
      if (!r.ok) return window.alert(r.message);
      Api.setToken(null); me = null; registrationInProgress = false; resetRegistrationUi(); show('home');
    } catch (err) {
      window.alert('Could not clear the unfinished registration: ' + err.message);
    }
  }
  document.querySelectorAll('[data-cancel-signup]').forEach(button => {
    button.onclick = cancelRegistration;
  });
  window.addEventListener('pagehide', () => {
    cancelActiveCapture();
    if (!registrationInProgress) return;
    const token = Api.token();
    if (!token) return;
    fetch(SUPABASE_URL + '/rest/v1/rpc/iv_cancel_signup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: 'Bearer ' + SUPABASE_ANON_KEY
      },
      body: JSON.stringify({ p_token: token }),
      keepalive: true
    }).catch(error => console.error('Could not clear unfinished signup on page exit.', error));
    Api.setToken(null);
  });
  $('go-login').onclick = () => {
    $('pin-form').hidden = true;
    $('face-login').hidden = false;
    say('msg-login', ''); say('msg-pin', '');
    show('login');
  };
  $('go-signup').onclick = () => {
    resetRegistrationUi();
    say('msg-signup', '');
    show('signup');
  };
  document.querySelectorAll('[data-go]').forEach(b => { b.onclick = () => { cancelActiveCapture(); me = Api.token() ? me : null; show(b.dataset.go); }; });
  $('result-back').onclick = async () => { await Api.logout(); me = null; show('home'); };
  $('btn-logout').onclick = async () => {
    await Api.logout(); me = null; show('home');
  };

  (async function init() {
    Object.entries(CFG.ID_TYPES).forEach(([k, v]) => $('id-type').add(new Option(v, k)));
    $('id-supported').textContent = Object.values(CFG.ID_TYPES).join(', ');
    try { roles = await Api.roles(); } catch (e) { say('msg-signup', 'Could not load roles from Supabase.'); }
    try { await route(); } catch (e) { show('home'); }
  })();
})();