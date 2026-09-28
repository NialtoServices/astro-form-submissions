# Dispatch Groups and Environment Checks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a site order its dispatchers into groups that run one after another, so a courtesy email can
never go out for a submission whose owner notification failed; and give sites a one-line way to fail loudly
and legibly when a Worker secret is missing. Ships as 0.2.0.

**Architecture:** `FormRouteConfig.dispatchers` accepts either today's flat list (one group, unchanged
behaviour) or a list of groups. The route normalises both into groups at construction, runs each group's
dispatchers concurrently, and stops before the next group once a `required` delivery has failed. A new
`requireEnv()` helper validates request-time bindings inside a lazy build and throws one `MissingEnvError`
naming every missing key; `defineLazyRoute` gains an `onError` option so that failure reaches the site's
reporter.

**Tech Stack:** TypeScript 6, Astro 7 (`APIRoute`), Vitest 4 (`expectTypeOf`, `vi`), pnpm 10 via corepack.

**Spec:** No separate spec document. The design was agreed in conversation on 2026-09-28 and is recorded
in full in the **Design** section below, which is the spec for this plan.

## Design

Background: in 0.1.1 every dispatcher starts at once (`Promise.all`, `src/route.ts:386`). When the owner
notification (`required`) fails but the acknowledgement (best-effort) succeeds, the sender is told the send
failed *and* emailed "we have received your request". A retry sends another acknowledgement and another
Discord ping, which the README currently documents as an accepted trade-off.

1. **Two accepted shapes.** `dispatchers: [a, b, c]` is one group: exactly today's behaviour.
   `dispatchers: [[a, b], [c]]` is two groups. The type is `Dispatcher[] | Dispatcher[][]`, so a mix of
   both shapes is a type error. An untyped caller that passes a mix gets a `TypeError` when
   `createFormRoute` is called (construction time), never at request time.
2. **Groups run in order; dispatchers within a group run concurrently.** A group starts only after every
   dispatcher in the previous group has settled.
3. **Only a failed `required` delivery stops the sequence.** After a group settles, if any `required`
   dispatcher in it (or an earlier one) failed, later groups do not run. A best-effort failure does not stop
   later groups. The failure itself is reported through `onError` as today; skipped groups are not reported.
4. **Skips stay skips.** A dispatcher withheld by quarantine or by `deliverWhen` returning `false` is neither
   a delivery nor a failure, and never stops a later group. A `deliverWhen` that *throws* is a failure (as
   today), so on a `required` dispatcher it stops later groups.
5. **Every existing rule counts across all groups:** a `required` failure returns 502; every attempted
   delivery failing returns 502; acquired resources roll back unless an exposing delivery succeeded (a
   dispatcher in a group that never ran did not deliver); the quarantine warning fires when no dispatcher in
   any group accepts quarantined submissions.
6. **Empty groups are allowed** and do nothing.
7. **`requireEnv(env, keys)`** returns the named values with `undefined`/`null` removed from their types, and
   throws `MissingEnvError` when any key is `undefined`, `null` or the empty string. The error's `keys`
   property lists every missing key in the order requested; its message names the keys and never a value.
   Non-string values (bindings such as a rate limiter) are accepted as present. The toolkit still reads no
   environment itself: the site passes its `env` in.
8. **`defineLazyRoute(build, { onError })`** calls `onError(error)` once per failed build (not once per
   request sharing that build), awaited and contained, then rethrows the original error. Without `onError`,
   behaviour is unchanged. A failed build is still not cached.

## Global Constraints

- Package manager: `pnpm@10.30.2` through corepack. Bare `pnpm` may not be on the shell's `PATH`; every
  command below uses `corepack pnpm`.
- CI runs, in order: `prettier --check .`, `lint`, `check`, `test`, `build`. All five must pass before each
  commit.
- Test charter (`tests/README.md`): test behaviour through the public route, stub only public interfaces
  (`Dispatcher`, `Inspector`, `Enricher`), never test private helpers directly, no snapshots.
- Type-level contracts are tested with `@ts-expect-error` and `expectTypeOf`; `corepack pnpm check` is what
  enforces them, so a typing test is only verified once `check` passes.
- Commit subjects: plain imperative, capitalised, no prefix, no trailing full stop, about 50 characters.
  End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- The flat-list form must keep every existing test in `tests/route.test.ts` passing unmodified.
- Documentation prose uses British English. Identifiers use American English (`normalize`, `summarize`),
  matching `summarizeError` in `src/route.ts`.
- Do not publish, tag or push. The release commit is the last step; publishing is the owner's call.

## Review Focus

1. **A group whose dispatchers are all skipped** (quarantine or `deliverWhen: false`) must not stop the next
   group. Test in Task 1 (`skips do not stop later groups`).
2. **A mixed config from an untyped caller** (`[a, [b]]`) must fail at construction with a clear message,
   not with "dispatch is not a function" on the first real submission. Test in Task 1.
3. **A throwing `deliverWhen` on a required dispatcher in group 1** must stop group 2, because it is a
   failure. Test in Task 1.
4. **An exposing dispatcher in a group that never ran** must not count as having exposed resources, so the
   uploads roll back. Test in Task 1.
5. **Concurrent first requests to a lazy route whose build fails** must report the failure once, not once
   per request. Test in Task 3.

---

### Task 1: Dispatch groups in the route

**Files:**
- Modify: `src/route.ts` (config type at 103-104, factory docblock at 147-153, dispatch loop at 383-421)
- Modify: `src/dispatchers/dispatcher.ts:35-43` (docblock only)
- Modify: `src/index.ts` (export the new type)
- Modify: `README.md` (lines 138-160 "How it works", 319-330 options table, 472-549 "Dispatchers", 636-665
  acknowledgement recipe)
- Test: `tests/route.test.ts` (new `describe('createFormRoute dispatch groups')` block at the end)
- Test: `tests/resources-typing.test.ts` (new `it` block)

**Interfaces:**
- Consumes: `Dispatcher<E, A>` from `src/dispatchers/dispatcher.ts` (unchanged).
- Produces: `export type DispatchGroup<E extends FormSubmission = FormSubmission, A = object> = Dispatcher<E, A>[]`
  in `src/route.ts`, exported from `src/index.ts`. `FormRouteConfig['dispatchers']` becomes
  `Dispatcher<Submission<S>, MergedProvided<Es>>[] | DispatchGroup<Submission<S>, MergedProvided<Es>>[]`.

- [ ] **Step 1: Install and generate sources**

Run:
```bash
cd ~/Developer/astro-form-submissions
corepack pnpm install --frozen-lockfile
node scripts/generate-email-template-sources.mjs
corepack pnpm exec vitest run
```
Expected: every existing test passes. If anything fails before a change is made, stop and report it.

- [ ] **Step 2: Write the failing behaviour tests**

Append to the end of `tests/route.test.ts`:

```ts
describe('createFormRoute dispatch groups', () => {
  /** A dispatcher whose delivery stays pending until the test settles it, so ordering is observable. */
  function deferredDispatcher(options: { required?: boolean } = {}) {
    let settle!: { resolve: () => void; reject: (error: Error) => void }
    const delivery = new Promise<void>((resolve, reject) => {
      settle = { resolve, reject }
    })
    const dispatch = vi.fn((_submission: FormSubmission, _context: DispatchContext) => delivery)
    const dispatcher: Dispatcher = { required: options.required, dispatch }
    return { dispatcher, dispatch, resolve: () => settle.resolve(), reject: (error: Error) => settle.reject(error) }
  }

  /** Lets every queued promise callback run, so a group that was going to start has started. */
  const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('runs a group concurrently and starts the next only once every dispatcher in it has settled', async () => {
    const first = deferredDispatcher()
    const sibling = deferredDispatcher()
    const later = stubDispatcher()

    const pending = createFormRoute({
      ...baseConfig,
      dispatchers: [[first.dispatcher, sibling.dispatcher], [later.dispatcher]]
    })(contextFor(validForm()))

    await flushPromises()
    expect(first.dispatch).toHaveBeenCalledOnce()
    expect(sibling.dispatch).toHaveBeenCalledOnce()

    first.resolve()
    await flushPromises()
    expect(later.dispatch).not.toHaveBeenCalled()

    sibling.resolve()
    const response = await pending
    expect(response.status).toBe(200)
    expect(later.dispatch).toHaveBeenCalledOnce()
  })

  it('a required failure skips every later group and returns 502', async () => {
    const onError = vi.fn()
    const notification = stubDispatcher({ required: true, failWith: new Error('recipient inactive') })
    const acknowledgement = stubDispatcher()
    const followUp = stubDispatcher()

    const response = await createFormRoute({
      ...baseConfig,
      dispatchers: [[notification.dispatcher], [acknowledgement.dispatcher], [followUp.dispatcher]],
      onError
    })(contextFor(validForm()))

    expect(response.status).toBe(502)
    expect(acknowledgement.dispatch).not.toHaveBeenCalled()
    expect(followUp.dispatch).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { stage: 'delivery' })
  })

  it('still runs the rest of a group when a required sibling in it fails', async () => {
    const notification = stubDispatcher({ required: true, failWith: new Error('recipient inactive') })
    const operatorPing = stubDispatcher()
    const acknowledgement = stubDispatcher()

    const response = await createFormRoute({
      ...baseConfig,
      dispatchers: [[notification.dispatcher, operatorPing.dispatcher], [acknowledgement.dispatcher]]
    })(contextFor(validForm()))

    expect(response.status).toBe(502)
    expect(operatorPing.dispatch).toHaveBeenCalledOnce()
    expect(acknowledgement.dispatch).not.toHaveBeenCalled()
  })

  it('a best-effort failure does not stop later groups', async () => {
    const onError = vi.fn()
    const operatorPing = stubDispatcher({ failWith: new Error('discord down') })
    const notification = stubDispatcher({ required: true })

    const response = await createFormRoute({
      ...baseConfig,
      dispatchers: [[operatorPing.dispatcher], [notification.dispatcher]],
      onError
    })(contextFor(validForm()))

    expect(response.status).toBe(200)
    expect(notification.dispatch).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { stage: 'delivery' })
  })

  it('skips do not stop later groups', async () => {
    const withheld = stubDispatcher({ required: true, deliverWhen: () => false })
    const quarantineSkipped = stubDispatcher({ required: true })
    const ops = stubDispatcher({ acceptsQuarantined: true })

    const response = await createFormRoute({
      ...baseConfig,
      inspectors: [{ inspect: async () => ({ action: 'quarantine' as const, reason: 'spam' }) }],
      dispatchers: [[withheld.dispatcher], [quarantineSkipped.dispatcher], [ops.dispatcher]]
    })(contextFor(validForm()))

    expect(response.status).toBe(200)
    expect(withheld.dispatch).not.toHaveBeenCalled()
    expect(quarantineSkipped.dispatch).not.toHaveBeenCalled()
    expect(ops.dispatch).toHaveBeenCalledOnce()
  })

  it('a throwing deliverWhen on a required dispatcher stops later groups', async () => {
    const predicateFailure = stubDispatcher({
      required: true,
      deliverWhen: () => {
        throw new Error('predicate boom')
      }
    })
    const later = stubDispatcher()

    const response = await createFormRoute({
      ...baseConfig,
      dispatchers: [[predicateFailure.dispatcher], [later.dispatcher]]
    })(contextFor(validForm()))

    expect(response.status).toBe(502)
    expect(later.dispatch).not.toHaveBeenCalled()
  })

  it('every attempted delivery failing across groups → 502 with no required dispatcher', async () => {
    const first = stubDispatcher({ failWith: new Error('discord down') })
    const second = stubDispatcher({ failWith: new Error('webhook revoked') })

    const response = await createFormRoute({
      ...baseConfig,
      dispatchers: [[first.dispatcher], [second.dispatcher]]
    })(contextFor(validForm()))

    expect(response.status).toBe(502)
    expect(second.dispatch).toHaveBeenCalledOnce()
  })

  it('rolls back resources when the only exposing dispatcher sat in a group that never ran', async () => {
    const rolledBack: string[] = []
    const enricher = {
      enrich: vi.fn(async () => ({
        provide: { files: [] },
        rollback: async () => void rolledBack.push('files')
      }))
    }
    const notification = stubDispatcher({
      required: true,
      exposesResources: false,
      failWith: new Error('recipient inactive')
    })
    const attachmentEmail = stubDispatcher({ exposesResources: true })

    const response = await createFormRoute({
      ...baseConfig,
      enrichers: [enricher],
      dispatchers: [[notification.dispatcher], [attachmentEmail.dispatcher]]
    })(contextFor(validForm()))

    expect(response.status).toBe(502)
    expect(attachmentEmail.dispatch).not.toHaveBeenCalled()
    expect(rolledBack).toEqual(['files'])
  })

  it('warns about a quarantine only when no dispatcher in any group accepts it', async () => {
    const quarantine = { inspect: async () => ({ action: 'quarantine' as const }) }

    const warned = vi.fn()
    await createFormRoute({
      ...baseConfig,
      inspectors: [quarantine],
      dispatchers: [[stubDispatcher().dispatcher], [stubDispatcher().dispatcher]],
      onError: warned
    })(contextFor(validForm()))
    expect(warned).toHaveBeenCalledOnce()
    expect(warned).toHaveBeenCalledWith(expect.any(Error), { stage: 'unexpected' })

    const quiet = vi.fn()
    await createFormRoute({
      ...baseConfig,
      inspectors: [quarantine],
      dispatchers: [[stubDispatcher().dispatcher], [stubDispatcher({ acceptsQuarantined: true }).dispatcher]],
      onError: quiet
    })(contextFor(validForm()))
    expect(quiet).not.toHaveBeenCalled()
  })

  it('allows empty groups', async () => {
    const only = stubDispatcher()

    const response = await createFormRoute({ ...baseConfig, dispatchers: [[], [only.dispatcher], []] })(
      contextFor(validForm())
    )

    expect(response.status).toBe(200)
    expect(only.dispatch).toHaveBeenCalledOnce()
  })

  it('refuses a mix of dispatchers and groups when the route is built, not on the first submission', () => {
    const single = stubDispatcher()
    const grouped = stubDispatcher()

    // An untyped caller can reach this; the type forbids it (see resources-typing.test.ts).
    const mixed = [single.dispatcher, [grouped.dispatcher]] as unknown as Dispatcher[]

    expect(() => createFormRoute({ ...baseConfig, dispatchers: mixed })).toThrow(TypeError)
    expect(() => createFormRoute({ ...baseConfig, dispatchers: mixed })).toThrow(/mix of dispatchers and groups/)
  })
})
```

- [ ] **Step 3: Write the failing type tests**

Add to `tests/resources-typing.test.ts`, inside the existing `describe('resource threading types')`, after the
first `it`:

```ts
  it('checks every dispatcher in every group against what the enrichers provide', () => {
    // Happy: groups of correctly typed dispatchers.
    createFormRoute({ schema, enrichers: [filesEnricher], dispatchers: [[needsFiles], [needsNothing]] })

    // Mismatch inside a later group is still caught.
    createFormRoute({
      schema,
      enrichers: [filesEnricher],
      // @ts-expect-error a grouped dispatcher reading `attachments` has no enricher providing it
      dispatchers: [[needsFiles], [needsAttachments]]
    })

    // A mix of the flat and grouped shapes is rejected.
    createFormRoute({
      schema,
      // @ts-expect-error dispatchers must be all dispatchers or all groups
      dispatchers: [needsNothing, [needsNothing]]
    })
  })
```

If `tsc` reports either error on the inner element's line rather than on the `dispatchers:` line, move that
`@ts-expect-error` to the line `tsc` names. The directive must sit directly above the reported line.

- [ ] **Step 4: Run the tests to see them fail**

Run: `corepack pnpm exec vitest run tests/route.test.ts -t "dispatch groups"`
Expected: FAIL. The ordering tests fail because every dispatcher starts at once; the nested-array tests throw
`dispatcher.dispatch is not a function` or equivalent; the mix test fails because nothing throws.

Run: `corepack pnpm check`
Expected: FAIL. Nested arrays are not assignable to `Dispatcher[]`, and the two `@ts-expect-error` lines may
report as unused.

- [ ] **Step 5: Widen the config type**

In `src/route.ts`, add above `export interface FormRouteConfig` (after `MergedProvided`):

```ts
/**
 * Dispatchers that deliver concurrently. Groups in {@link FormRouteConfig.dispatchers} run one after another,
 * and a failed `required` delivery ends the sequence, so a later group can depend on an earlier one having
 * landed (e.g. an acknowledgement only once the owner has the submission).
 */
export type DispatchGroup<E extends FormSubmission = FormSubmission, A = object> = Dispatcher<E, A>[]
```

Add `import type { FormSubmission } from '#pipeline.js'` to the imports if it is not already reachable.

Replace the `dispatchers` property (lines 103-104) with:

```ts
  /**
   * Destinations run after the enrichers (e.g. email, a chat webhook): either a flat list, which runs
   * concurrently as one group, or a list of {@link DispatchGroup}s, which run in order. A failed `required`
   * delivery stops later groups. A quarantined submission reaches only those with `acceptsQuarantined`.
   */
  dispatchers?:
    | Dispatcher<Submission<S>, MergedProvided<Es>>[]
    | DispatchGroup<Submission<S>, MergedProvided<Es>>[]
```

- [ ] **Step 6: Normalise the config into groups at construction**

In `src/route.ts`, add below `summarizeError`:

```ts
/**
 * The configured dispatchers as ordered groups: a flat list is one group, a list of groups is itself. A mix
 * is a misconfiguration the types forbid; an untyped caller learns about it when the route is built rather
 * than on a live submission.
 */
function dispatchGroupsFrom<D>(dispatchers: readonly (D | readonly D[])[]): (readonly D[])[] {
  const groupCount = dispatchers.filter((entry) => Array.isArray(entry)).length
  if (groupCount === 0) return [dispatchers as readonly D[]]
  if (groupCount === dispatchers.length) return dispatchers as (readonly D[])[]

  throw new TypeError(
    '`dispatchers` must be a list of dispatchers or a list of dispatch groups, not a mix of dispatchers and groups.'
  )
}
```

In `createFormRoute`, directly after the `report` helper and before `return async (context) => {`, add:

```ts
  const dispatchGroups = dispatchGroupsFrom<Dispatcher<Submission<S>, MergedProvided<Es>>>(config.dispatchers ?? [])
```

The explicit type argument matters: inferring `D` from the `Dispatcher[] | DispatchGroup[]` union can widen
it to the union itself.

- [ ] **Step 7: Run the groups in order**

Replace lines 383-410 (from `let succeeded = 0` through the closing `)` of `await Promise.all(`) with:

```ts
      let succeeded = 0
      let failed = 0
      let requiredFailed = false
      for (const group of dispatchGroups) {
        await Promise.all(
          group.map(async (dispatcher) => {
            // A quarantined submission is withheld from every destination that hasn't opted in. The skip
            // is a no-op — not a success or failure — so a fully quarantined submission still returns 200.
            if (quarantined && !dispatcher.acceptsQuarantined) return

            try {
              // A per-submission opt-out (e.g. no acknowledgement without a recipient). Evaluated inside
              // the try so a throwing predicate is a delivery failure, not an uncaught rejection; a `false`
              // verdict is a no-op skip — the early return counts as neither delivered nor failed.
              if (dispatcher.deliverWhen && !dispatcher.deliverWhen(submission, dispatchContext)) return

              await dispatcher.dispatch(submission, dispatchContext)
              succeeded += 1

              // A resolved dispatch is a real delivery; unless it declares it doesn't carry the acquired
              // resources, treat it as having exposed them to a recipient.
              if (dispatcher.exposesResources !== false) resourcesExposed = true
            } catch (error) {
              await report(error, 'delivery')
              failed += 1
              if (dispatcher.required) requiredFailed = true
            }
          })
        )

        // A later group may depend on this one having landed (an acknowledgement promises the owner has
        // the submission), so a failed required delivery ends dispatch; the sender's retry then reaches
        // no later group twice.
        if (requiredFailed) break
      }
```

Replace the quarantine-warning condition (was line 414) with:

```ts
      if (quarantined && !dispatchGroups.some((group) => group.some((dispatcher) => dispatcher.acceptsQuarantined === true))) {
```

Let prettier reflow that line in Step 10.

- [ ] **Step 8: Run the tests to see them pass**

Run: `corepack pnpm exec vitest run tests/route.test.ts`
Expected: PASS, including every pre-existing test.

Run: `corepack pnpm check`
Expected: PASS. If a `@ts-expect-error` from Step 3 reports as unused, the error landed on another line:
move the directive as Step 3 describes and re-run.

- [ ] **Step 9: Update the docs**

In `src/route.ts`, change the factory docblock's first sentence (line 148-149) to:

```ts
 * Builds the `POST` handler for a form endpoint: guards (pre-body) → schema validate →
 * inspectors (in order) → enrichers (in order) → dispatchers (concurrently, in groups run in order).
```

In `src/dispatchers/dispatcher.ts`, change lines 36-37 to:

```ts
 * A destination a submission is delivered to (e.g. an email, a chat webhook). Dispatchers in one group
 * run concurrently, and groups run in order; each decides its own delivery policy from the {@link DispatchContext}.
```

In `src/index.ts`, add `type DispatchGroup,` to the `#route.js` export list, alphabetically after
`defineLazyRoute`.

In `README.md`:
- Line 142: replace `**dispatchers** (in parallel)` with `**dispatchers** (concurrently, or in groups run in
  order)`. Line 160: replace `delivers (in parallel, terminal)` with `delivers (concurrently within a group,
  groups in order, terminal)`.
- Options table, `dispatchers` row (line 327): `Delivery destinations: a flat list runs concurrently; a list of
  groups runs in order, and a failed required delivery stops later groups. A quarantined submission reaches
  only those with acceptsQuarantined.` Keep the table's column padding consistent; prettier will realign it.
- "Dispatchers" section, line 474: replace `All dispatchers run in parallel.` with `A flat list of dispatchers
  runs concurrently; see [Dispatch groups](#dispatch-groups) to order them.`
- Replace the note at lines 547-549 ("Note: because dispatchers run in parallel…") with this new subsection:

````md
### Dispatch groups

Pass a list of groups instead of a flat list when one delivery depends on another. Dispatchers within a
group run concurrently; each group starts once the previous one has settled. If a `required` delivery
fails, no later group runs: the sender gets the 502, and their retry reaches the later groups once.

```ts
dispatchers: [
  [ownerNotification, operatorPing], // together
  [acknowledgement] // only once the owner notification has been delivered
]
```

Only a failed `required` delivery stops the sequence. A best-effort failure, or a destination skipped by
quarantine or `deliverWhen`, lets the next group run. The other rules count across every group: a
`required` failure or a total failure returns 502, uploads roll back unless an exposing delivery
succeeded, and a quarantine that no group accepts is reported. A flat list is a single group, so it
behaves exactly as it always has. Mixing the two shapes is a type error, and a `TypeError` when the route
is built.

Put a destination beside the delivery it should not depend on. Above, the operator ping shares the first
group, so it still fires when the owner notification fails: often the moment it matters most.
````

- Acknowledgement recipe (lines 660-663): replace `It runs in parallel with your inbox notification — **no
  pipeline change, just another dispatcher**.` with `Put it in a group after your inbox notification
  (see [Dispatch groups](#dispatch-groups)), so a sender is never thanked for a submission that failed to
  reach you.` Leave the rest of that paragraph as it is.

- [ ] **Step 10: Verify and commit**

Run:
```bash
corepack pnpm format
corepack pnpm exec prettier --check .
corepack pnpm lint
corepack pnpm check
corepack pnpm test
corepack pnpm build
```
Expected: all pass.

```bash
git add src/route.ts src/dispatchers/dispatcher.ts src/index.ts README.md tests/route.test.ts tests/resources-typing.test.ts
git commit -F - <<'EOF'
Run dispatchers in groups that settle in order

A flat list starts every dispatcher at once, so a failed owner
notification could still send the sender an acknowledgement, and a
retry sent it again. Groups let a site make a delivery wait for the
ones it depends on; a flat list keeps today's behaviour.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 2: `requireEnv` and `MissingEnvError`

**Files:**
- Create: `src/env.ts`
- Modify: `src/index.ts` (export both)
- Modify: `README.md` (lines 231-254 Cloudflare example, 992-1003 "Secrets")
- Test: `tests/env.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `export class MissingEnvError extends Error { readonly keys: readonly string[] }`
  - `export function requireEnv<Env extends object, const K extends keyof Env & string>(env: Env, keys: readonly K[]): { [P in K]-?: Exclude<Env[P], undefined | null> }`

- [ ] **Step 1: Write the failing tests**

Create `tests/env.test.ts`:

```ts
import { MissingEnvError, requireEnv } from '#env.js'
import { describe, expect, expectTypeOf, it } from 'vitest'

interface SiteEnv {
  POSTMARK_TOKEN?: string
  TURNSTILE_SECRET_KEY?: string
  DISCORD_WEBHOOK_URL?: string
  CONTACT_LIMITER?: { limit: (options: { key: string }) => Promise<{ success: boolean }> }
}

const limiter = { limit: async () => ({ success: true }) }

describe('requireEnv', () => {
  it('returns the requested values, typed as present', () => {
    const env: SiteEnv = { POSTMARK_TOKEN: 'pm-token', TURNSTILE_SECRET_KEY: 'ts-secret', CONTACT_LIMITER: limiter }

    const values = requireEnv(env, ['POSTMARK_TOKEN', 'CONTACT_LIMITER'])

    expect(values).toEqual({ POSTMARK_TOKEN: 'pm-token', CONTACT_LIMITER: limiter })
    expectTypeOf(values.POSTMARK_TOKEN).toEqualTypeOf<string>()
    expectTypeOf(values.CONTACT_LIMITER).toEqualTypeOf<NonNullable<SiteEnv['CONTACT_LIMITER']>>()
  })

  it('names every missing key, in the order requested, and no value', () => {
    const env: SiteEnv = { TURNSTILE_SECRET_KEY: 'ts-secret' }

    let thrown: unknown
    try {
      requireEnv(env, ['POSTMARK_TOKEN', 'TURNSTILE_SECRET_KEY', 'DISCORD_WEBHOOK_URL'])
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(MissingEnvError)
    const error = thrown as MissingEnvError
    expect(error.name).toBe('MissingEnvError')
    expect(error.keys).toEqual(['POSTMARK_TOKEN', 'DISCORD_WEBHOOK_URL'])
    expect(error.message).toBe('Missing required environment values: POSTMARK_TOKEN, DISCORD_WEBHOOK_URL')
    expect(error.message).not.toContain('ts-secret')
  })

  it('uses the singular for one missing key', () => {
    expect(() => requireEnv({} as SiteEnv, ['POSTMARK_TOKEN'])).toThrow(
      'Missing required environment value: POSTMARK_TOKEN'
    )
  })

  it('treats an empty string and null as missing', () => {
    const env = { POSTMARK_TOKEN: '', TURNSTILE_SECRET_KEY: null } as unknown as SiteEnv

    expect(() => requireEnv(env, ['POSTMARK_TOKEN', 'TURNSTILE_SECRET_KEY'])).toThrow(
      'Missing required environment values: POSTMARK_TOKEN, TURNSTILE_SECRET_KEY'
    )
  })

  it('only accepts keys the env declares', () => {
    const env: SiteEnv = { POSTMARK_TOKEN: 'pm-token' }

    // @ts-expect-error `POSTMARK_TOKNE` is not a key of the env
    expect(() => requireEnv(env, ['POSTMARK_TOKNE'])).toThrow(MissingEnvError)
  })
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `corepack pnpm exec vitest run tests/env.test.ts`
Expected: FAIL, cannot resolve `#env.js`.

- [ ] **Step 3: Implement**

Create `src/env.ts`:

```ts
/**
 * A required request-time value (a secret, variable or binding) is absent. Carries the missing `keys` and
 * names them in the message, but never a value, so it is safe to log in full.
 */
export class MissingEnvError extends Error {
  // MARK: - Object Lifecycle

  constructor(readonly keys: readonly string[]) {
    super(`Missing required environment ${keys.length === 1 ? 'value' : 'values'}: ${keys.join(', ')}`)
    this.name = 'MissingEnvError'
  }
}

/**
 * Reads the named values from a site's `env` (on Cloudflare, the `cloudflare:workers` binding), throwing one
 * {@link MissingEnvError} naming every key that is `undefined`, `null` or empty. Call it at the top of a
 * {@link defineLazyRoute} build, so a secret lost in a rotation or a new environment fails the build with
 * its name rather than surfacing as a provider's error, or as "verification failed" to the sender.
 *
 * The toolkit still reads no environment of its own: the site passes `env` in.
 */
export function requireEnv<Env extends object, const K extends keyof Env & string>(
  env: Env,
  keys: readonly K[]
): { [P in K]-?: Exclude<Env[P], undefined | null> } {
  const missing = keys.filter((key) => {
    const value: unknown = env[key]
    return value === undefined || value === null || value === ''
  })
  if (missing.length > 0) throw new MissingEnvError(missing)

  return Object.fromEntries(keys.map((key) => [key, env[key]])) as { [P in K]-?: Exclude<Env[P], undefined | null> }
}
```

In `src/index.ts`, add after the `#route.js` export block:

```ts
export { MissingEnvError, requireEnv } from '#env.js'
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `corepack pnpm exec vitest run tests/env.test.ts && corepack pnpm check`
Expected: PASS, and `check` confirms the `@ts-expect-error` and `expectTypeOf` assertions.

- [ ] **Step 5: Update the README**

In the Cloudflare example (README lines 239-253), replace the code block with:

```ts
import { createFormRoute, defineLazyRoute, requireEnv } from '@nialto-services/astro-form-submissions'

export const POST = defineLazyRoute(async () => {
  const { env } = await import('cloudflare:workers')
  const secrets = requireEnv(env, ['TURNSTILE_SECRET_KEY', 'POSTMARK_TOKEN', 'POSTMARK_FROM', 'POSTMARK_TO'])
  return createFormRoute({
    schema,
    inspectors: [
      new HoneypotInspector({ fieldName: 'website' }),
      new TurnstileInspector({ secretKey: secrets.TURNSTILE_SECRET_KEY })
    ]
    // …dispatchers, reading secrets.POSTMARK_TOKEN, secrets.POSTMARK_FROM, …
  })
})
```

and add after the paragraph before it (ending "…identical to above:"), a sentence placed before the code block:
`` `requireEnv` fails the build with one `MissingEnvError` naming every absent key, so a secret lost in a
rotation or a new environment is named in the logs instead of surfacing as a provider's error or, for
Turnstile, as "verification failed" to every sender. ``

In "Secrets" (line 994), after the first paragraph, add:
`` Validate them where you read them: `requireEnv(env, [...keys])` returns the values typed as present and
throws a `MissingEnvError` listing every key that is absent or empty (never a value, so it is safe to log).
Leave optional ones, such as a Discord webhook, out of the list. ``

- [ ] **Step 6: Verify and commit**

Run the six commands from Task 1 Step 10. Expected: all pass.

```bash
git add src/env.ts src/index.ts README.md tests/env.test.ts
git commit -F - <<'EOF'
Add requireEnv for request-time secrets

A missing secret surfaced as a provider's own error, or for Turnstile
as a verification failure the sender took for their own mistake.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 3: Report failed lazy builds

**Files:**
- Modify: `src/route.ts:449-483` (`defineLazyRoute`)
- Modify: `README.md` (the Cloudflare paragraph above the example, lines 233-237)
- Test: `tests/route.test.ts` (`describe('defineLazyRoute')`, lines 1137-1182)

**Interfaces:**
- Consumes: `MissingEnvError` is the typical error but is not referenced; `onError` receives `unknown`.
- Produces: `export interface LazyRouteOptions { onError?: (error: unknown) => void | Promise<void> }`, exported
  from `src/index.ts`; `defineLazyRoute(build, options?: LazyRouteOptions): APIRoute`.

- [ ] **Step 1: Write the failing tests**

Add inside `describe('defineLazyRoute')` in `tests/route.test.ts`:

```ts
  it('reports a failed build to onError and still rejects with the original error', async () => {
    const onError = vi.fn()
    const failure = new Error('POSTMARK_TOKEN missing')
    const route = defineLazyRoute(
      () => {
        throw failure
      },
      { onError }
    )

    await expect(route(contextFor(validForm()))).rejects.toBe(failure)
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure)
  })

  it('reports a failed build once for all the requests that shared it', async () => {
    const onError = vi.fn()
    let rejectBuild!: (error: Error) => void
    const build = vi.fn(
      () =>
        new Promise<APIRoute>((_resolve, reject) => {
          rejectBuild = reject
        })
    )
    const route = defineLazyRoute(build, { onError })

    const inFlight = [route(contextFor(validForm())), route(contextFor(validForm()))]
    rejectBuild(new Error('env not ready'))
    const results = await Promise.allSettled(inFlight)

    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected'])
    expect(onError).toHaveBeenCalledOnce()
  })

  it('a throwing onError cannot replace the build failure, and the next request still retries', async () => {
    const failure = new Error('env not ready')
    const build = vi
      .fn<() => APIRoute>()
      .mockImplementationOnce(() => {
        throw failure
      })
      .mockImplementation(() => async () => new Response('ok'))
    const route = defineLazyRoute(build, {
      onError: async () => {
        throw new Error('reporter down')
      }
    })

    await expect(route(contextFor(validForm()))).rejects.toBe(failure)

    const response = await route(contextFor(validForm()))
    expect(await response.text()).toBe('ok')
  })
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `corepack pnpm exec vitest run tests/route.test.ts -t defineLazyRoute`
Expected: FAIL, `onError` never called (and `check` rejects the second argument).

- [ ] **Step 3: Implement**

In `src/route.ts`, add above `defineLazyRoute`'s docblock:

```ts
/** Options for {@link defineLazyRoute}. */
export interface LazyRouteOptions {
  /**
   * Called once per failed build (however many requests were waiting on it), before the error is rethrown.
   * A build fails before the route's own `onError` exists, so this is where it reaches your reporter.
   * Awaited and contained: a reporter that throws cannot replace the build's error.
   */
  onError?: (error: unknown) => void | Promise<void>
}
```

Replace the function (lines 471-483) with:

```ts
export function defineLazyRoute(build: () => APIRoute | Promise<APIRoute>, options: LazyRouteOptions = {}): APIRoute {
  let cached: Promise<APIRoute> | undefined
  return (context) => {
    const pending = (cached ??= Promise.resolve()
      .then(build)
      .catch(async (error) => {
        // Clear the slot so a construction failure retries on the next request instead of being cached.
        cached = undefined

        try {
          await options.onError?.(error)
        } catch {
          // Nowhere left to report a broken reporter; the build's own error is what the caller must see.
        }
        throw error
      }))
    return pending.then((route) => route(context))
  }
}
```

Add to the end of the existing docblock (before its closing `*/`):

```ts
 *
 * Pass `onError` to report a failed build: it runs before the route exists, so the route's own `onError`
 * never sees it. Pair it with {@link requireEnv} so a missing secret is reported by name.
```

In `src/index.ts`, add `type LazyRouteOptions,` to the `#route.js` export list after `type FormRouteConfig,`.

- [ ] **Step 4: Run the tests to see them pass**

Run: `corepack pnpm exec vitest run tests/route.test.ts -t defineLazyRoute && corepack pnpm check`
Expected: PASS, including the three existing `defineLazyRoute` tests.

- [ ] **Step 5: Update the README**

In the Cloudflare paragraph (lines 233-237), after "…so you don't hand-write the `let route; route ??= …`
singleton." add: `` Give it `{ onError }` to report a build that throws: the build runs before the route's own
`onError` exists. ``

Add `{ onError: (error) => console.error('Contact form build error:', error) }` as the second argument to the
`defineLazyRoute` call in the example Task 2 wrote, so the call closes with `}, { onError: … })`.

- [ ] **Step 6: Verify and commit**

Run the six commands from Task 1 Step 10. Expected: all pass.

```bash
git add src/route.ts src/index.ts README.md tests/route.test.ts
git commit -F - <<'EOF'
Report a failed lazy build through onError

A build fails before the route's reporter exists, so a missing secret
reached only the host's generic error log.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 4: Release 0.2.0

**Files:**
- Modify: `package.json` (`version`)

- [ ] **Step 1: Bump the version**

Change `"version": "0.1.1"` to `"version": "0.2.0"` in `package.json`. Groups are additive, but a minor bump
signals the new public exports (`DispatchGroup`, `requireEnv`, `MissingEnvError`, `LazyRouteOptions`) and
the changed README guidance on acknowledgements.

- [ ] **Step 2: Verify and commit**

Run the six commands from Task 1 Step 10. Expected: all pass.

```bash
git add package.json
git commit -F - <<'EOF'
Release 0.2.0

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

Do not tag, push or publish. CI verifies that a `v*` tag matches `package.json`, so the owner tags
`v0.2.0` when they publish.
