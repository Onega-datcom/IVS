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
    philid:   /\b\d{4}(?:[\s-]{0,3}\d{4}){3}\b/,
    drivers:  /\b[A-Z]\s?\d{2}[\s-]{0,3}\d{2}[\s-]{0,3}\d{6}\b/,
    umid:     /\b\d{4}[\s-]{0,3}\d{7}[\s-]{0,3}\d\b/,
    passport: /\b[A-Z]\s?\d{7}\s?[A-Z]\b/
  };
  const ID_TYPE_MARKERS = {
    philid: /\b(?:PHILSYS|PHIL\s*ID|PHILIPPINE\s+(?:NATIONAL\s+)?IDENTIFICATION(?:\s+SYSTEM)?|NATIONAL\s+ID|PSN|PCN|CRN)\b/i,
    drivers: /\b(?:DRIVER'?S?\s+LICEN[CS]E|DRIVING\s+LICEN[CS]E|LAND\s+TRANSPORTATION\s+OFFICE|LTO|DLN)\b/i,
    passport: /\bPASSPORT\b/i,
    umid: /\b(?:UMID|UNIFIED\s+MULTI[- ]PURPOSE(?:\s+ID)?|SSS)\b/i
  };
  const LAST_NAME_LABEL = /\b(?:last(?:\s*name)?|family(?:\s*name)?|surname|apelyido)\b/i;
  const looksLikeIdNumber = line => Object.values(ID_PATTERNS).some(pattern => pattern.test(line.toUpperCase()));
  const FIELD_LABELS = [
    'date of birth', 'birth date', 'birthdate', 'date birth', 'd.o.b', 'dob', 'date of expiry', 'valid until',
    'residential address', 'current address', 'permanent address', 'place of residence', 'residence',
    'given names', 'given name',
    'first names', 'first name', 'last name', 'last', 'family name', 'family', 'middle names', 'middle name', 'middle initial',
    'middlename', 'gitnang apelyido', 'mga pangalan', 'full name',
    'postal code', 'surname', 'nationality', 'signature', 'address', 'tirahan', 'kapanganakan',
    'apelyido', 'pangalan', 'id number', 'id no', 'crn', 'birth', 'expiry', 'expiration',
    'license', 'sex', 'name', 'date', 'blood', 'agency', 'national id', 'national identification',
    'philsys', 'passport', 'driver license', "driver's license", 'umid', 'unified multi-purpose id'
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
    if (/\b(?:given\s*names?|first\s*names?|last(?:\s*name)?|family(?:\s*name)?|surname|full\s*name|apelyido|mga\s*pangalan|gitnang\s*apelyido)\b/i.test(value)) return '';
    value = value.replace(/^[\s\-–—•|]+/u, '')
      .replace(/^(?:yy|yv)\s+(?=\p{L})/iu, '')
      .replace(/\b(?:midd\s+e(?:\s+[il1])?|middlename|middle\s*(?:names?|initials?)?|middl(?:e)?)\b/gi, ' ')
      .replace(/(\p{L}{2,})\.\s+(?=\p{L})/gu, '$1 ')
      .replace(/[^\p{L}' -]/gu, ' ').replace(/\s+/g, ' ').trim();
    const words = [];
    for (const word of value.split(' ').filter(Boolean)) {
      const current = word.toLowerCase().replace(/[^\p{L}]/gu, '');
      const previous = words.length ? words[words.length - 1].toLowerCase().replace(/[^\p{L}]/gu, '') : '';
      if (current.length > 1 && current === previous) continue;
      words.push(word);
    }
    let shortened = true;
    while (shortened) {
      shortened = false;
      for (let size = Math.floor(words.length / 2); size > 0; size--) {
        const first = words.slice(-size * 2, -size).map(word => word.toLowerCase());
        const second = words.slice(-size).map(word => word.toLowerCase());
        if (first.every((word, index) => word === second[index])) {
          words.splice(-size);
          shortened = true;
          break;
        }
      }
    }
    if (words.length >= 3 && /^\p{L}$/u.test(words[0])) words.shift();
    return titleCase(words.join(' '));
  }

  function composeName(given, middle, last) {
    const givenAndMiddle = cleanName([given, middle].filter(Boolean).join(' '));
    const givenWords = givenAndMiddle.toLowerCase().split(/\s+/).filter(Boolean);
    const lastWords = cleanName(last).toLowerCase().split(/\s+/).filter(Boolean);
    if (!lastWords.length) return givenAndMiddle;
    for (let start = 0; start <= givenWords.length - lastWords.length; start++) {
      if (lastWords.every((word, index) => givenWords[start + index] === word)) return givenAndMiddle;
    }
    let overlap = Math.min(givenWords.length, lastWords.length);
    while (overlap > 0 && !givenWords.slice(-overlap).every((word, index) => word === lastWords[index])) overlap--;
    return cleanName([givenAndMiddle, lastWords.slice(overlap).join(' ')].filter(Boolean).join(' '));
  }

  function trimFollowingFields(value) {
    const stop = /\b(?:date of birth|date of expiry|valid until|postal code|id number|id no|crn|birth|address|tirahan|kapanganakan|nationality|signature|expiry|expiration|license|sex)\b/i;
    const match = stop.exec(value);
    return trimJunk(match ? value.slice(0, match.index) : value);
  }

  function trimAtFieldLabel(value, currentLabels, preserveMiddleLabel = false) {
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
    const ignoredLabels = preserveMiddleLabel
      ? new Set(['middle names', 'middle name', 'middle initial', 'middlename', 'gitnang apelyido', 'name'])
      : null;
    const alternatives = FIELD_LABELS.filter(label => !ignoredLabels || !ignoredLabels.has(label))
      .sort((a, b) => b.length - a.length)
      .map(label => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*'));
    const match = new RegExp('\\b(?:' + alternatives.join('|') + ')\\b', 'i').exec(remaining);
    return trimFollowingFields(match ? remaining.slice(0, match.index) : remaining);
  }

  function valueAfter(lines, labels, take = 1, preserveMiddleLabel = false) {
    const ordered = labels.slice().sort((a, b) => b.length - a.length);
    for (let i = 0; i < lines.length; i++) {
      for (const lab of ordered) {
        const label = fieldLabelRegex(lab).exec(lines[i]);
        if (!label) continue;
        if (lab === 'name' && /\b(?:first|last|middle|given|family)\s*$/i.test(lines[i].slice(0, label.index))) continue;
        const rest = trimAtFieldLabel(lines[i].slice(label.index + label[0].length), labels, preserveMiddleLabel);
        const labelCheckedRest = preserveMiddleLabel
          ? rest.replace(/\b(?:middle\s*(?:names?|initials?)?|middlename|middl(?:e)?)\b/gi, ' ')
          : rest;
        if (labelCheckedRest.length >= 2 && !looksLikeLabel(labelCheckedRest)) {
          const valueLines = [rest];
          for (const line of lines.slice(i + 1)) {
            if (valueLines.length >= take || looksLikeLabel(line) || looksLikeIdNumber(line) || findDates(line).length) break;
            valueLines.push(line);
          }
          return valueLines.join(' ');
        }

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

  function nameFromHeaderRow(header, values) {
    const columns = [
      { key: 'last', pattern: LAST_NAME_LABEL },
      { key: 'given', pattern: /\b(?:first\s*names?|given\s*names?|mga\s*pangalan)\b/i }
    ].map(column => {
      const match = column.pattern.exec(header);
      return match ? { key: column.key, start: match.index } : null;
    }).filter(Boolean).sort((a, b) => a.start - b.start);
    if (columns.length < 2) return '';

    const words = trimFollowingFields(values).split(/\s+/).filter(Boolean);
    if (words.length < 2) return '';
    return columns[0].key === 'last'
      ? composeName(words.slice(1).join(' '), '', words[0])
      : composeName(words.slice(0, -1).join(' '), '', words[words.length - 1]);
  }

  function nameFromColumns(header, values) {
    const fields = [
      { key: 'last', pattern: LAST_NAME_LABEL },
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
    return composeName(extracted.given, extracted.middle, extracted.last);
  }

  function parseName(lines) {
    const isNameHeaderLabel = line =>
      /^\s*(?:last(?:\s*name)?|family(?:\s*name)?|surname|apelyido|first\s*names?|given\s*names?|mga\s*pangalan|middle\s*(?:names?|initials?)?|middlename|gitnang\s*apelyido)\s*[:/-]?\s*$/i.test(line);
    for (let i = 0; i < lines.length; i++) {
      if (!isNameHeaderLabel(lines[i])) continue;
      let end = i;
      while (end + 1 < lines.length && end - i < 2 && isNameHeaderLabel(lines[end + 1])) end++;
      const header = lines.slice(i, end + 1).join(' ');
      const hasLast = LAST_NAME_LABEL.test(header);
      const hasGiven = /\b(?:first\s*names?|given\s*names?|mga\s*pangalan)\b/i.test(header);
      if (!hasLast || !hasGiven) continue;

      const values = [];
      for (const line of lines.slice(end + 1)) {
        if (looksLikeLabel(line) || looksLikeIdNumber(line) || findDates(line).length || /\d/.test(line)) break;
        values.push(line);
        if (values.length === 3) break;
      }
      if (!values.length) continue;
      const row = values.join(' ');
      const columns = nameFromColumns(header, values.join('  '));
      if (columns) return columns;
      const commaName = row.includes(',') ? nameFromCommaLine(row, header) : '';
      if (commaName) return commaName;
      const headerRow = nameFromHeaderRow(header, row);
      if (headerRow) return headerRow;
    }

    for (let i = 0; i < lines.length; i++) {
      const low = lines[i].toLowerCase();
      const hasLast = LAST_NAME_LABEL.test(low);
      const hasGiven = /\b(?:first\s*names?|given\s*names?|mga\s*pangalan)\b/.test(low);
      if (hasLast && hasGiven) {
        if (lines[i].includes(':')) {
          const lastInline = valueAfter([lines[i]], ['last name', 'family name', 'surname', 'apelyido', 'last', 'family'], 2);
          const givenInline = valueAfter([lines[i]], ['first names', 'first name', 'given names', 'given name', 'mga pangalan'], 2);
          const middleInline = valueAfter([lines[i]], ['middle names', 'middle name', 'middle initial', 'middlename', 'gitnang apelyido'], 2);
          if (lastInline && givenInline) {
            return composeName(givenInline, middleInline, lastInline);
          }
        }
        if (i + 1 < lines.length) {
          const raw = trimFollowingFields(lines[i + 1]);
          if (raw && raw.includes(',')) return nameFromCommaLine(raw, low);
          const commaAsDot = raw && raw.match(/^\s*(\p{L}{2,})\.\s+(.+)$/u);
          if (commaAsDot) return nameFromCommaLine(commaAsDot[1] + ', ' + commaAsDot[2], low);
          const columns = nameFromColumns(lines[i], lines[i + 1]);
          if (columns) return columns;
          const headerRow = raw && nameFromHeaderRow(lines[i], raw);
          if (headerRow) return headerRow;
        }
      }
    }
    const last = valueAfter(lines, ['last name', 'family name', 'surname', 'apelyido', 'last', 'family'], 2);
    const given = valueAfter(lines, ['given names', 'given name', 'mga pangalan', 'first names', 'first name'], 2);
    const middle = valueAfter(lines, ['middle names', 'middle name', 'middle initial', 'middlename', 'gitnang apelyido'], 2);
    if (last && given) return composeName(given, middle, last);
    const full = valueAfter(lines, ['full name', 'pangalan', 'name'], 3, true);
    if (full) {
      if (full.includes(',')) return nameFromCommaLine(full, '');
      const commaAsDot = full.match(/^\s*(\p{L}{2,})\.\s+(.+)$/u);
      return commaAsDot ? nameFromCommaLine(commaAsDot[1] + ', ' + commaAsDot[2], '') : cleanName(full);
    }

    const headerWords = /\b(?:republic|philippines|government|identification|national|pambansang|pagkakakilanlan|passport|license|driver|transportation|signature|address|nationality|birth|expiry|valid|until|sex|male|female|blood|agency)\b/i;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const nameLine = line.replace(/\b(?:middle\s*(?:names?|initials?)?|middlename|middl(?:e)?)\b/gi, ' ');
      if (looksLikeLabel(nameLine) || looksLikeIdNumber(line) || findDates(line).length ||
          /\d/.test(line) || headerWords.test(line)) continue;
      const commaName = nameLine.includes(',') ? nameFromCommaLine(nameLine, '') : '';
      if (commaName) return commaName;
      const commaAsDot = nameLine.match(/^\s*(\p{L}{2,})\.\s+(.+)$/u);
      if (commaAsDot) return nameFromCommaLine(commaAsDot[1] + ', ' + commaAsDot[2], '');
      let candidate = cleanName(nameLine);
      let wordCount = candidate.split(/\s+/).filter(Boolean).length;
      if (wordCount >= 2 && wordCount <= 3) {
        let nextIndex = i + 1, continuationCount = 0;
        while (nextIndex < lines.length && continuationCount < 2) {
          const nextLine = lines[nextIndex];
          if (looksLikeLabel(nextLine) || looksLikeIdNumber(nextLine) || findDates(nextLine).length ||
              /\d/.test(nextLine) || headerWords.test(nextLine)) break;
          const continuation = cleanName(nextLine);
          const continuationWords = continuation.split(/\s+/).filter(Boolean).length;
          if (continuationWords < 1 || continuationWords > 3 || wordCount + continuationWords > 7) break;
          candidate = cleanName(candidate + ' ' + continuation);
          wordCount = candidate.split(/\s+/).filter(Boolean).length;
          continuationCount++;
          nextIndex++;
        }
      }
      if (wordCount >= 2 && wordCount <= 7) return candidate;
    }
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
        id_number: m ? m[0].replace(/\s+/g, '') : '',
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
        message: 'You chose ' + CONFIG.ID_TYPES[selectedType] + ', but this photo looks like a ' +
          CONFIG.ID_TYPES[detected] + '. Choose the correct type and scan again.'
      };
    }
    return { ok: true, detected };
  }

  // Readability check: required fields present and OCR confident enough
  function checkOcr(parsed, confidence) {
    const labels = { full_name: 'full name', dob: 'date of birth', id_number: 'ID number', address: 'address' };
    const missing = CONFIG.REQUIRED.filter(k => !parsed.fields[k]);
    if (missing.length || confidence < CONFIG.MIN_OCR_CONF) {
      const why = missing.length ? 'We could not clearly read your ' + missing.map(k => labels[k] || k).join(', ') + '.' : 'The ID text is too blurry to read.';
      return { ok: false, message: why + ' Retake the photo with the whole ID flat, in good light, and all text in focus.' };
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
    const reference = Number.isFinite(state.reference) && state.reference > 0
      ? state.reference
      : Number.isFinite(baseline) && baseline > 0 ? baseline : CONFIG.EYE_OPEN_MIN;
    if (!state.opened) {
      if (eyeRatio >= CONFIG.EYE_OPEN_MIN * 0.65) {
        state.opened = true;
        state.reference = eyeRatio;
      }
      return false;
    }
    if (eyeRatio >= reference * CONFIG.EYE_BLINK_REOPEN_RATIO) {
      const blinked = state.closed;
      state.opened = true;
      state.closed = false;
      state.reference = Math.max(reference, eyeRatio);
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
  const SCREENS = ['home', 'login', 'signup', 'signup-credentials', 'id', 'face', 'info', 'result', 'dashboard', 'approvals'];
  const STEP_OF = { id: 1, face: 3, info: 5, result: 6 };
  let me = null, roles = [], sharedModelsReady = false, idDetectorReady = false, liveDetectorReady = false;
  let registrationInProgress = false, captureCancelled = false, lockRefreshTimer = null;
  let idPreviewUrl = null;

  /* ------------------------------------------------------------ helpers */
  function show(name) {
    if (name !== 'face' && name !== 'login') cancelActiveCapture();
    SCREENS.forEach(s => { $('screen-' + s).hidden = s !== name; });
    const step = STEP_OF[name];
    updateStepper(step);
    const registering = me && me.status === 'unverified';
    $('btn-logout').hidden = !Api.token() || registering;
    $('btn-logout').textContent = 'Log out';
    $('who').hidden = !me || registering; if (me && !registering) $('who').textContent = me.email;
    window.scrollTo(0, 0);
  }
  function updateStepper(step) {
    $('stepper').hidden = !step;
    if (step) [...$('stepper').children].forEach((li, i) => {
      li.className = i + 1 < step ? 'done' : i + 1 === step ? 'now' : '';
    });
  }
  function friendlyMessage(text) {
    const message = String(text || '');
    if (/failed to fetch|networkerror|load failed|network request/i.test(message))
      return 'We could not connect. Check your internet connection and try again.';
    if (/^You must agree to the consent notice/i.test(message))
      return 'Please agree to the notice before creating your account.';
    if (/^Enter a valid email address\.$/i.test(message))
      return 'Enter an email address in the correct format.';
    if (/^The backup PIN must be exactly 6 digits\.$/i.test(message))
      return 'Your backup PIN must contain exactly 6 numbers.';
    if (/No face template was received/i.test(message))
      return 'We could not find the photo on your ID. Make sure the full front of the ID is visible.';
    if (/supabase|postgrest|postgresql|pgrst|jwt|invalid input syntax|face template|descriptor/i.test(message))
      return 'Something went wrong while checking your information. Please try again. If it keeps happening, contact the administrator.';
    if (/^TypeError:|^ReferenceError:|^SyntaxError:|Cannot read properties|is not a function/i.test(message))
      return 'Something went wrong. Please try again. If it keeps happening, contact the administrator.';
    if (/^Session expired/i.test(message))
      return 'Your session has ended. Please sign up or log in again.';
    if (/^This registration has already been submitted and cannot be cancelled here\.$/i.test(message))
      return 'This signup has already been submitted and cannot be cancelled.';
    if (/^Too many failed attempts/i.test(message))
      return message.replace('Too many failed attempts', 'You have tried too many times');
    if (/^Too many tries\./i.test(message))
      return 'You have tried too many times. Please wait a few minutes, then try again.';
    if (/^Too many failed scans\./i.test(message))
      return 'You have tried too many times. Wait a few minutes, or log in with your PIN.';
    if (/^Email or PIN is incorrect\.$/i.test(message))
      return 'That email and PIN do not match. Check them and try again.';
    if (/^This email is already in use and cannot be registered again\.$/i.test(message))
      return 'An account with this email already exists. Try logging in instead.';
    if (/^This email already has a registration in progress/i.test(message))
      return 'A signup with this email is already in progress. Try another email or contact the administrator.';
    if (/^This email is already registered\./i.test(message))
      return 'An account with this email already exists. Try logging in instead.';
    if (/^This ID is already registered/i.test(message))
      return 'This ID number is already linked to another account. Contact the administrator if you think this is a mistake.';
    if (/^Choose a supported ID type\.$/i.test(message))
      return 'Choose one of the ID types listed on this page.';
    if (/^Required ID details are missing\.$/i.test(message))
      return 'We could not read the required details from your ID. Try again with a clear, well-lit photo.';
    if (/^Enter a valid ID number\.$/i.test(message))
      return 'Check the ID number and enter it again.';
    if (/^Full name and ID number are required\.$/i.test(message))
      return 'Enter your full name and ID number.';
    if (/^Enter a valid date of birth\.$/i.test(message))
      return 'Enter a valid date of birth.';
    if (/^This registration has already been submitted/i.test(message))
      return 'This signup has already been submitted and cannot be cancelled.';
    if (/^Choose a role to assign\.$/i.test(message))
      return 'Choose a role for this person before approving the signup.';
    if (/^The file could not be read as an image\.$/i.test(message))
      return 'We could not open this image. Choose a JPG or PNG photo and try again.';
    if (/^Your account is waiting for admin approval\.$/i.test(message))
      return 'Your signup is complete. An administrator still needs to approve your account.';
    if (/^Your registration was rejected\./i.test(message))
      return 'Your signup was not approved. Please contact the administrator for help.';
    if (/^Your unfinished registration was cleared/i.test(message))
      return 'Your previous signup was not finished, so it was cleared. Please sign up again.';
    if (/Complete the ID scan and face match first/i.test(message))
      return 'Please finish the ID scan and face check first.';
    if (/Complete the ID scan first/i.test(message))
      return 'Please scan your ID first.';
    if (/face does not match|face not recognized/i.test(message))
      return 'We could not match your face to the photo on your ID. Try again in good lighting.';
    if (/^No clear face found\./i.test(message))
      return 'We could not get a clear view of your face. Center your face in the camera and try again.';
    if (/captures do not look like the same person|match was not clear enough/i.test(message))
      return 'We could not confirm a clear face match. Try again in good lighting, or use your PIN to log in.';
    if (/invalid capture data|incomplete capture|straight-on capture is required/i.test(message))
      return 'We could not get a clear set of face images. Please try again and follow each instruction.';
    if (/^Unknown (step|action)\./i.test(message))
      return 'Something went wrong. Please try again.';
    if (/^Admins only\./i.test(message))
      return 'This page is only available to an administrator.';
    if (/^That account is no longer pending\./i.test(message))
      return 'This signup has already been reviewed. Refresh the list to see the latest status.';
    return message;
  }
  function say(id, text, kind = 'bad') {
    const el = $(id), message = friendlyMessage(text);
    el.textContent = message; el.className = 'alert ' + kind; el.hidden = !message;
  }
  const roleLabel = key => (roles.find(r => r.key === key) || {}).label || key || '';
  function lockText(isoTime) {
    if (!isoTime || new Date(isoTime) <= new Date()) return '';
    return 'You have tried too many times. Please try again after ' + new Date(isoTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + '.';
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
        if (!$('screen-id').hidden) say('msg-id', 'Your signup session has ended. Please start again.');
        else if (!$('screen-face').hidden) say('msg-face', 'Your signup session has ended. Please start again.');
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
      if (!$('screen-id').hidden) say('msg-id', 'You can scan your ID again now.', 'good');
      else if (!$('screen-face').hidden) say('msg-face', 'You can try the face check again now.', 'good');
    } catch (err) {
      const message = 'We could not check when you can try again. Check your connection; we will try again shortly.';
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
  async function startCam(video, facingMode = 'user', mirrorPreview = true) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)
      throw new Error('Camera access is unavailable. Use a supported browser over HTTPS or use your PIN.');
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 960 }, facingMode: { ideal: facingMode } },
      audio: false
    });
    video.srcObject = stream;
    const track = stream.getVideoTracks()[0];
    const actualFacingMode = track && track.getSettings ? track.getSettings().facingMode : '';
    const shouldMirror = mirrorPreview && (actualFacingMode ? actualFacingMode === 'user' : facingMode === 'user');
    video.classList.toggle('mirror-preview', shouldMirror);
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
    if (idDetectorReady) return;
    onStatus('Loading ID face model (first time only)...');
    await Promise.all([
      ensureSharedModels(),
      faceapi.nets.ssdMobilenetv1.loadFromUri(CFG.MODEL_URL)
    ]);
    idDetectorReady = true;
  }
  async function ensureSharedModels() {
    if (sharedModelsReady) return;
    await Promise.all([
      faceapi.nets.faceLandmark68Net.loadFromUri(CFG.MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(CFG.MODEL_URL)
    ]);
    sharedModelsReady = true;
  }
  async function ensureLiveModels(onStatus) {
    if (liveDetectorReady) return;
    onStatus('Preparing fast face scan (first time only)...');
    await Promise.all([
      ensureSharedModels(),
      faceapi.nets.tinyFaceDetector.loadFromUri(CFG.MODEL_URL)
    ]);
    liveDetectorReady = true;
  }
  const detectorOptions = () => new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5, maxResults: 2 });
  const liveDetectorOptions = () => new faceapi.TinyFaceDetectorOptions({ inputSize: 256, scoreThreshold: 0.5 });

  function cropToFaceGuide(canvas, video) {
    const camera = video.parentElement;
    const videoRect = video.getBoundingClientRect();
    const cameraRect = camera.getBoundingClientRect();
    const guideSize = parseFloat(getComputedStyle(camera, '::before').width) - 4;
    const scale = Math.max(videoRect.width / canvas.width, videoRect.height / canvas.height);
    if (!Number.isFinite(guideSize) || guideSize <= 0 || !Number.isFinite(scale) || scale <= 0)
      throw new Error('The face guide is not ready. Restart the camera and try again.');

    const visibleWidth = videoRect.width / scale;
    const visibleHeight = videoRect.height / scale;
    const centerX = (canvas.width - visibleWidth) / 2 +
      (cameraRect.left + cameraRect.width / 2 - videoRect.left) / scale;
    const centerY = (canvas.height - visibleHeight) / 2 +
      (cameraRect.top + cameraRect.height / 2 - videoRect.top) / scale;
    const size = Math.min(canvas.width, canvas.height, Math.round(guideSize / scale));
    const left = Math.round(centerX - size / 2), top = Math.round(centerY - size / 2);
    const region = document.createElement('canvas');
    region.width = size; region.height = size;
    const context = region.getContext('2d');
    context.fillStyle = '#000';
    context.fillRect(0, 0, size, size);
    context.beginPath();
    context.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    context.clip();
    context.drawImage(canvas, left, top, size, size, 0, 0, size, size);
    return region;
  }

  function faceFitsGuide(box, size) {
    const center = size / 2;
    const faceCenterX = box.x + box.width / 2, faceCenterY = box.y + box.height / 2;
    return Math.hypot(faceCenterX - center, faceCenterY - center) <= center;
  }

  // Detect poses on every frame; run the slower descriptor model only on accepted frames.
  async function describe(canvas, video, includeDescriptor = false) {
    const region = cropToFaceGuide(canvas, video);
    let task = faceapi.detectAllFaces(region, liveDetectorOptions()).withFaceLandmarks();
    if (includeDescriptor) task = task.withFaceDescriptors();
    const faces = await task;
    const insideGuide = faces.filter(face => faceFitsGuide(face.detection.box, region.width));
    if (!insideGuide.length) return null;
    insideGuide.sort((a, b) => b.detection.box.area - a.detection.box.area);
    const r = insideGuide[0], second = insideGuide[1];
    if (r.detection.score < 0.5 || r.detection.box.width < region.width * 0.1) return null;
    if (second && second.detection.box.area > r.detection.box.area * 0.55) return null;
    const info = BL.poseFromLandmarks(r.landmarks.positions, r.detection.box.width, region.width);
    if (!includeDescriptor) return info;
    return { ...info, descriptor: Array.from(r.descriptor, x => +x.toFixed(5)) };
  }

  async function capturePose(video, pose, straight, sayEl) {
    let steadyFrames = 0, captured = null;
    const eyeBaseline = straight && Number.isFinite(straight.eyeRatio) && straight.eyeRatio >= CFG.EYE_OPEN_MIN
      ? straight.eyeRatio : null;
    const blinkState = { opened: pose.key === 'blink' && eyeBaseline !== null, closed: false, reference: eyeBaseline };
    sayEl.textContent = pose.text + ' — hold still while the camera checks.';
    while (!captureCancelled) {
      const canvas = snap(video), info = await describe(canvas, video);
      if (captureCancelled) return null;
      if (pose.key === 'blink') {
        if (info && info.label === 'straight' && BL.recordBlink(info.eyeRatio, eyeBaseline, blinkState)) {
          const capturedInfo = await describe(canvas, video, true);
          if (capturedInfo) return { pose: pose.key, info: { ...capturedInfo, blinked: true } };
        }
        sayEl.textContent = !info ? 'Center one face in the guide and use even lighting.'
          : blinkState.closed ? 'Blink detected — open your eyes.'
          : blinkState.opened ? 'Close and reopen your eyes to blink.'
          : 'Open your eyes, then blink once.';
        continue;
      }
      if (BL.poseMatches(pose.key, info, straight)) {
        steadyFrames++;
        if (steadyFrames >= 2) {
          const capturedInfo = await describe(canvas, video, true);
          if (capturedInfo && BL.poseMatches(pose.key, capturedInfo, straight)) {
            captured = { pose: pose.key, info: capturedInfo };
            return captured;
          }
          steadyFrames = 0;
        }
        sayEl.textContent = 'Good, hold still...';
      } else {
        steadyFrames = 0;
        if (!info) sayEl.textContent = 'Center one face in the guide and use even lighting.';
        else sayEl.textContent = pose.text + ' — hold the pose until it is detected.';
      }
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
  $('btn-consent-continue').onclick = () => {
    say('msg-signup', '');
    if (!$('su-consent').checked) return say('msg-signup', 'Please tick the box to agree before continuing.');
    say('msg-signup-credentials', '');
    show('signup-credentials');
    $('su-email').focus();
  };
  $('btn-signup-back-consent').onclick = () => {
    say('msg-signup-credentials', '');
    show('signup');
  };

  $('signup-form').onsubmit = async e => {
    e.preventDefault(); say('msg-signup-credentials', '');
    if (!$('su-consent').checked) {
      show('signup');
      return say('msg-signup', 'Please agree to the notice before creating your account.');
    }
    try {
      const r = await Api.signup($('su-email').value, $('su-pin').value, $('su-consent').checked);
      if (!r.ok) return say('msg-signup-credentials', r.message);
      Api.setToken(r.token); registrationInProgress = true; $('signup-form').reset(); await route();
    } catch (err) { say('msg-signup-credentials', err.message); }
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
    $('id-file').value = '';
    showIdPreview(null);
    $('btn-scan').textContent = 'Scan ID';
    $('btn-id-retry').hidden = true;
    say('msg-id', 'This photo was not clear enough. Choose or take another photo, then scan again.', 'warn');
  }
  function showIdPreview(file) {
    const img = $('id-preview');
    if (idPreviewUrl) URL.revokeObjectURL(idPreviewUrl);
    img.classList.remove('mirror-preview');
    if (!file) { img.hidden = true; img.removeAttribute('src'); idPreviewUrl = null; return; }
    idPreviewUrl = URL.createObjectURL(file);
    img.src = idPreviewUrl; img.hidden = false;
  }
  const selectedIdFile = () => $('id-file').files[0];
  $('id-file').onchange = () => {
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
    let score = key === 'full_name' ? candidate.confidence * 0.5 : candidate.confidence * 2;
    if (key === 'full_name') {
      const words = value.split(/\s+/).filter(Boolean);
      if (!/\p{L}/u.test(value)) return -Infinity;
      score += Math.min(words.length, 4) + (words.length > 1 ? 1 : 0);
      if (words.length > 7) score -= (words.length - 7) * 2;
      score -= words.filter(word => /^\p{L}$/u.test(word)).length * 2;
      if (/\b(?:full\s*name|surname|family\s*name|last\s*name|given\s*names?|first\s*names?|name|apelyido|mga\s*pangalan|gitnang\s*apelyido)\b/i.test(text)) score += 1;
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
    const candidateCount = key === 'full_name'
      ? [...groups.values()].reduce((count, group) => count + group.count, 0)
      : candidates.length;
    const majority = Math.floor(candidateCount / 2) + 1;
    const ranked = [...groups.values()].sort((a, b) => b.count - a.count || b.score - a.score);
    const bestScore = candidates.reduce((score, candidate) =>
      Math.max(score, fieldReadScore(candidate, key)), -Infinity);
    const agreementMargin = key === 'address' ? 0.05 : key === 'full_name' ? 0.1 : 1.5;
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
  let tesseractWorkerPromise = null;

  async function getTesseractWorker() {
    if (!tesseractWorkerPromise) {
      tesseractWorkerPromise = Tesseract.createWorker('eng', 1).catch(error => {
        tesseractWorkerPromise = null;
        throw error;
      });
    }
    return tesseractWorkerPromise;
  }

  async function recognizeIdText(worker, canvas, pageSegMode) {
    await worker.setParameters({
      tessedit_pageseg_mode: String(pageSegMode),
      preserve_interword_spaces: '1'
    });
    return worker.recognize(canvas);
  }

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
    const worker = await getTesseractWorker();
    const passes = [
      { threshold: false, pageSegMode: 6 },
      { threshold: true, pageSegMode: 11 }
    ];
    const candidates = [];
    const detailCandidates = [];
    const texts = [];
    for (const pass of passes) {
      const result = await recognizeIdText(worker, forOcr(canvas, pass.threshold), pass.pageSegMode);
      texts.push(result.data.text);
      const candidate = { parsed: BL.parseIdText(result.data.text, type), confidence: result.data.confidence / 100, text: result.data.text };
      candidates.push(candidate);
    }
    const primaryBest = candidates.reduce((current, candidate) =>
      idReadScore(candidate) > idReadScore(current) ? candidate : current);
    const conflictingFields = ['full_name', 'dob', 'id_number'].some(key => {
      const values = candidates.map(candidate =>
        String(candidate.parsed.fields[key] || '').toLowerCase().replace(/[^a-z0-9]/g, ''))
        .filter(Boolean);
      return new Set(values).size > 1;
    });
    const missingLabeledAddress = !primaryBest.parsed.fields.address &&
      /\b(?:address|residence|tirahan)\b/i.test(texts.join('\n'));
    const primaryCheck = BL.checkOcr(primaryBest.parsed, primaryBest.confidence);
    const needsFallback = !primaryCheck.ok || primaryBest.confidence < 0.5 ||
      conflictingFields || missingLabeledAddress;

    if (needsFallback) {
      const fallbackResult = await recognizeIdText(worker, forOcr(canvas, false), 4);
      texts.push(fallbackResult.data.text);
      candidates.push({
        parsed: BL.parseIdText(fallbackResult.data.text, type),
        confidence: fallbackResult.data.confidence / 100,
        text: fallbackResult.data.text
      });

      for (const pass of [
        { enhance: false, pageSegMode: 6 },
        { enhance: true, pageSegMode: 11 }
      ]) {
        const processedCanvas = forOcr(detailCanvas, false, pass.enhance);
        const result = await recognizeIdText(worker, processedCanvas, pass.pageSegMode);
        detailCandidates.push({
          parsed: BL.parseIdText(result.data.text, type),
          confidence: result.data.confidence / 100,
          text: result.data.text
        });
        if (pass.enhance === false) {
          const dobArea = cropDobLabelArea(processedCanvas, result.data.words);
          if (dobArea) {
            const preparedDobArea = forOcr(dobArea, false, false);
            const dobResult = await recognizeIdText(worker, preparedDobArea, 6);
            detailCandidates.push({
              parsed: BL.parseIdText(dobResult.data.text, type),
              confidence: dobResult.data.confidence / 100,
              text: dobResult.data.text
            });
          }
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
        extra = ' You have tried too many times. Please wait 15 minutes before trying again.';
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
      return say('msg-id', 'Choose or take a JPG or PNG photo smaller than 5 MB.');
    }
    $('btn-id-retry').hidden = true;
    updateStepper(2);
    btn.textContent = 'Scanning ID...';
    btn.disabled = true;
    try {
      const detailCanvas = await fileToCanvas(file, 2200);
      const canvas = resizeCanvas(detailCanvas, 1600);

      setStatus('Checking the photo...');
      const g = grayPixels(canvas, 800);
      if (BL.laplacianVariance(g.data, g.w, g.h) < CFG.MIN_SHARPNESS)
        return await failStep('id', 'msg-id', 'btn-scan', 'The photo is too blurry. Retake it in good light and hold the camera steady.');

      setStatus('Reading the details on your ID...');
      const result = await readId(canvas, type, detailCanvas);
      const typeCheck = BL.checkIdType(result.texts, type);
      if (!typeCheck.ok) {
        showIdRetry();
        return say('msg-id', typeCheck.message);
      }
      const fields = { ...result.parsed.fields };
      const hasAddressLabel = /\b(?:address|residence|tirahan)\b/i.test(result.texts.join('\n'));
      if (!fields.full_name || (!fields.address && hasAddressLabel)) {
        setStatus('Taking another look at the ID details...');
        const paddleDetails = await readPaddleDetails(resizeCanvas(detailCanvas, 1800), type);
        if (paddleDetails && paddleDetails.full_name) fields.full_name = paddleDetails.full_name;
        if (paddleDetails && paddleDetails.address) fields.address = paddleDetails.address;
      }
      const parsed = { ...result.parsed, fields }, conf = result.confidence;
      const check = BL.checkOcr(parsed, conf);
      if (!check.ok) return await failStep('id', 'msg-id', 'btn-scan', check.message);

      await ensureModels(setStatus);
      setStatus('Finding the face photo on the ID...');
      const faces = await faceapi.detectAllFaces(canvas, detectorOptions()).withFaceLandmarks().withFaceDescriptors();
      if (!faces.length)
        return await failStep('id', 'msg-id', 'btn-scan', 'We could not find the photo on your ID. Make sure the full front of the ID is visible, then try again.');
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
    captureCancelled = false; btn.disabled = true; say('msg-face', ''); updateFaceProgress(0); updateStepper(3);
    try {
      await ensureLiveModels(t => { sayEl.textContent = t; });
      if (captureCancelled) return;
      try { await startCam(video); }
      catch (e) { say('msg-face', 'We could not access your camera. Allow camera access in your browser, then try again.'); return; }
      if (captureCancelled) { stopCam(video); return; }

      const shots = [];
      for (const p of CFG.POSES) {
        updateFaceProgress(0);
        const captured = await capturePose(video, p, shots.length ? shots[0].info : null, sayEl);
        if (captureCancelled) return;
        if (!captured) return;
        shots.push(captured);
        updateFaceProgress(1);
        if (captureCancelled) return;
      }
      stopCam(video); sayEl.textContent = 'Checking your face...';

      const infos = {};
      for (const s of shots) infos[s.pose] = s.info;
      const chk = BL.checkPoses(infos);                       // did the person follow each instruction?
      if (!chk.ok) {
        sayEl.textContent = 'We could not confirm all the camera checks.';
        return await failStep('face', 'msg-face', 'btn-face-start',
          'We could not confirm all the camera checks. Follow each instruction in good lighting, then try again.');
      }

      if (captureCancelled) return;
      updateStepper(4);
      const r = await Api.saveFace(chk.passed.map(p => ({ pose: p, descriptor: infos[p].descriptor })));   // server decides the match
      if (captureCancelled) return;
      if (!r.ok) { sayEl.textContent = 'We could not confirm a match.'; return await failStep('face', 'msg-face', 'btn-face-start', r.message); }
      sayEl.textContent = 'Your face matches the photo on the ID.';
      say('msg-face', 'Face check complete. Your face matches the photo on your ID.', 'good');
      updateStepper(4);
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
      pending:  ['Signup received — approval pending', 'We read the details on your ID and matched your face to its photo. An administrator still needs to check your original ID and approve your account.', 'warn'],
      rejected: ['Signup not approved', 'Your signup was not approved. Please contact the administrator for help.', 'bad'],
      active:   ['Account approved', 'Your account is ready. You can log in with your face or PIN.', 'good']
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
      await ensureLiveModels(t => { sayEl.textContent = t; });
      if (captureCancelled) return;
      try { await startCam(video); }
      catch (e) { say('msg-login', 'We could not access your camera. Allow camera access in your browser, or choose the PIN option below.'); return; }
      if (captureCancelled) { stopCam(video); return; }

      const shots = [];
      for (const pose of CFG.POSES) {
        const shot = await capturePose(video, pose, shots.length ? shots[0].info : null, sayEl);
        if (captureCancelled) return;
        if (!shot) return;
        shots.push(shot);
      }
      stopCam(video); sayEl.textContent = 'Checking your face...';
      if (captureCancelled) return;
      const baseline = shots[0].info;
      if (shots.some(shot => faceapi.euclideanDistance(baseline.descriptor, shot.info.descriptor) > CFG.SAME_PERSON_DIST)) {
        return say('msg-login', 'We could not confirm that all the face images match. Try again in good lighting.');
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
      if (!r.items.length) return say('msg-approvals', 'There are no signups to review right now.', 'warn');
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
      if (action === 'approve' && !sel.value) return say('msg-approvals', 'Choose a role for this person before approving the signup.');
      ok.disabled = no.disabled = true;
      try {
        const r = await Api.decide(p.id, action, sel.value, reason.value);
        if (!r.ok) { say('msg-approvals', r.message); ok.disabled = no.disabled = false; return; }
        box.remove(); say('msg-approvals', action === 'approve' ? 'Signup approved.' : 'Signup rejected.', 'good');
      } catch (err) { say('msg-approvals', err.message); ok.disabled = no.disabled = false; }
    };
    ok.onclick = () => decide('approve'); no.onclick = () => decide('reject');
    box.append(dl, approveRow, rejectRow); return box;
  }

  /* ------------------------------------------------------------ navigation + start */
  function resetRegistrationUi() {
    cancelActiveCapture();
    clearLockRefreshTimer();
    registrationInProgress = false;
    $('id-file').value = '';
    showIdPreview(null);
    $('id-type').selectedIndex = 0;
    $('btn-scan').textContent = 'Scan ID'; $('btn-id-retry').hidden = true;
    $('id-status').textContent = ''; $('id-status').hidden = true;
    $('signup-form').reset(); $('su-consent').checked = false;
    $('info-form').reset(); $('pin-form').reset();
    $('pin-form').hidden = true; $('face-login').hidden = false;
    ['msg-signup', 'msg-signup-credentials', 'msg-id', 'msg-face', 'msg-info', 'msg-pin', 'msg-login'].forEach(id => say(id, ''));
    $('btn-scan').disabled = false; $('btn-face-start').disabled = false;
    $('btn-face-start').hidden = false; $('btn-face-next').hidden = true;
  }
  async function cancelRegistration() {
    if (!Api.token()) { me = null; resetRegistrationUi(); show('home'); return; }
    if (!    window.confirm('Leave signup? Your unfinished information will be deleted.')) return;
    cancelActiveCapture();
    try {
      const r = await Api.cancelSignup();
      if (!r.ok) return window.alert(friendlyMessage(r.message));
      Api.setToken(null); me = null; registrationInProgress = false; resetRegistrationUi(); show('home');
    } catch (err) {
      window.alert(friendlyMessage('We could not clear your unfinished signup. Please try again. ' + err.message));
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
    say('msg-signup-credentials', '');
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
    try { roles = await Api.roles(); } catch (e) { say('msg-signup', 'We could not load signup options. Check your connection and try again.'); }
    try { await route(); } catch (e) { show('home'); }
  })();
})();