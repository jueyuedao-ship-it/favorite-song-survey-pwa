# Semantic Tag Candidate Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve automatic song-tag recall by replacing per-tag lexical exclusion with evidence-supported category candidates, while preserving exact-song provenance, quote validation, semantic guards, and the existing 12-tag cap.

**Architecture:** Keep the existing research pipeline and JSON-schema restriction. Refactor descriptor research into seven user-visible categories; use broad category cues to decide which tag categories may reach the LLM; retain seed regexes for direct evidence rather than candidate exclusion; validate semantic selections against category context, explicit reasoning, negation/hedging guards, and existing recording-scoped evidence checks.

**Tech Stack:** TypeScript 5.9, Vitest 4, Cloudflare Workers/Wrangler, existing Groq JSON-schema inference and Tavily research pipeline.

**Spec:** `../specs/2026-10-05-semantic-tag-candidates-design.md`

## Global Constraints

- Change only automatic tag enrichment and descriptor research behavior in `worker/src/research/providers.ts`, `worker/src/research/runner.ts`, and associated worker tests unless a test proves a narrowly related contract change is required.
- Do not change the tag dictionary, manual overrides, administrator locks, recording identity rules, source-association rules, credit validation rules, public UI/API contracts, or the 12-tag maximum.
- Keep `linkedDescriptionRecording()` and exact-song / official-release association as the provenance boundary for descriptive evidence.
- `seedTagSignals` may prove direct lexical evidence, but absence of a seed-regex match must not exclude an otherwise evidence-supported category from model inference.
- Category cues identify only a category; they must not deterministically map a cue such as `quirky`, `jaunty`, or `rapid` to a specific tag.
- Keep the response `tag_id.enum` allowlist. It must contain only IDs from categories supported by recording-scoped evidence.
- Semantic inference requires a retained exact quote, category-compatible evidence, substantive tag/criterion-linked reasoning, no unsupported negation or hedge, and all existing source/recording validation.
- Lyrics must not establish non-lyric mood/energy tags. Bare vocalist credits must not establish voice impression.
- Keep the current request budget and evidence-pruning fallback. Do not increase model token limits unless a regression test demonstrates it is necessary.
- Implement each task with TDD: add/adjust a failing test, run it and confirm RED for the intended reason, implement the minimum production change, rerun to GREEN, then commit.

## Review Focus

- Broad category cues may overlap (`rapid`, `groove`, `upbeat`); overlap may widen candidates but must not itself accept a specific tag.
- Negated descriptions such as `not fast` or `not energetic` must not survive as positive semantic tags.
- A paragraph discussing lyrics and emotional words must not become musical mood evidence unless it separately describes the song/music property.
- A singer/vocalist credit may support voice structure under the existing explicit-credit rule, but must not prove `透明感`, `力強い歌声`, `ハスキー`, etc.
- When several categories are present, `fitInferenceRequest()` must keep the request within its existing budget and preserve the quote needed to validate the selected tag.

---

## Task 1: Split descriptor research into seven independent categories

**Files:**
- Modify: `worker/src/research/providers.ts`
- Test: `worker/tests/research-tagging.test.ts`

**Target interfaces:**
- `descriptorSearchGroups`
- `DescriptorSearchGroup`
- `hasDescriptorEvidence(...)`
- `missingDescriptorCategories(...)`
- Existing generic coverage flow in `worker/src/research/runner.ts` should continue working without special cases.

- [ ] Add failing tests named approximately:
  - `tracks mood energy and tempo descriptor coverage independently`
  - `tracks voice structure and voice impression independently`
  - `does not open descriptor categories from unrelated recording evidence`

Use evidence examples that isolate each category. In particular, one tempo sentence must mark only `tempo`, not `mood`/`energy`; one voice-quality sentence must mark `voice_impression` independently of a structure-only credit.

- [ ] Run the targeted RED tests:

```bash
npx vitest run worker/tests/research-tagging.test.ts -t "descriptor coverage independently|unrelated recording evidence"
```

Expected RED: current `mood_energy_tempo` / `voice` grouping cannot represent the independent group IDs and coverage expectations.

- [ ] Replace the four-group definition with seven groups, each carrying an explicit `category` corresponding to the stored Japanese tag category:
  - `genre_sound` -> `ジャンル`
  - `mood` -> `雰囲気`
  - `energy` -> `勢い`
  - `tempo` -> `テンポ感`
  - `voice_structure` -> `歌声の構成`
  - `voice_impression` -> `歌声の印象`
  - `lyric_theme` -> `歌詞テーマ`

Give each group its own search phrase and **broad category cue** regex. Examples of permitted cue families:
- mood: mood/tone/atmosphere, 明るい/暗い/穏やか/切ない/quirky/cheerful, etc.
- energy: energy/rhythm/beat/groove/driving/jaunty/rapid/軽快/力強い/疾走感, etc.
- tempo: tempo/BPM/pace/speed/fast/slow/quick/rapid/アップテンポ/ゆったり, including hyphenated `extremely-fast`.
- voice structure: vocal/singer/voice/human/synthetic/duet/chorus/choir/instrumental and Japanese equivalents.
- voice impression: require voice/vocal/singing context plus timbre/quality vocabulary rather than accepting a bare adjective globally.

Do not encode `quirky -> コミカル`, `jaunty -> 軽快`, or similar tag-specific mappings in these cues.

- [ ] Rerun the targeted tests and the existing descriptor tests:

```bash
npx vitest run worker/tests/research-tagging.test.ts -t "descriptor|missing"
```

Expected GREEN.

- [ ] Commit:

```bash
git add worker/src/research/providers.ts worker/tests/research-tagging.test.ts
git commit -m "refactor: split descriptor research categories"
```

---

## Task 2: Generate candidates by supported category and keep the schema enum bounded

**Files:**
- Modify: `worker/src/research/providers.ts`
- Test: `worker/tests/research-tagging.test.ts`

**Target interfaces:**
- `inferenceTagCandidates(...)`
- `fitInferenceRequest(...)`
- Add small internal helpers such as `descriptorGroupForCategory(...)` / `supportedDescriptorCategories(...)` if that keeps the rules explicit and testable.

- [ ] Add failing tests named approximately:
  - `expands candidates to every active tag in an evidence-supported category`
  - `does not include tags from categories without evidence`
  - `keeps the response tag enum limited to evidence-supported categories`
  - `fits expanded category candidates without dropping the supporting Scatman quote`

Construct a narrow tempo fixture containing `extremely-fast` with multiple active `テンポ感` definitions and unrelated mood definitions. Assert that all tempo IDs become candidates, mood IDs do not, and the response schema enum exactly mirrors candidate IDs.

Also replace the old expectation in the existing test named like `finds only explicit synthpop and synthpop dance song tags in genre evidence`; under the approved design, genre evidence should expose all supplied active genre definitions rather than only the two definitions whose seed regex matches. Keep the fixture narrow enough that energy/tempo cues do not accidentally broaden the assertion.

- [ ] Run targeted RED tests:

```bash
npx vitest run worker/tests/research-tagging.test.ts -t "expands candidates|categories without evidence|response tag enum|expanded category candidates|synthpop"
```

Expected RED: current `inferenceTagCandidates()` still requires a per-tag seed regex/literal match.

- [ ] Implement category-level candidate generation:
  1. Filter descriptive evidence through the existing `linkedDescriptionRecording(...)` boundary when a recording URL is supplied.
  2. Build the set of descriptor categories whose group cues occur in `descriptiveLines(...)` from usable evidence.
  3. Include every supplied active tag whose `category` is in that supported set.
  4. Preserve the existing explicit-vocalist special handling for `tag-33` where appropriate.
  5. For custom/unknown categories with no known descriptor group, keep the current literal name/criterion fallback instead of silently broadening them.
  6. Do **not** use `trustedSeedProfile(tag)` as an exclusion gate here.

- [ ] Keep `fitInferenceRequest()` schema safety:
  - `input.tags` becomes the category-expanded candidate list.
  - `tag_id.enum` is exactly `input.tags.map(tag => tag.id)`.
  - With no candidates, tag `maxItems` remains `0`.
  - Compact candidates to the existing needed fields (`id`, `name`, `category`, concise `criterion`) before pruning useful evidence.
  - Keep the current request budget (`requestTokenEstimate` / 7600 behavior) and 12-tag response cap.

Do not change `max_completion_tokens` in `runner.ts` in this task.

- [ ] Rerun targeted tests:

```bash
npx vitest run worker/tests/research-tagging.test.ts -t "expands candidates|categories without evidence|response tag enum|expanded category candidates|synthpop"
```

Expected GREEN, including exact retention of the Scatman support sentence used by validation.

- [ ] Commit:

```bash
git add worker/src/research/providers.ts worker/tests/research-tagging.test.ts
git commit -m "feat: generate tag candidates by descriptor category"
```

---

## Task 3: Allow evidence-backed semantic entailment without losing deterministic guards

**Files:**
- Modify: `worker/src/research/providers.ts`
- Modify: `worker/src/research/runner.ts`
- Test: `worker/tests/research-tagging.test.ts`

**Target interfaces:**
- `tagSemanticDecision(...)`
- Existing helpers: `trustedSeedProfile(...)`, `criterionTerms(...)`, `tagEvidenceNegated(...)`, `hasSongPropertyContext(...)`, `quoteParagraphContext(...)`
- `inferenceSystemPrompt`

- [ ] Add failing tests named approximately:
  - `accepts extremely-fast as semantic evidence for 速い`
  - `accepts jaunty rhythmic evidence for 軽快 without a seed-regex match`
  - `marks explicit seed-profile wording as direct evidence`
  - `rejects hedged or category-unanchored semantic reasoning`
  - `rejects negated speed evidence`
  - `does not infer mood from lyric-theme evidence`
  - `does not infer voice impression from a bare vocalist credit`

Use `supportedAnalysis(...)` for end-to-end post-model validation where possible so the tests exercise exact quote lookup, recording/source linkage, warnings, and `tag_decisions`, not only a private helper.

For the `extremely-fast` acceptance test, the reasoning must explicitly connect the quote to the selected tag/criterion, e.g. it must mention `速い` or a meaningful criterion phrase. The old `tag-32` seed profile must still **not** match the quote; this proves the semantic path rather than merely adding a synonym to `seedTagSignals`.

- [ ] Run targeted RED tests:

```bash
npx vitest run worker/tests/research-tagging.test.ts -t "extremely-fast|jaunty rhythmic|seed-profile wording|hedged|negated speed|lyric-theme evidence|bare vocalist credit"
```

Expected RED: valid semantic cases are currently rejected by `profile.test(contextText)`, while the negative cases define the safety boundary for the replacement logic.

- [ ] Refactor `tagSemanticDecision(...)` into two explicit acceptance paths:

**Direct path**
- Accept factual human-voice proof already supported by the existing explicit vocalist rule.
- Accept exact tag-name / meaningful criterion matches and trusted seed-profile matches, subject to existing negation, category, song-property, and voice-context guards.
- Return `evidence_type: "direct"` only for this path.

**Semantic path**
- Resolve the descriptor group from `tag.category` rather than hard-coded array indexes.
- Require the retained quote/paragraph context to match that category's broad cues.
- Require substantive reasoning and an explicit reasoning anchor to the selected `tag.name` or a meaningful term from `criterionTerms(tag.criterion)`.
- Reject hedged reasoning (`maybe`, `likely`, `suggests`, Japanese equivalents already used by the validator).
- Reject a negated property using `tagEvidenceNegated(...)` with a signal that actually matches the context.
- For `雰囲気` and `勢い`, require `hasSongPropertyContext(...)`; lyric prose alone must fail.
- For `歌声の印象`, require a vocal/voice/singing noun in context.
- For `歌詞テーマ`, require lyric-description context.
- Return `evidence_type: "semantic_inference"` only after all gates pass.

The absence of a `seedTagSignals` match must not reject this semantic path.

- [ ] Update `inferenceSystemPrompt` so model output is compatible with deterministic validation. Add a concise instruction that semantic reasoning must explicitly name the selected tag (or quote the meaningful criterion phrase) and explain why the exact quote entails it; merely repeating the quote is insufficient.

Do not relax the existing prompt rules against listening guesses, lyric-to-mood inference, title-only evidence, unrelated songs, or unsupported human/synthetic classification.

- [ ] Rerun targeted tests, then the entire tagging test file:

```bash
npx vitest run worker/tests/research-tagging.test.ts -t "extremely-fast|jaunty rhythmic|seed-profile wording|hedged|negated speed|lyric-theme evidence|bare vocalist credit"
npx vitest run worker/tests/research-tagging.test.ts
```

Expected GREEN.

- [ ] Commit:

```bash
git add worker/src/research/providers.ts worker/src/research/runner.ts worker/tests/research-tagging.test.ts
git commit -m "feat: validate semantic tag entailment by category"
```

---

## Task 4: Lock the Scatman regression and run full verification

**Files:**
- Modify if needed: `worker/tests/research-tagging.test.ts`
- Production fixes only if a failing regression exposes a defect in the already-scoped files.

- [ ] Add/update a combined Scatman regression using the existing exact-song fixture containing:
  - `novelty synthpop dance song`
  - `quirky`
  - `jaunty`
  - `techno groove`
  - `rapid`
  - `extremely-fast`

Assert the behavior at the correct abstraction levels rather than hard-coding all human judgments:
- the exact-song association still isolates Scatman from artist biography / other-song prose;
- genre, mood, energy, and tempo categories become available when the supplied tag set contains those categories;
- the fitted schema enum contains those category candidates but no categories absent from evidence;
- `extremely-fast` can result in accepted `速い` semantic inference with adequate reasoning;
- `techno groove` can continue to support existing danceability behavior;
- unsupported voice-quality or lyric-theme tags are not fabricated merely because a human might know the song.

This test must preserve the existing unrelated-song and alternate-recording isolation assertions.

- [ ] Run the Scatman-focused tests:

```bash
npx vitest run worker/tests/research-tagging.test.ts -t "Scatman|scatman|danceability|extremely-fast"
```

If any failure reflects an unintended false positive/negative, add a smaller regression test first, confirm RED, then make the narrowest scoped fix.

- [ ] Run all tests:

```bash
npm test
```

Expected: all Vitest suites pass.

- [ ] Run type checking:

```bash
npm run typecheck
```

Expected: zero TypeScript errors.

- [ ] Run the full build, which covers both Worker dry-run and web build according to `package.json`:

```bash
npm run build
```

Expected: `build:api` and `build:web` both succeed. A separate `npm run build:web` is unnecessary if this command passes, because `build` invokes it.

- [ ] Review the final diff against the approved spec. Confirm explicitly:
  - no tag dictionary migration changed;
  - no manual/admin locking behavior changed;
  - no recording association rule changed;
  - no public contract changed;
  - schema enum and 12-tag cap remain;
  - category cues are not acting as direct tag mappings;
  - all new positive semantic cases still require exact evidence and reasoning.

- [ ] Commit final regression-only changes, if any:

```bash
git add worker/tests/research-tagging.test.ts
git commit -m "test: cover Scatman semantic tag recall"
```

If Task 4 requires no file changes after verification, do not create an empty commit.

## Completion Criteria

The implementation is complete only when all of the following are true:

- `descriptorSearchGroups` exposes seven independent categories and coverage no longer conflates mood/energy/tempo or voice structure/impression.
- `inferenceTagCandidates()` uses recording-scoped category evidence instead of per-tag regex exclusion for known categories.
- `fitInferenceRequest()` keeps the schema enum restricted to evidence-supported candidate IDs and remains within the existing request budget.
- `tagSemanticDecision()` can accept a well-reasoned `extremely-fast` -> `速い` semantic inference without adding `extremely-fast` to the old tag-32 seed regex.
- Direct lexical evidence is still distinguished from semantic inference.
- Existing provenance, quote, lyric/mood, voice-quality, unrelated-song, and alternate-recording protections remain green.
- `npm test`, `npm run typecheck`, and `npm run build` all pass.
