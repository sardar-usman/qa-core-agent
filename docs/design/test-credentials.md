# Test credentials: design brief

Decision (Oct 8, STATE.md phase item 3): login scenarios take their credentials from the host .env (`QA_CORE_TEST_USER` / `QA_CORE_TEST_PASS`), a dedicated account the client supplies. The agent never self-registers for a login and never types demo or fake credentials into a happy login.

## 1. Today

| Stage | Where the values come from | Reads the env? |
|---|---|---|
| Exploration | The model types them (`tools.ts`, fill handler). Toolshop's SRS names no account; run 5's model typed the demo account from memory (`events.jsonl`). | No |
| Replay, stability | The recorded value (`runStep`, `replay.ts`). | No |
| Emitted-spec check | The recorded happy login (`emittedCheckStage`, `credentialEnv`); `runPlaywright` deletes the parent's `QA_CORE_TEST_*`. | No |
| Emitted framework | `process.env` in `auth.setup` and the login spec, only for fills equal to the recorded happy login's values (`envForCredentialValue`, `auth-emit.ts`). `.env.example` seeds them for `isDemoHost` hosts (`renderEnvExample`). | Yes, at test time |
| Preflight | `scripts/preflight-site.ts --login`, manual; no run calls it. | Yes |

Three more facts:

- Everything keys on `findHappyLoginScenario` (`auth-emit.ts`), which requires `feature === 'login'`. Toolshop's map names the feature `account` (runs 5 and 6), so the auth setup, env substitution in the spec, and the happy-login part of `credentialSecrets` never activate there.
- No project stores credential names: no column in `projects` (`schema.sql`), no entry in `RUN_ENV_SETTINGS` (`explore-request.ts`). One host .env holds one pair.
- Replay, stability and the Explorer load `playwright/.auth/user.json` when present (`replayScenarioOnce`, `runtime.ts`), written by the repo's own `tests/auth.setup.ts` from a third set of names, `QA_CORE_AUTH_*`.

## 2. Missing credentials

New `src/agent/test-credentials.ts`: `readTestCredentials(env)` returns both values or null. With null, the runtime, after `plan()` and before the Explorer, records each scenario `needsTestAccount` flags as skipped (`test credentials not provided`) in the list `skip_scenario` writes, so `reconcile` counts it. `needsTestAccount` flags a happy login, a wrong-password negative and a duplicate-email negative. The plan line prints `N planned scenarios need the test account; credentials not provided`. The fill tool refuses an unmarked password fill in a login flow (section 9), so no demo or invented value reaches a happy login. `preflight-site --login` already exits 1 before any spend ("not both set; nothing was attempted"); its wording changes to `test credentials not provided`.

Open, owner to decide: authenticated pages beyond the login form (an account page, checkout). The Planner has no "needs login" tag today.

## 3. Wrong credentials

The login logic of `scripts/preflight-site.ts` moves to `src/agent/login-preflight.ts` (`preflightLogin`); the script becomes a wrapper. With credentials set, `explore()` calls it before the requirements map and the Planner, so a failure costs $0. LOGIN FAILED or PAGE NOT REACHED stops the run with one line: `Run stopped: the test account did not sign in (<page text verbatim>). Nothing was spent.` No fallback to recorded or demo values.

Open, owner to decide: whether that stop writes a run-report, and whether a flag may name the login URL when `LOGIN_PATHS` misses it.

## 4. D7 and lockout

The wrong-password negative fills the env user and a literal wrong password, so name and recording agree. `enforceFakeCredential` (`tools.ts`) stops rewriting the env user and still rewrites other known accounts (`knownAccounts`). "Account does not exist" becomes its own planned scenario, named so, with a generated identifier. `CREDENTIAL_STEERING` (`planner.ts`) is rewritten to say both.

Lockout. One wrong-password attempt per run conflicts with the pipeline: a shipped scenario executes at least six times (exploration, replay, three stability runs, the emitted check), up to about ten with an assertion retry, a repair and the emitted retry. With one attempt it cannot be verified. Recommended: count every wrong-password submit against the env user across all stages, print the count per stage, refuse a submit past a cap, and run `preflightLogin` once after the last one, so a lockout is a loud end-of-run line, not a silent failure next run. `lockoutScenarioNames` keeps its exemption for an SRS-named account; a lockout rule never runs against the env account (skipped: `would lock the test account`).

Open, owner to decide: the cap (six covers one clean pass; Toolshop's threshold is unknown), and whether one attempt with an unverified label is preferred.

## 5. R11, duplicate email

The duplicate-email negative fills the env user's email as the seed. `nonHappyCreationEmail` (`unique-data.ts`) already keeps a duplicate-named scenario literal. `enforceFakeCredential` does not: its `LOGIN_FLOW_RE` matches `\bauth\b` in the `/auth/register` URL inside `flowHint` (`fillGenerateKind`), and run 6's duplicate-email negative was rewritten that way (`identifierOverridden` at 12:31:46). Both rewrites skip a credential-marked fill.

## 6. Redaction

`credentialSecrets` (`datasets.ts`) already adds the env values when set. Three gaps remain:

- `redactSteps` masks fill steps only. A `toHaveValue` on the email field records the email (`fillValueForTarget`), and free text is never masked: run 5's zip ships the demo password twice in `run-report.json`, in a skip reason the model wrote.
- Spec substitution needs an `authLogin`, null for feature `account`, so a shipped Toolshop happy login would put its password in the spec.
- `events.jsonl`, `checkpoint.json` and the run directory's report keep raw values (invariant 43).

The PR closes the first two: emission by marker whatever the feature, and masking of every string equal to a secret in the zip copy and `droppedTraces`. The model passes a marker, never a value, so tool inputs carry none.

Open, owner to decide: whether the run directory's report and checkpoint mask too (local and gitignored, but served by `/api/runs/:id/artifacts`).

## 7. Run 5 and run 6, by name

Run 5 (51d535):

- "logged in with valid credentials and landed on the inventory page" (skipped, demo account rejected): env account; a failing one stops at preflight.
- "rejected login with a wrong password and stayed on the login page with an error message" (shipped, demo account): env user, counted.
- "rejected registration with an already-used email address" (dropped, unfunded): seeds the env email.

Run 6 (44cb3d):

- "logged in with valid credentials" (dropped at replay, "Invalid email or password"): env account, preflight first.
- "rejected login with wrong password and stayed on login page" (shipped, generated email): env user plus wrong password.
- "rejected registration with an already-used email address and error displayed" (skipped, generator override): R11 becomes automatable.
- The two forgot-password scenarios. Open, owner to decide: the env email (a reset mail to the client's account) or a generated one.

Plainly: run 5's happy login was its first login submit (`events.jsonl`), so in-run attempts do not explain it. A dedicated account removes one candidate cause, shared-account traffic. It does not claim to fix runs 5 and 6.

## 8. saucedemo

It goes through .env like any client; `isDemoHost` only seeds `.env.example`. With .env holding `standard_user` / `secret_sauce`, the happy login, empty-username and `locked_out_user` scenarios record the same values and emit byte-identical lines (the locked-out password already emits as an env reference because it equals the happy password). The wrong-password scenario changes on purpose: today a generated token then `standard_user` (D7); after, the env user once.

Open, owner to decide: one .env holds one pair, so Toolshop and saucedemo runs need the values swapped, or per-project names (a schema change).

## 9. The PR

`engine/test-credentials`, in order:

1. `test-credentials.ts`: `readTestCredentials`, `needsTestAccount`.
2. `login-preflight.ts`; the runtime calls it before the map and Planner.
3. The missing-credentials skip and its plan line.
4. The fill tool takes `credential: 'user' | 'pass'`, fills the env value and records the marker; it refuses an unmarked password in a login flow.
5. Replay and stability fill a marked step from the env, like `generate`.
6. `enforceFakeCredential` and the creation-email rule skip marked fills; the wrong-password counter.
7. The emitted check passes the env values.
8. Emitters and `findHappyLoginScenario` key on the marker, not the feature name.
9. Value-based masking of every string in the zip copy.

Locks: new `smoke-test-credentials` (skip with a balanced funnel, preflight stop with no model call on a local fixture, marker fill, replay from env, the counter); `smoke-unique-data` (R11 seed, D7 shape); `smoke-auth-emit` (feature `account`, tree grep for the env values); `smoke-dropped-traces` (free-text masking); `smoke-emitted-check` (child env); `smoke-plan-rule-tags` (steering, lockout rule).

Invariants changed: 14, 43, 44 (activation by marker), 54 and 56 (steering, the rewrite), 63 (the check's source); new invariant 70. It needs the saucedemo regression run (about $0.60): it touches login on both sites.

## 10. Risks, ranked

1. A credential leaks through free text or a non-fill step (run 5 did). Loud: before the zip, the tree and the report copy are grepped for the env values; a hit refuses the zip and names the file.
2. The wrong-password re-runs lock the client's account. Loud: the per-stage count, the cap refusal, the post-run preflight line.
3. The preflight misses the login page and stops a good run. Loud: it names every path tried.
4. Missing credentials shrink coverage quietly. Loud: one skip reason per scenario and the plan line.
5. `needsTestAccount` misses a login scenario, or the .env holds another site's account. Caught by the unmarked-password refusal and the preflight.
6. A stale `playwright/.auth/user.json` starts contexts logged in. Loud: the runtime prints when it loads one. Open, owner to decide: retire `QA_CORE_AUTH_*` and that file.
