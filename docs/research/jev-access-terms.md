# Jev's access terms, key conventions and data policy

Research for ticket #81 on the System One map (#79).
It covers how a person gets a Jev key, which environment variable the official SDKs read, what Jev costs, how its limits and overload errors behave, which model ids exist, how fast it answers, and what TypeSafe does with the content a request carries.
Answered from primary sources as of 2026-10-05.
No account was created and nothing was paid for.

How sources are cited:

- **[docs: path]** is a page of TypeSafe's live documentation at `https://docs.typesafe.ai/<path>`, read as Markdown.
- **[legal: document §]** is one of TypeSafe's legal documents on `typesafe.ai/legal`, cited by section.
- **[py: symbol]** is the official Python SDK, `typesafe-sdk` 0.7.2, read from its public GitHub source and cited by module and symbol.
- **[js: symbol]** is the official JavaScript SDK, `@typesafe-ai/sdk` 0.6.0, read the same way.
- **[probe]** is a `curl` request to `api.typesafe.ai` made on 2026-10-05 with no key or with a made-up one.
- **[x]** is a post on TypeSafe's own X account, `@typesafeai`, read through X's public embed endpoint.

## Short answer

- **Getting a key.** A person signs in at `console.typesafe.ai` and creates a key under API Keys [docs: introduction/quickstart].
  The key goes in `Authorization: Bearer <key>` [docs: api].
- **Default environment variable.** Both official SDKs read the key from `TYPESAFE_API_KEY` [py: `constants.API_KEY_ENV`] [js: `ENV.apiKey`].
  They also read `TYPESAFE_BASE_URL`, `TYPESAFE_DEFAULT_MODEL` and `TYPESAFE_LOG_LEVEL`.
  A value passed in code wins over the environment, and a blank environment value is ignored.
- **Getting access now.** TypeSafe opened Jev to everyone on 2026-09-20 and paused new signups on 2026-09-22 [x].
  Whether signups are still paused could not be verified.
- **Price.** Jev costs $0.042 per million input tokens, and output tokens are free [docs: models].
  Each request uses up credits that the account buys in advance [legal: MCA §8.2].
  TypeSafe publishes no free tier.
  It may give promotional credits at its own discretion [legal: MCA §8.2(b)].
  Third-party write-ups say each new account got $5 of credit, but no TypeSafe source read here says so.
- **Rate limits.** The published limits are 100K tokens per second and 80 requests per second, and TypeSafe says they may change without notice [docs: models].
  A request over either limit gets `429 Too Many Requests`.
  `529 Overloaded` means TypeSafe itself is overloaded.
  For both, the docs say to retry with exponential backoff [docs: api].
  Both SDKs do this by default: two retries after the first attempt, and they honour `retry-after` [py: `RetryPolicy`] [js: `DEFAULT_RETRY_POLICY`].
- **Model ids.** `jev-latest` and `jev-preview` both point to `jev-1.13.0` today [docs: models].
  The response's `model` field names the versioned id that answered.
  Pin `jev-1.13.0` when thresholds are tuned against it.
- **Latency.** TypeSafe says "most queries complete in about 100 ms" [docs: concepts/how-to-build-with-system-one].
  Its own cookbook measured 0.27 s for a single batched call over a long article [docs: cookbooks/parallel_questions].
  The SDKs give each attempt 10 seconds by default.
- **Data.** TypeSafe does not train on request content [docs: models] [legal: Privacy Policy].
  The agreement allows training only with the customer's prior consent [legal: MCA §4.1].
  TypeSafe keeps personal data "as long as reasonably necessary" [legal: Privacy Policy, Retention].
  It holds a perpetual right to use request content for telemetry, fraud and abuse monitoring, and legal compliance [legal: MCA §4.1].
  The service is hosted in the United States.
  Zero data retention is offered only to enterprise customers, through sales [docs: legal].
  No self-serve opt-out is published.
- **Key terms.** A key must be kept confidential.
  The account holder answers for everything done with it [legal: MCA §2.4].
  TypeSafe must not be offered to others as a standalone service [legal: MCA §2.3(a)].
  So a mod uses the person's own key and never ships or shares one.

## 1. Getting a key

- The quick start says: "Get your API key from the dashboard", linking `https://console.typesafe.ai/keys` [docs: introduction/quickstart].
  The Python SDK page says to set `TYPESAFE_API_KEY` and links `https://console.typesafe.ai/` to create it [docs: sdk/python].
- The Playground at `console.typesafe.ai/playground` needs a login too [docs: introduction/quickstart].
- Using the console or the API means accepting the Master Customer Agreement (MCA), which covers both [legal: MCA §1].
  The Terms of Use cover the website and its subdomains, and give way to a separate agreement such as the MCA for TypeSafe's products [legal: Terms of Use].
- **Signups.** On 2026-09-20 TypeSafe posted "Jev is now available to everyone. No waitlist." [x].
  On 2026-09-22 it posted that "we have to temporarily pause signups for Jev", and that existing signups "will continue to function" [x].
  No later TypeSafe post or page saying signups have reopened was found.
  The console answers an unauthenticated `curl` with `403`, so its current signup state could not be seen without a browser login.
- **Key format.** The docs do not give a key's prefix or length.
  The Python SDK rejects a key that is empty, contains whitespace, or is not printable ASCII [py: `config.resolve_and_validate_api_key`].
  It does this before any request.
  That is the only format check found.
- **Other routes to Jev.** The Python SDK docs show the SDK reaching Jev through OpenRouter, the Vercel AI Gateway and the Pydantic AI Gateway [docs: sdk/python/usage, "Configuring the base URL"].
  Each route uses that gateway's own key, read from `OPENROUTER_API_KEY`, `AI_GATEWAY_API_KEY` or `PYDANTIC_AI_GATEWAY_API_KEY` in the examples.
  Each also uses that gateway's base URL, and OpenRouter and Vercel use their own model ids (`~typesafe/jev-latest`, `typesafe-ai/jev`).
  Those gateways' own terms were not researched here.

## 2. What the SDKs read from the environment

| Variable | Sets | Default when unset |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | The API key | None: both SDKs throw without one |
| `TYPESAFE_BASE_URL` | The API root | `https://api.typesafe.ai` |
| `TYPESAFE_DEFAULT_MODEL` | The model used when a call names none | `jev-latest` |
| `TYPESAFE_LOG_LEVEL` | Log verbosity | `warn` in JavaScript; unset in Python |

Sources: [py: `constants`] [js: `ENV`] [docs: sdk/python/api/constants] [docs: sdk/javascript/api/variables/ENV].

- **Precedence.** "Explicit options take precedence over environment variables, then SDK defaults" [js: `TypeSafeClient` constructor] [docs: sdk/javascript/api/interfaces/TypeSafeClientConfig].
  The Python client says the same [py: `TypeSafeClient.__init__`].
- **Blank values.** "Empty or whitespace-only environment values are ignored" in both SDKs [js: `readEnv`] [py: `config._resolve_string`].
- **Missing key.** Both SDKs throw when the client is built.
  Both messages name the variable.
  The JavaScript one reads "No API key was provided. Pass `apiKey` to the TypeSafeClient constructor or set the TYPESAFE_API_KEY environment variable." [js: `missingApiKey`].
  The Python one reads "No API key was provided. Pass api_key or set the TYPESAFE_API_KEY environment variable." [py: `config.resolve_and_validate_api_key`].
- **Where the key goes.** The SDKs send the key as a bearer token to whatever base URL is configured [py: `transport.prepare`] [js: `TypeSafeClient`].
  So setting `TYPESAFE_BASE_URL` to another server sends `TYPESAFE_API_KEY` there too.
  The SDK docs require that server to "follow the TypeSafe OpenAPI spec" [docs: sdk/python/usage].
- **Logging.** At `debug` level both SDKs log request and response bodies.
  Credential headers are redacted from those logs, "bodies are not" [docs: sdk/python/usage, "Logging"] [docs: sdk/javascript/api/interfaces/TypeSafeClientConfig].

## 3. Price, credits and free tier

- **Price.** "$42 / $0.042" per billion and per million tokens.
  It is "Charged per input token. Output tokens are free." [docs: models].
  A cookbook prices `jev-1.12` the same way, at $0.042 per million input tokens and $0.00 output [docs: cookbooks/parallel_questions].
- **Credits.** "In order to generate Output or otherwise use the Services, Customer must obtain TypeSafe-managed credits that are consumed by each Input" [legal: MCA §8.2].
  Bought credits expire after 12 months at most.
  With no credits left and no automatic refill, "TypeSafe may decline to generate Output" [legal: MCA §8.2(a)].
  The docs do not say which HTTP status that refusal returns.
- **Free use.** The docs and the MCA describe no free tier.
  The MCA allows "Promotional Credits" that TypeSafe "may, but has no obligation to, issue".
  It forbids making extra accounts to collect more of them [legal: MCA §8.2(b)].
- **Cost scales with input.** Every question is evaluated against the same `state`, sent once [docs: models].
  In TypeSafe's own cookbook the article in `state` "dominates every request" [docs: cookbooks/parallel_questions].
  An extra question "costs only the tokens for the extra questions, which are cheap" [docs: primitives].
  So cost follows mostly how much context a mod sends.

## 4. Rate limits, 429 and 529

- **Published limits** for `jev-1.13.0` are "100K tokens per second / 80 requests per second" [docs: models].
  They come with a warning: "Rate limits are adjusting dynamically … the limits above can change without notice".
  "Higher limits are available on custom and enterprise plans."
  The page does not say whether the limits apply per key or per account.
- **Context.** A request may hold 64k tokens in all, and the `state` plus the longest question may hold 32k [docs: models].
  Input is text only.

### Status codes

| Status | Meaning | Source |
| --- | --- | --- |
| `401 Unauthorized` | "Missing or invalid API key." A made-up key also gets 401, with body `{"detail":{"error_type":"authentication_error", …}}`. | [docs: api] [probe] |
| `403 Forbidden` | Not in the docs. A request with no `Authorization` header got 403 with `error_type` `authentication_error` and "Must supply an API key!". | [probe] |
| `422 Unprocessable Entity` | The body failed validation, and the response names the field. | [docs: api] |
| `429 Too Many Requests` | "You have exceeded your rate limit. Back off and retry after a short delay." | [docs: api] |
| `529 Overloaded` | "TypeSafe is temporarily overloaded. Retry after a short delay." | [docs: api] |

- Every response, error responses included, carried an `x-typesafe-request-id` header [probe].
  Both SDKs attach it to their errors [js: `APIError.requestId`] [py: `TypeSafeAPIError.request_id`].
- For both `429` and `529`, "retry the request with exponential backoff instead of retrying immediately" [docs: api, "Handling rate limits"].
  The SDKs "honor the `retry-after` header when the response carries one" [docs: models].
  So the header is not always present.

### SDK retry defaults

| Setting | Python | JavaScript |
| --- | --- | --- |
| Retries after the first attempt | 2 | 2 |
| Statuses retried | 408, 429 and 500–599, which takes in 529 | 408, 429 and 500–599 |
| Backoff | 0.5 s, doubling to at most 5 s, up to 25% jitter | 500 ms, doubling to at most 5000 ms, up to 25% jitter |
| Server delay | `Retry-After` or `retry-after-ms` | The same, up to 60 s; a longer delay falls back to backoff |
| Timeout per attempt | 10 s | 10000 ms |
| Total retry budget | 30 s | None |

Sources: [py: `RetryPolicy`, `constants.DEFAULT_TIMEOUT`] [js: `DEFAULT_RETRY_POLICY`, `DEFAULT_TIMEOUT_MS`, `retryDelayMs`].

Errors are typed.
A `429` becomes `RateLimitError` / `TypeSafeRateLimitError`, which carries the server's retry delay.
A `529`, like any 5xx, becomes `InternalServerError` / `TypeSafeInternalServerError` [docs: sdk/javascript/api/classes/RateLimitError] [docs: sdk/python/api/exceptions].

## 5. Model ids

| Name | Points to | Meaning |
| --- | --- | --- |
| `jev-latest` | `jev-1.13.0` | "The most recent stable, official release." The SDKs' default. |
| `jev-preview` | `jev-1.13.0` | The newest release, official or not. No preview build exists now. |
| `jev-1.13.0` | (itself) | The only versioned id the current docs name. |

Source: [docs: models].

- An alias "moves when a new release ships, so the answers behind it can change without a change on your side".
  If confidence thresholds are tuned against one version, "pin that version's ID instead of the alias" [docs: models].
  The confidence page also says thresholds "depend on your domain and the performance of the model" [docs: confidence].
- `GET /v1/models` "currently lists the aliases".
  Versioned ids "are accepted by the `model` field whether or not they appear in the list" [docs: models].
- A cookbook still names `jev-1.12` [docs: cookbooks/parallel_questions].
  The docs do not say whether older versions are still served or how long a pinned version stays available.
- The Python usage guide's model example passes `model="jev"` [docs: sdk/python/usage, "Choosing a model"].
  The models page does not list `jev` as a name, so it is not relied on here.

## 6. Latency

- "Most queries complete in about 100 ms. System One is fast enough for real-time request paths and user interfaces." [docs: concepts/how-to-build-with-system-one].
  The use-case map gives "real-time speeds (150ms)" [docs: concepts/use-case-map].
- One measured figure: a single call holding every question about a ~54,000-character article averaged 0.27 s.
  Sending the same questions one call at a time took 2.71 s in total [docs: cookbooks/parallel_questions].
  Adding questions to one request "barely changes the response time" [docs: primitives].
- These are TypeSafe's figures.
  The time to reach the API from the person's machine comes on top, and nothing was measured here.

## 7. Data handling

- **Training.** "Jev is not trained on customer requests or responses." [docs: models].
  It "is not fine-tuned or LoRA-adapted with customer data".
  The Privacy Policy says: "We will not train or fine tune any artificial intelligence or machine learning models on your prompts or other Input."
  The MCA says TypeSafe will not put Customer Data into a training dataset "without Customer's prior consent" [legal: MCA §4.1].
- **What counts as Input.** "any data, files, queries, and other materials that Customer … inputs or makes available" [legal: MCA §4.1].
  For Jev that is the whole request body: `state`, each question's `instructions` and `criteria`, and the question ids.
  The ids are "not sent to the underlying model", but they still reach TypeSafe's API in the body [docs: api].
- **Retention.** "We retain personal data about you for as long as reasonably necessary to provide you with the Services, or otherwise in support of our business or commercial purposes." [legal: Privacy Policy, Retention].
  The DPA says the same for personal data in requests [legal: DPA, Schedule I §8].
  TypeSafe is "under no obligation to store or retain Customer Data and may delete Customer Data at any time".
  Confidential information "may be retained in TypeSafe's standard backups" [legal: MCA §10.3].
- **Uses that outlast the contract.** TypeSafe may process Customer Data "in perpetuity … (i) to derive and generate Telemetry, (ii) to monitor for fraud and abuse of the Services, and (iii) as necessary to comply with applicable Laws" [legal: MCA §4.1].
  Telemetry includes "technical logs, hashes, summary statistics and classifications, metrics", and TypeSafe "may Process Telemetry without restriction" [legal: MCA §4.3].
- **Disclosure.** TypeSafe "will not disclose any Input to a third party other than our service providers" [legal: Privacy Policy].
  Subprocessors are listed at `trust.typesafe.ai/subprocessors` [legal: DPA §3.1].
  That page renders only in a browser and was not read.
- **Location.** "The Services are hosted in the United States" [legal: Privacy Policy, International Visitors].
- **Opting out.** Zero data retention is offered "for enterprise customers", by contacting `sales@typesafe.ai` [docs: legal].
  No self-serve setting that limits retention or logging is documented.

## 8. Key terms that bind a mod

- "Customer will ensure that each Customer User keeps the Access Credentials confidential and does not share them with anyone else.
  Customer is responsible for all actions taken in connection with … Access Credentials." [legal: MCA §2.4].
  The MCA counts the key among TypeSafe's Confidential Information [legal: MCA §14.1].
- The customer may build the API into its own applications for end users [legal: MCA §2.2].
  It may not "sell, lease, loan, distribute, sublicense, disclose, or otherwise offer or make the Services available as a standalone service" [legal: MCA §2.3(a)].
- A mod in this marketplace therefore relies on each person's own account and key.
  It never ships a key, never sends one person's key on another person's behalf, and never writes the key into the repository or a log.

## 9. Transport details found while probing

- **A trailing slash redirects to plain HTTP.** `POST https://api.typesafe.ai/v1/systemone/` and `GET https://api.typesafe.ai/v1/models/` both answered `307 Temporary Redirect` to `http://api.typesafe.ai/…` without the slash [probe].
  The plain-HTTP address then answers `301` back to `https` [probe].
  A client that follows redirects and is given a URL with a trailing slash can send the request body over plain HTTP.
  A 307 keeps the method and the body.
  Whether the `Authorization` header also goes depends on the client.
  A client should build the URL without a trailing slash and refuse redirects, which the global security rules already require.
- The JavaScript SDK passes no `redirect` option to `fetch`, so the runtime default applies [js: `TypeSafeClient` `attempt`].
  It strips trailing slashes from the base URL.
- The Python SDK sends `X-TypeSafe-Runtime` with the Python version, OS and CPU architecture.
  It also sends `User-Agent` and `X-TypeSafe-SDK` with its own version [py: `transport.prepare`].
  A mod that calls the HTTP API itself sends only what it sets.
- The OpenAPI document is public at `https://api.typesafe.ai/openapi.json`.
  It declares bearer authentication and lists only `200` and `422` responses for `POST /v1/systemone` and `GET /v1/models` [probe].

## 10. What this means for the open tickets

These are observations for the grilling tickets, not decisions.

### #85: where the Jev key lives

- `TYPESAFE_API_KEY` is the name both official SDKs read.
  A person who has set it for TypeSafe's SDKs already has it where a mod would look, and `$.env.get('TYPESAFE_API_KEY')` reads it by literal name.
- "Present" can follow the SDKs: the value is trimmed, non-empty, printable ASCII and free of whitespace.
  TypeSafe documents no prefix or length, so no stricter local check is grounded.
  Only the API can say a key is valid.
  In the probe a missing header got `403` and a made-up key got `401`, so a mod would treat both as "key problem".
- The MCA requires the key to stay confidential.
  It says nothing about how a key is stored, so the choice between an environment variable, `settings.json` `env` (a plain file) and a `sensitive` `userConfig` field is the project's own.
- Signups have been paused since 2026-09-22.
  A person may be unable to get a key at all, so the "no Jev" path is a normal state, not an edge case.
- Gateways reach Jev with their own keys and base URLs.
  If the contract allows them, the key's name is not `TYPESAFE_API_KEY` in that case.

### #87: precedence, and what may leave the machine

- Everything a mod puts in a Jev request reaches TypeSafe in the United States.
  That includes conversation text, prompts, file paths and repository content, placed in `state`, `instructions` or `criteria`.
  TypeSafe will not train on it without the account holder's consent.
  It may keep it as long as reasonably necessary and use it for telemetry, abuse monitoring and legal compliance with no end date.
  Zero data retention is only for enterprise customers.
  This weighs toward Laya for anything private, or toward a rule that limits what a mod may send to Jev.
- The SDK convention sends `TYPESAFE_API_KEY` to whatever `TYPESAFE_BASE_URL` names.
  If Laya or a gateway is reached by changing the base URL, the contract has to say where the Jev key may go.
  `https://api.typesafe.ai` is the only endpoint TypeSafe itself runs.
- Cost is per input token, mostly the `state`.
  Sending large repository content to hosted Jev costs more than sending a short summary, which bears on the map's open cost-and-rate budget.
- A client must build the endpoint without a trailing slash and refuse redirects (section 9).

## 11. Not verified

1. **Whether signups are open today.** The last TypeSafe word found is the pause of 2026-09-22 [x].
2. **Any free credit for new accounts.** Third-party write-ups report $5 per new account.
   No TypeSafe page, document or post read here states it.
3. **What the rate limits are scoped to** (key, account or organisation), and whether `429` and `529` responses always carry `retry-after`.
4. **The status returned when credits run out**, since the MCA says only that TypeSafe "may decline to generate Output".
5. **Whether pinned older versions** such as `jev-1.12` are still served, and how long a pinned version stays available.
6. **How long request content is actually kept** in logs or backups.
   The documents give only "as long as reasonably necessary".
7. **The subprocessor list** at `trust.typesafe.ai/subprocessors`, which renders only in a browser.
8. **The key's format** beyond the Python SDK's character check.
9. **Latency from this machine.** No call was made with a real key, so no figure here was measured locally.
10. **The Python SDK's redirect behaviour.** It builds an `httpx2` client without naming a redirect setting, and that library's default was not checked.

## Sources

- TypeSafe documentation, read as Markdown on 2026-10-05:
  [index](https://docs.typesafe.ai/llms.txt),
  [quick start](https://docs.typesafe.ai/introduction/quickstart.md),
  [models](https://docs.typesafe.ai/models.md),
  [API reference](https://docs.typesafe.ai/api.md),
  [legal](https://docs.typesafe.ai/legal.md),
  [confidence](https://docs.typesafe.ai/confidence.md),
  [how to build with TypeSafe](https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md),
  [use-case map](https://docs.typesafe.ai/concepts/use-case-map.md),
  [primitives](https://docs.typesafe.ai/primitives.md),
  [parallel questions cookbook](https://docs.typesafe.ai/cookbooks/parallel_questions.md),
  [Python SDK](https://docs.typesafe.ai/sdk/python.md),
  [Python usage](https://docs.typesafe.ai/sdk/python/usage.md),
  [Python constants](https://docs.typesafe.ai/sdk/python/api/constants.md),
  [Python exceptions](https://docs.typesafe.ai/sdk/python/api/exceptions.md),
  [Python retries](https://docs.typesafe.ai/sdk/python/api/retries.md),
  [JavaScript SDK](https://docs.typesafe.ai/sdk/javascript.md),
  [JavaScript `ENV`](https://docs.typesafe.ai/sdk/javascript/api/variables/ENV.md),
  [JavaScript `TypeSafeClientConfig`](https://docs.typesafe.ai/sdk/javascript/api/interfaces/TypeSafeClientConfig.md),
  [JavaScript `RetryPolicy`](https://docs.typesafe.ai/sdk/javascript/api/interfaces/RetryPolicy.md),
  [JavaScript `RateLimitError`](https://docs.typesafe.ai/sdk/javascript/api/classes/RateLimitError.md).
- TypeSafe legal documents:
  [Master Customer Agreement](https://typesafe.ai/legal/mca) (updated 2026-09-23),
  [Data Processing Addendum](https://typesafe.ai/legal/data-processing) (updated 2026-04-24),
  [Privacy Policy](https://typesafe.ai/legal/privacy-policy) (updated 2025-11-19),
  [Terms of Use](https://typesafe.ai/legal/terms) (updated 2026-09-19).
- SDK source:
  [typesafe-ai/typesafe-sdk-python](https://github.com/typesafe-ai/typesafe-sdk-python) (`typesafe-sdk` 0.7.2 on PyPI), modules `constants`, `_core/config`, `_core/retry`, `_core/transport`, `_core/client/sync/client`;
  [typesafe-ai/typesafe-sdk-js](https://github.com/typesafe-ai/typesafe-sdk-js) (`@typesafe-ai/sdk` 0.6.0 on npm), modules `src/env.ts`, `src/retry.ts`, `src/client.ts`.
- TypeSafe on X:
  [open to everyone, 2026-09-20](https://x.com/typesafeai/status/2101786156572823624),
  [signups paused, 2026-09-22](https://x.com/typesafeai/status/2102281508950307159).
- API probes on 2026-10-05: `GET /v1/models` with no key and with a made-up key, `POST /v1/systemone/` and `GET /v1/models/` with a trailing slash, `GET http://api.typesafe.ai/v1/models`, and `GET /openapi.json`.
