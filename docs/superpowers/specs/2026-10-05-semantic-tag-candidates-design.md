# Semantic tag candidate pipeline design

Date: 2026-10-05
Branch: `feat/semantic-tag-candidates`
Base: `main` at `1ab894f3798dc6c0ed205b4c7b39f0beb0321b89`

## Goal

Improve automatic song tagging recall without relaxing the evidence requirements that prevent unsupported tags. The current pipeline uses per-tag regular expressions as hard gates both before inference and during semantic validation. That makes semantically valid tags impossible when the evidence uses wording outside `seedTagSignals`, as seen with Scatman where `extremely-fast`, `jaunty`, and `quirky` do not reach the corresponding tags.

Success means that category-relevant evidence is allowed to reach the model, while final publication still requires an exact retained quote, category-appropriate reasoning, recording-scoped provenance, negation checks, and the existing safety boundaries between musical sound, vocals, and lyrics.

## Scope

This change is limited to automatic tag enrichment and descriptor research in `worker/src/research/providers.ts`, `worker/src/research/runner.ts`, and the associated worker tests. It does not change the tag dictionary, manual overrides, administrator locks, recording identity rules, credit validation, source-association rules, the 12-tag cap, or the public UI contract.

## Architecture

### 1. Category-level candidate generation

`inferenceTagCandidates()` will stop using `seedTagSignals` as a per-tag inclusion gate for unchanged seed tags. Instead it will determine which tag categories have usable recording-scoped descriptor evidence, then include all active tags in those supported categories.

The existing per-tag profiles remain available for direct lexical evidence and deterministic validation. They are no longer allowed to exclude a tag before the model can perform a semantic comparison against the tag criterion.

For example, if evidence contains tempo language such as `extremely-fast`, the tempo category is considered supported and all active `テンポ感` tags are sent to inference. The model may then choose `速い`, but it still has to return the exact quote and an explanation that connects the quote to the criterion.

Categories without usable evidence are still excluded. This preserves the token-saving purpose of candidate narrowing without turning a synonym list into a semantic hard gate.

### 2. Seven independent descriptor search groups

The current descriptor grouping will be split so that research coverage corresponds to the seven user-visible tag categories:

- `genre_sound` -> `ジャンル`
- `mood` -> `雰囲気`
- `energy` -> `勢い`
- `tempo` -> `テンポ感`
- `voice_structure` -> `歌声の構成`
- `voice_impression` -> `歌声の印象`
- `lyric_theme` -> `歌詞テーマ`

Each group will have its own search query and broad category cues. A group becomes complete only after its own search/extract stage runs or is marked unavailable. Finding tempo evidence will therefore no longer mark mood or energy research as complete.

The cue expressions are category detectors, not tag classifiers. They should recognize broad vocabulary such as tempo/BPM/speed language, vocal/voice descriptions, mood adjectives, groove/beat/energy descriptions, and lyric-theme prose without deciding a specific tag.

### 3. Semantic decision validation

`tagSemanticDecision()` will distinguish direct evidence from semantic inference.

Direct evidence continues to use exact tag names, criterion terms, and the trusted seed profile where appropriate.

Semantic inference will be accepted when all of the following hold:

1. The retained quote and its paragraph context contain cues for the tag's category.
2. The reasoning is substantive and explicitly explains why the quote entails the tag criterion.
3. The reasoning is not hedged as a guess.
4. The quote is not negated with respect to the proposed property.
5. Mood and energy claims describe a song/music property rather than scenery, audience, weather, or unrelated prose.
6. Voice-impression claims contain a voice/vocal/singing noun in context.
7. Lyric-theme claims come from lyric-description context rather than isolated lyric words.
8. Existing recording linkage, quote-presence, credit-boundary, and source validation continues to pass.

For unchanged seed tags, `seedTagSignals` may establish a direct lexical match, but absence of a profile match will no longer reject otherwise valid semantic inference.

### 4. Response-schema restriction remains

`fitInferenceRequest()` will continue restricting `tag_id` to an enum. The enum will now contain all tags from evidence-supported categories rather than only tags that matched a per-tag regex.

This retains the protection against arbitrary or unknown tag IDs while allowing semantic selection inside a supported category.

The existing maximum of 12 tags per recording remains unchanged.

### 5. Request-size control

Category-level candidate expansion can increase prompt size. The fitter will keep the existing request budget and reduce avoidable tag-definition overhead before discarding useful evidence.

The compact representation keeps `id`, `name`, `category`, and a concise criterion. Existing generic criteria remain shortened. No evidence quote needed for validation should be removed merely to keep a narrow per-tag candidate list.

If the request still exceeds the existing budget, the current evidence-window and source-pruning behavior remains the fallback.

## Data flow

The resulting enrichment flow is:

1. Search and extract recording/source evidence.
2. Verify source-to-recording association using the existing recording-scoped rules.
3. Determine which of the seven descriptor categories have evidence.
4. Search missing categories independently until complete or unavailable.
5. Build inference candidates from all active tags in supported categories.
6. Restrict the model response schema to those candidate IDs.
7. Ask the model for exact quotes and reasoning.
8. Validate each returned tag independently with `tagSemanticDecision()` and existing quote/provenance checks.
9. Publish only accepted tags; unsupported optional tag claims become review warnings rather than corrupting recording identity.

## Error handling and false-positive controls

The change must not convert missing evidence into inferred tags. If a category has no descriptor evidence, its tags are not sent to the model. If the model returns a tag whose quote does not exist in the retained evidence, whose category does not match the quote context, or whose reasoning is insufficient, the tag is rejected.

Existing rules remain in force for:

- unrelated songs and alternate recordings;
- title-only evidence;
- credit lines being misused as genre, mood, tempo, or voice-quality evidence;
- lyrics being misused to infer musical mood;
- instruments alone being treated as jazz/classical proof;
- manual/admin exclusions and locks;
- exact source and recording linkage.

Descriptor-search failures continue to produce `DESCRIPTIVE_LOOKUP_UNAVAILABLE`. If no supported tag description is found after category research, the existing `NO_SUPPORTED_TAG_DESCRIPTIONS` review path remains.

## Scatman acceptance case

The regression fixture for `Scatman (Ski-Ba-Bop-Ba-Dop-Bop)` contains wording including `novelty synthpop dance song`, `quirky`, `jaunty`, `techno groove`, `rapid`, and `extremely-fast`.

The required behavioral change is not to hard-code those words to specific tags. Instead:

- genre evidence should expose genre tags;
- `quirky`/similar mood wording should allow the mood category to reach semantic inference;
- `jaunty`/rhythmic wording should allow the energy category;
- `extremely-fast` must allow the tempo category;
- `techno groove` can continue supporting danceability;
- any final `明るい`, `コミカル`, `軽快`, `疾走感`, or `速い` assignment must still be justified by the model with a retained quote and pass semantic validation.

The test must specifically prove that `extremely-fast` can support `速い` through semantic inference even though it does not match the old `fast tempo|up-tempo|high-tempo` profile.

## Testing strategy

Tests will be written before implementation changes.

Required regression coverage:

1. Candidate generation includes all active tags in a category when category-level evidence is present, even when only one or zero per-tag seed regexes match.
2. `extremely-fast` can be accepted as semantic evidence for `速い` with adequate reasoning.
3. A semantically explained `jaunty` energy description is not rejected solely because it misses `seedTagSignals`.
4. Direct matches continue to report direct evidence where appropriate.
5. Mood, energy, and tempo descriptor coverage are independent.
6. Voice structure and voice impression coverage are independent.
7. Lyrics cannot establish non-lyric mood/energy tags.
8. Unrelated-song and alternate-version evidence remains excluded.
9. A category with no evidence contributes no tag candidates.
10. The response schema enum contains only candidates from supported categories.
11. Existing Scatman unrelated-song isolation tests continue to pass.
12. Existing full worker test suite remains green.

Verification after implementation:

- `npm test`
- `npm run typecheck`
- `npm run build:web`
- `npm run build` if required by the repository's current verification script or if `build:web` does not cover the worker build

## Non-goals

This change does not attempt to make the model tag songs by listening to audio, scrape copyrighted lyrics, infer tags from artist reputation, or guarantee that every reasonable human tag is found. It improves recall only where textual web evidence exists and remains attributable to the selected recording.
