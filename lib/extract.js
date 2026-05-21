import { downloadFromStorage, getSupabase } from "./supabase.js";
import { extractJson, LLMParseError } from "./llm.js";

/* ------------------------------------------------------------------ *
 * Lab-report PDF -> public.healthspan_biomarkers
 * ------------------------------------------------------------------ */

const LAB_SYSTEM_PROMPT = [
  "You extract structured biomarker results from a clinical lab report.",
  "Read every result line on the document, including multi-page panels.",
  "Return STRICT JSON only — no prose, no markdown, no code fences.",
  "Shape:",
  '{ "sampled_on": "YYYY-MM-DD or null", "markers": [',
  '  { "marker_key": "snake_case stable identifier e.g. hba1c, ldl_cholesterol, vitamin_d_25oh",',
  '    "marker_label": "human-readable name as printed on the report",',
  '    "value": numeric value only (no units, no ranges) or null,',
  '    "unit": "unit string as printed e.g. mg/dL, mmol/L, %, ng/mL or null",',
  '    "note": "reference range, flag (H/L), or qualitative result; null if none" } ] }',
  "Use the collection/sample date for sampled_on; if absent use the report date.",
  "If a result is qualitative (e.g. Negative, Positive), set value null and put the result in note.",
  "Never invent markers that are not on the document. Omit administrative lines.",
].join("\n");

/**
 * Extract biomarkers from a lab PDF and insert them into healthspan_biomarkers.
 * Returns the inserted rows.
 */
export async function extractLabs({ patient_id, storage_bucket, storage_path }) {
  if (!patient_id || !storage_bucket || !storage_path) {
    const err = new Error("patient_id, storage_bucket and storage_path are required");
    err.statusCode = 400;
    throw err;
  }

  const { buffer, contentType } = await downloadFromStorage(storage_bucket, storage_path);

  const parsed = await extractJson({
    systemPrompt: LAB_SYSTEM_PROMPT,
    userPrompt:
      "Extract every biomarker result from this lab report as STRICT JSON in the documented shape.",
    fileBuffer: buffer,
    contentType,
  });

  const markers = Array.isArray(parsed?.markers) ? parsed.markers : null;
  if (!markers) {
    throw new LLMParseError("LLM reply missing a markers array", parsed);
  }

  const sampledOn = normaliseDate(parsed?.sampled_on);

  const rows = [];
  for (const m of markers) {
    const markerKey = cleanStr(m?.marker_key);
    if (!markerKey) continue; // a row with no key is unusable
    rows.push({
      patient_id,
      marker_key: markerKey.toLowerCase(),
      marker_label: cleanStr(m?.marker_label) || markerKey,
      value: toNumberOrNull(m?.value),
      unit: cleanStr(m?.unit),
      sampled_on: sampledOn,
      note: cleanStr(m?.note),
    });
  }

  if (rows.length === 0) {
    return { sampled_on: sampledOn, markers: [], inserted: 0 };
  }

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("healthspan_biomarkers")
    .insert(rows)
    .select();
  if (error) {
    throw new Error(`insert into healthspan_biomarkers failed: ${error.message}`);
  }

  return { sampled_on: sampledOn, markers: data ?? rows, inserted: (data ?? rows).length };
}

/* ------------------------------------------------------------------ *
 * ID / insurance card image -> public.frontdesk_intakes
 * ------------------------------------------------------------------ */

const CARD_SYSTEM_PROMPT = [
  "You extract identity and insurance fields from a photo of an ID card or insurance card.",
  "Return STRICT JSON only — no prose, no markdown, no code fences.",
  "Shape:",
  "{",
  '  "full_name": "name as printed or null",',
  '  "date_of_birth": "YYYY-MM-DD or null",',
  '  "insurance_provider": "insurer / payer name or null",',
  '  "member_id": "insurance member or policy number or null",',
  '  "group_number": "insurance group number or null",',
  '  "document_number": "ID / passport / licence number or null",',
  '  "expiry": "YYYY-MM-DD card or policy expiry or null"',
  "}",
  "Only return a field if it is clearly legible on the document. Use null when unsure.",
  "Never guess or invent values. Normalise all dates to YYYY-MM-DD.",
].join("\n");

// JSON field -> frontdesk_intakes column. Adjust here if the table differs.
const CARD_FIELD_TO_COLUMN = {
  full_name: "full_name",
  date_of_birth: "date_of_birth",
  insurance_provider: "insurance_provider",
  member_id: "member_id",
  group_number: "group_number",
  document_number: "document_number",
  expiry: "expiry",
};

const DATE_FIELDS = new Set(["date_of_birth", "expiry"]);

/**
 * Extract fields from a card image and UPDATE the matching frontdesk_intakes
 * row — only columns that are currently null/empty are filled. A value the
 * patient already typed is never overwritten.
 * Returns the extracted fields plus which columns were actually written.
 */
export async function extractCard({ intake_id, storage_bucket, storage_path }) {
  if (!intake_id || !storage_bucket || !storage_path) {
    const err = new Error("intake_id, storage_bucket and storage_path are required");
    err.statusCode = 400;
    throw err;
  }

  const { buffer, contentType } = await downloadFromStorage(storage_bucket, storage_path);

  const parsed = await extractJson({
    systemPrompt: CARD_SYSTEM_PROMPT,
    userPrompt:
      "Extract the identity and insurance fields from this card image as STRICT JSON in the documented shape.",
    fileBuffer: buffer,
    contentType,
  });

  // Normalise the model output into the documented field set.
  const extracted = {};
  for (const field of Object.keys(CARD_FIELD_TO_COLUMN)) {
    let v = cleanStr(parsed?.[field]);
    if (v && DATE_FIELDS.has(field)) v = normaliseDate(v);
    extracted[field] = v;
  }

  const supabase = getSupabase();

  // Load the current row so we never overwrite patient-typed values.
  const { data: current, error: readErr } = await supabase
    .from("frontdesk_intakes")
    .select("*")
    .eq("id", intake_id)
    .maybeSingle();
  if (readErr) {
    throw new Error(`reading frontdesk_intakes failed: ${readErr.message}`);
  }
  if (!current) {
    const err = new Error(`no frontdesk_intakes row with id ${intake_id}`);
    err.statusCode = 404;
    throw err;
  }

  const updates = {};
  for (const [field, column] of Object.entries(CARD_FIELD_TO_COLUMN)) {
    const value = extracted[field];
    if (!value) continue; // nothing extracted for this field
    if (isEmpty(current[column])) {
      updates[column] = value;
    }
  }

  let written = [];
  if (Object.keys(updates).length > 0) {
    const { error: updErr } = await supabase
      .from("frontdesk_intakes")
      .update(updates)
      .eq("id", intake_id);
    if (updErr) {
      throw new Error(`update frontdesk_intakes failed: ${updErr.message}`);
    }
    written = Object.keys(updates);
  }

  return { intake_id, extracted, updated_columns: written };
}

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

function cleanStr(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === "" || s.toLowerCase() === "null" || s.toLowerCase() === "n/a") return null;
  return s;
}

function isEmpty(v) {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

function toNumberOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  // strip stray characters like "<", commas, units that slipped through
  const m = String(v).replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalise a date string to YYYY-MM-DD. Returns null if it cannot be made
 * into a valid calendar date.
 */
function normaliseDate(v) {
  const s = cleanStr(v);
  if (!s) return null;

  // already ISO
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return validDate(m[1], m[2], m[3]);

  // DD/MM/YYYY or DD-MM-YYYY (assume day-first, common in GCC/UK)
  m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = (Number(y) > 50 ? "19" : "20") + y;
    return validDate(y, mo.padStart(2, "0"), d.padStart(2, "0"));
  }

  // fall back to Date parsing (e.g. "12 Jan 2024")
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }
  return null;
}

function validDate(y, mo, d) {
  const iso = `${y}-${mo}-${d}`;
  const dt = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(dt.getTime())) return null;
  if (dt.toISOString().slice(0, 10) !== iso) return null; // rejects e.g. 02-30
  return iso;
}
