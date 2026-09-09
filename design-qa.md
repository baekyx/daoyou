# Design QA — 三端“我的”页头像区与账号信息

## Source visual truth

- Annotated guide profile screenshot: `/var/folders/hk/8gfg9nld07v1rpdg_g_8g6lm0000gn/T/codex-clipboard-dd1e12c0-eefb-49ba-ac29-9e80d8e35a20.png`
- User direction: remove the green panel behind the avatar and synchronize the treatment across guide, tourist, and photographer; improve the highlighted “账号信息” layout.

## Implementation evidence

- Guide: `.qa/guide-my-transparent-final-390x844.jpg`
- Tourist: `.qa/tourist-my-transparent-390x844.jpg`
- Photographer: `.qa/photographer-my-transparent-390x844.jpg`
- Guide QA URL: `http://127.0.0.1:4174/.qa/tourist-ui-harness/index.html?screen=guide-my&width=390&height=844`
- Tourist QA URL: `http://127.0.0.1:4174/.qa/tourist-ui-harness/index.html?screen=tourist-my&width=390&height=844`
- Photographer QA URL: `http://127.0.0.1:4174/.qa/tourist-ui-harness/index.html?screen=photographer-my&width=390&height=844`

## Viewport and normalization

- Source pixels: 644 × 1616, an approximately 322 × 808 mobile capture at 2× density.
- Implementation captures: 390 × 844 at 1× density; responsive DOM checks were also run at 320 × 844.
- App-owned mobile shells were cropped from the 1600 × 900 QA canvas using their measured page coordinates; desktop canvas was excluded.

## State

- Signed-in profile pages for guide, tourist, and photographer.
- Avatar, profile name, role badge, account information, first settings groups, and persistent bottom navigation visible.

## Full-view comparison evidence

- Fonts and typography: all three roles use the same 13 px external section label, 14 px field label, and 15 px semibold value hierarchy. The account title no longer competes with the first field row.
- Spacing and layout rhythm: “账号信息” is consistently outside the card with an 8 px title-to-card gap. Avatar areas use a transparent background and compact shared rhythm; guide avatar size was normalized to 74 px to match tourist and photographer.
- Colors and tokens: the large pale-green hero plate and decorative circles are removed. The cream page background, white cards, existing green role badge, and semantic menu icon colors remain unchanged.
- Image quality: existing avatar assets and circular crop are preserved; only surrounding presentation changed.
- Copy and content: profile name, phone mask, gender, role, group titles, and menu copy are unchanged.

## Focused comparison evidence

- Annotated hero region: computed `background-image` is `none` and background is transparent for guide, tourist, and photographer.
- Annotated account heading: heading is now a standalone semantic section label; card contains only the four account fields.
- 320 px measurements: each page reported no horizontal overflow; title-to-card gap remained 8 px; bottom navigation ended exactly at the 844 px shell boundary.

## Interaction and technical verification

- Existing edit-profile, avatar upload, settings menu, sign-out, account deletion, and bottom navigation handlers were not modified.
- 390 px and 320 px responsive checks passed for all three roles.
- Browser console errors: 0.
- `npm run build`: passed.

## Findings

- No actionable P0/P1/P2 findings remain for the requested scope.
- P3: very long nicknames may require a later truncation rule; current QA names fit without wrapping.

## Comparison history

- Initial P2: three roles used different pale-green hero backgrounds, and guide used a larger 88 px avatar. Fixed with one transparent hero treatment and a consistent 74 px avatar scale.
- Initial P2: guide/photographer placed “账号信息” inside the card while tourist placed it outside. Fixed by moving the shared guide/photographer title outside and normalizing label, gap, card padding, and row height across all roles.
- Post-fix evidence: source and final guide screenshot were opened together; tourist and photographer captures confirm the synchronized result.

## Final result

final result: passed
