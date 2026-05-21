# nomoi-docextract

Document-extraction backend for NOMOI. One small Node 22 HTTP service, two
consumers:

- **Healthspan** — lab-report PDFs to structured biomarkers.
- **Front Desk** — ID / insurance card photos to structured intake fields.

The service downloads the source document from Supabase Storage, sends it to
the LLM (`gemini-2.5-flash` via the LiteLLM gateway, image and PDF capable),
parses the strict-JSON reply, and writes the structured result back to
Postgres.

## Run

```bash
npm install
node server.js          # listens on :$PORT (default 8080)
```

Docker:

```bash
docker build -t nomoi-docextract .
docker run -p 8080:8080 --env-file .env nomoi-docextract
```

## Environment variables

All configuration is read from the environment — nothing is hardcoded.

| Variable                    | Required | Purpose                                                        |
|-----------------------------|----------|----------------------------------------------------------------|
| `LITELLM_API_KEY`           | yes      | Bearer key for the LiteLLM gateway.                            |
| `LITELLM_BASE_URL`          | yes      | LiteLLM base URL — `https://litellm.nomoi.ai`.                 |
| `SUPABASE_URL`              | yes      | Supabase project URL.                                          |
| `SUPABASE_SERVICE_ROLE_KEY` | yes      | Service-role key — Storage download, table writes, AND the bearer the two POST endpoints require. Server only. |
| `PORT`                      | no       | HTTP listen port. Defaults to `8080`.                          |

## Auth

Both POST endpoints require the Supabase service-role key as the bearer:

```
Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>
```

The Healthspan dashboard and the Front Desk clinic view already hold this
key at runtime (the operator enters it to read data) and forward it here, so
no secret is ever baked into client config. A missing or wrong key returns
`401 {"error":"unauthorized"}`.

## CORS

Browser callers are allowed from `https://healthspan.nomoi.ai` and
`https://frontdesk.nomoi.ai`. `OPTIONS` preflight is handled and returns `204`.

## Endpoints

### `GET /health`

No auth. Liveness probe.

```json
{ "ok": true }
```

### `POST /extract/labs`

Extract biomarkers from a lab-report PDF and insert them into
`public.healthspan_biomarkers`.

Request:

```json
{
  "patient_id": "uuid-of-the-patient",
  "storage_bucket": "lab-reports",
  "storage_path": "patient-123/2026-05-panel.pdf"
}
```

Response `200`:

```json
{
  "ok": true,
  "sampled_on": "2026-05-12",
  "inserted": 2,
  "markers": [
    {
      "patient_id": "uuid-of-the-patient",
      "marker_key": "hba1c",
      "marker_label": "HbA1c",
      "value": 5.4,
      "unit": "%",
      "sampled_on": "2026-05-12",
      "note": "Reference range 4.0-5.6"
    },
    {
      "patient_id": "uuid-of-the-patient",
      "marker_key": "ldl_cholesterol",
      "marker_label": "LDL Cholesterol",
      "value": 2.1,
      "unit": "mmol/L",
      "sampled_on": "2026-05-12",
      "note": null
    }
  ]
}
```

Inserts one row per biomarker into `public.healthspan_biomarkers`
(`patient_id`, `marker_key`, `marker_label`, `value`, `unit`, `sampled_on`,
`note`).

### `POST /extract/card`

Extract identity and insurance fields from an ID / insurance card image and
UPDATE the matching `public.frontdesk_intakes` row. Only columns that are
currently null or empty are filled — a value the patient already typed is
never overwritten.

Request:

```json
{
  "intake_id": "uuid-of-the-intake-row",
  "storage_bucket": "frontdesk-cards",
  "storage_path": "intake-456/insurance-front.jpg"
}
```

Response `200`:

```json
{
  "ok": true,
  "intake_id": "uuid-of-the-intake-row",
  "extracted": {
    "full_name": "Jane A Doe",
    "date_of_birth": "1988-03-04",
    "insurance_provider": "Daman",
    "member_id": "DM-9981234",
    "group_number": "GRP-204",
    "document_number": "784-1988-1234567-1",
    "expiry": "2027-01-31"
  },
  "updated_columns": ["insurance_provider", "member_id", "expiry"]
}
```

`extracted` is everything the model read off the card. `updated_columns` lists
only the columns actually written — fields the patient had already filled are
returned in `extracted` but left untouched in the row.

## Error responses

| Status | Body                                                          | When                                              |
|--------|---------------------------------------------------------------|---------------------------------------------------|
| `400`  | `{"error":"bad_request","detail":"..."}`                      | Missing required body fields, invalid JSON body.  |
| `401`  | `{"error":"unauthorized"}`                                    | Missing / wrong bearer token.                     |
| `404`  | `{"error":"not found"}` / `{"error":"bad_request",...}`        | Unknown route, or no matching intake row.         |
| `413`  | `{"error":"bad_request","detail":"request body too large"}`   | JSON body over 1 MB.                              |
| `422`  | `{"error":"extraction_failed","detail":"..."}`                | LLM reply could not be parsed into structured data.|
| `500`  | `{"error":"internal_error","detail":"..."}`                   | Storage download / DB write / upstream failure.   |

The service never crashes on a malformed LLM reply — it returns a clean `422`.
